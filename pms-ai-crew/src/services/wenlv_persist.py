"""文旅内容落库客户端：把 AI 结构化产出写入 pms-server /api/admin/wenlv/*。

跨服务边界（spec §3）：L2 pms-ai-crew 只做创作，不碰数据库，内容与设计资产的唯一属主
是 L3 pms-server。故本模块经 HTTP（内部 token X-Internal-Service-Token）调用 pms-server
admin 端点落库。落库用预生成的语义 id（幂等，重试安全），condition 引用直通。

WenlvCondition 映射：语义化引用（unlock_collected/unlock_completed/grant/complete）
→ pms-server 的声明式结构（ref/all/any/nofM）。本模块只产出 all(and) 组合，够用 90% 剧本。

T11 起本模块同时承载**读回**方向（`invert_wenlv_condition` + 两个 build_*_from_product_full）：
分步精修的基线改成「库里的当前内容」（GET /products/:id/full），而该端点下发的是**扁平 camelCase**
的库行、精修 agent 要的是**嵌套 snake_case** 的 AI 产出形状 ⇒ 必须有反向映射。
写回方向（create_* 的写入键）与前端 refine-mapping.ts 的五个 mapX 是同一张对照表，
**两个方向 + 前端三方必须同时改**，否则精修一轮就把对不上的字段静默清空（applyLevel 是删光重建）。
"""
import logging
from datetime import datetime, timezone

import httpx
from typing import Optional

from src.config import PMS_SERVER_URL, INTERNAL_SERVICE_TOKEN

logger = logging.getLogger(__name__)

_NOT_GIVEN = object()  # 区分「调用方没给已解析值」与「已解析值就是 None」


def resolve_venue_point_id(node: dict, points: Optional[list] = None) -> Optional[str]:
    """把 AI 产出的点位绑定解析成一个**确定属于本场地**的 venue_point_id，或 None。

    三级（前一级不成立才走下一级）：
      1. AI 直接给的 `venue_point_id`，且确实在本场地点位集里 → 用它（权威键优先）
      2. 否则用 `location` 与本场地点位名做**精确相等**匹配 → 回填
         （AI 常常名字给对、id 漏给；精确匹配召回率不高，但**绝不会绑错**）
      3. 都不成立 → None

    **为什么必须校验一级**：AI 会串号或编造 id。一个不属于本场地的 venuePointId 落进库里，
    会让 `/trigger` 返回「点位不存在或已删除」403 —— 节点**永远点不开**，比不绑更糟。
    实测（2026-09-20）：出稿节点未绑点位是当前生产的主要形态（出处：
    `docs/superpowers/specs/2026-09-20-wenlv-creation-flow-convergence-design.md`
    （外层仓库 `D:/wwwroot/wwwpms/`）§1.1 生产实证表 ——
    published 的「龙里龙门镇武侠夜游」17 个节点里 **16 未绑 + 1 已绑 = 16/17**），
    故本函数是「补上绑定」的唯一入口，也是「不引入新坏绑定」的唯一闸。

    **不做模糊匹配**：`location` 是 AI 自由文本（可能带修饰、可能虚构），模糊匹配会把
    「古井旁边的石碑」错绑到「古井」。宁可不绑（人工在创作台补），不可绑错。

    本函数**不抛** —— 出稿不该因为一个编造的 id 而整体失败。
    未绑点位是**合法状态**（schema 注释：venuePointId 为空 = 无需到场，用于开场/结局类节点）。
    """
    if not isinstance(node, dict):
        return None
    valid = {p.get("id") for p in (points or []) if isinstance(p, dict) and p.get("id")}
    if not valid:
        return None
    vpid = node.get("venue_point_id")
    if isinstance(vpid, str) and vpid and vpid in valid:
        return vpid
    if vpid:
        logger.warning("AI 给的点位 id 不属于本场地，已丢弃该 id（改由 location 文本精确匹配决定绑定；"
                       "匹配不上即为未绑）："
                       "node=%s venue_point_id=%r", node.get("id"), vpid)
    loc = node.get("location")
    if isinstance(loc, str) and loc.strip():
        for p in (points or []):
            if isinstance(p, dict) and p.get("name") == loc.strip():
                pid = p.get("id")          # 与上面 valid 的过滤口径一致：无 id 就不算命中
                if pid:
                    return pid
    return None


def build_wenlv_condition(collected: list[str], completed: list[str]) -> Optional[dict]:
    """把语义引用列表折叠成 WenlvCondition 的 all(and) 结构；空 → None（无条件）。"""
    conds = [{"type": "ref", "ref": {"kind": "collected", "id": c}} for c in collected]
    conds += [{"type": "ref", "ref": {"kind": "completed", "id": n}} for n in completed]
    if not conds:
        return None
    return {"type": "all", "conditions": conds}


def invert_wenlv_condition(cond) -> Optional[tuple[list[str], list[str]]]:
    """build_wenlv_condition 的逆变换：all(refs) → (unlock_collected, unlock_completed)。

    **返回 None = 本函数认不出这个形状**，调用方（run_refine）应回落 state，**不要抛**。
    生产库里真实存在、但 build_wenlv_condition 产不出来的形状，用户用编辑器就能造出来
    （ConditionBuilder 挂在 unlock_condition 列，见 pms-wenlv-web 的 wenlv-editor/node-form.tsx）：
      · {type:'any',  conditions:[…]}  编辑器「任一满足 OR」；
      · {type:'nofM', n, of:[…]}       编辑器「至少 N 个满足」——子项键是 of，不是 conditions；
      · 裸 {type:'ref', …}             没有 all 包裹（编辑器 norm() 显式接受该形状）；
      · ref.kind='visited'             WenlvCondRef 的第三种 kind（界面上可选）。
    抛异常会让 run_refine 在「用户自己配过这些逻辑」的节点上直接 500 ——
    那是相对「只读 state」的旧行为的**功能倒退**（旧代码压根不碰这些形状）；
    回落则与旧行为逐字一致。同理，**嵌套子条件 / 未知 kind 也不许静默丢掉**：丢一条解锁条件
    = 该条件不进 prompt、AI 精修后 applyLevel 把它清空，故一并返回 None。

    None 输入 → ([], [])（build 对「无条件」的表示）。
    顺序与输入一致（collected 在前、completed 在后），往返自证依赖这一点。
    """
    if cond is None:
        return ([], [])
    if not isinstance(cond, dict) or cond.get("type") != "all":
        return None
    conditions = cond.get("conditions")
    if not isinstance(conditions, list):
        return None
    collected: list[str] = []
    completed: list[str] = []
    for child in conditions:
        if not isinstance(child, dict) or child.get("type") != "ref":
            return None
        ref = child.get("ref")
        if not isinstance(ref, dict):
            return None
        rid = ref.get("id")
        if not isinstance(rid, str) or not rid:
            return None
        kind = ref.get("kind")
        if kind == "collected":
            collected.append(rid)
        elif kind == "completed":
            completed.append(rid)
        else:
            return None   # 'visited' 或未知 kind
    return (collected, completed)


def _effects_lists(node: dict) -> tuple[list, list]:
    """节点的 effects → (grant, complete)；列是 notNull default，缺失/形状怪时按空处理。"""
    effects = node.get("effects")
    if not isinstance(effects, dict):
        return ([], [])
    grant = effects.get("grant")
    complete = effects.get("complete")
    return (list(grant) if isinstance(grant, list) else [],
            list(complete) if isinstance(complete, list) else [])


def build_level_from_product_full(data: dict) -> Optional[dict]:
    """GET /products/:id/full 的 data（扁平 camelCase 库行）→ AI 产出的 level（嵌套 snake_case）。

    **返回 None = 该 stage 在库里无内容 / 形状认不出**，调用方回落 state。
    认不出就**整份**回落、不许只丢那一条：基线是喂给精修 agent 的「已有草稿」，
    少一条解锁条件 = agent 精修后 applyLevel「删光重建」时把它清空。

    字段对照表 = 本模块 create_node / create_collectible / create_ending / create_tier /
    create_reward 的**写入键**（它们与前端 refine-mapping.ts 的五个 mapX 逐字段对齐）。

    ⚠️ location 只取**原始文本列** `location`，**绝不取** `displayLocation`：
    后者是引擎按「绑了点位就显示点位名」派生的**只读展示投影**（admin/wenlv.ts:873-875）。
    拿它当基线 ⇒ 点位名被灌进文本列，节点日后解绑点位、展示回退到文本列时就印错地名
    （2026-09-19 的真实回归，见该端点 :861-870 的注释）。
    """
    if not isinstance(data, dict):
        return None

    nodes_out: list[dict] = []
    for n in data.get("nodes") or []:
        if not isinstance(n, dict):
            return None
        cond = n.get("unlockCondition")
        inv = invert_wenlv_condition(cond)
        if inv is None:
            logger.info("level 基线建不出：节点 %s 的 unlockCondition 形状非 build_wenlv_condition "
                        "产出（type=%s），整份回落 state", n.get("id"),
                        cond.get("type") if isinstance(cond, dict) else type(cond).__name__)
            return None
        collected, completed = inv
        grant, complete = _effects_lists(n)
        nodes_out.append({
            "id": n.get("id"),
            "node_type": n.get("nodeType") or "scene",
            "title": n.get("title"),
            "story_text": n.get("storyText") or "",
            "trigger_type": n.get("triggerType") or "manual",
            "trigger_credential": n.get("triggerCredential") or "",
            "location": n.get("location") or "",          # 原始列，不是 displayLocation
            "unlock_collected": collected,
            "unlock_completed": completed,
            "grant_collectibles": grant,
            "complete_nodes": complete,
            "interactions": list(n.get("interactions") or []),
        })

    collectibles_out = [{
        "id": c.get("id"), "name": c.get("name"),
        "type": c.get("type") or "clue", "rarity": c.get("rarity") or "common",
        "description": c.get("description") or "",
    } for c in (data.get("collectibles") or [])]

    endings_out: list[dict] = []
    for e in data.get("endings") or []:
        if not isinstance(e, dict):
            return None
        inv = invert_wenlv_condition(e.get("triggerCondition"))
        if inv is None:
            logger.info("level 基线建不出：结局 %s 的 triggerCondition 形状认不出，整份回落 state", e.get("id"))
            return None
        collected, completed = inv
        if completed:
            # 结局的 AI 形状只有 collected_ids（create_ending 也恒传 completed=[]），
            # completed 引用**无处安放** —— 丢弃它 = 静默丢条件，故整份回落。
            logger.info("level 基线建不出：结局 %s 的 triggerCondition 含 completed 引用，"
                        "AI 形状（collected_ids）表达不了，整份回落 state", e.get("id"))
            return None
        endings_out.append({
            "id": e.get("id"), "title": e.get("title"), "text": e.get("text") or "",
            "collected_ids": collected,
            "reward_id": e.get("rewardId") or "",
            "priority": int(e.get("priority") or 0),
        })

    tiers_out: list[dict] = []
    for t in data.get("tiers") or []:
        if not isinstance(t, dict):
            return None
        inv = invert_wenlv_condition(t.get("condition"))
        if inv is None:
            logger.info("level 基线建不出：档位 %s 的 condition 形状认不出，整份回落 state", t.get("id"))
            return None
        collected, completed = inv
        if completed:
            logger.info("level 基线建不出：档位 %s 的 condition 含 completed 引用，"
                        "AI 形状（collected_ids）表达不了，整份回落 state", t.get("id"))
            return None
        tiers_out.append({
            "id": t.get("id"), "name": t.get("name"), "description": t.get("description") or "",
            "collected_ids": collected, "reward_id": t.get("rewardId") or "",
        })

    rewards_out = [{
        "id": r.get("id"), "name": r.get("name"),
        "type": r.get("type") or "coupon", "value": r.get("value") or "",
    } for r in (data.get("rewards") or [])]

    # 五张表全空 = 库里该 stage 无内容（产品可能存在，但 level 还没落过/已被清空）⇒ 回落 state。
    # 不能返回 {nodes:[],…} 让它「非空」地穿过 run_refine 的 `if not base` 守卫：那会把
    # 「库里没内容」伪装成「有基线」，让 agent 从零生成。
    if not (nodes_out or collectibles_out or endings_out or tiers_out or rewards_out):
        return None
    # 与 AI 产出同形的键序（LevelDesign：nodes/collectibles/endings/tiers/rewards）。
    # 不填 schema_version：它是 AI 产出侧的版本号，回填会谎称「这份是 AI 生成的 w3.0」。
    return {"nodes": nodes_out, "collectibles": collectibles_out, "endings": endings_out,
            "tiers": tiers_out, "rewards": rewards_out}


def build_npcs_from_product_full(data: dict) -> Optional[dict]:
    """GET /products/:id/full 的 data（含 npcs camelCase 库行）→ AI 产出的 npcs（snake_case）。

    与 build_level_from_product_full 同款：返回 None = 库里该 stage 无内容，调用方回落 state。
    认不出就**整份**回落、不许只丢那一条：基线是喂给精修 agent 的「已有草稿」，
    少一个 NPC = agent 精修后可能不再产出它，而前端重建时把它丢弃。

    字段对照表 = AI 产出侧（WenlvNpc/WenlvNpcLine）的键。剥离 AI 不产的字段：
      · voiceUrl/duration（lines 内，S3 TTS 后填，LLM 只产 text）
      · orderId/portraitUrl/createdAt/updatedAt（AI 不需要，portrait 由 S2 文生图后回写）

    ⚠️ 与 build_characters_from_product_full 同款：空 npcs 仍返回 dict（带 story 上下文）。
    理由：「一键生成 NPC」正是用于 npcs 表为空的场景 —— agent 需要 characters + 剧本上下文
    才能从零设计 NPC。若此处返回 None，refine 的 `if not base` 守卫会拒答，空表永远无法生成。
    （batch_generate 调度器会先删旧 NPC 再插新 NPC，不存在误覆盖人工改动的风险。）

    P1-A（与 build_characters_from_product_full 同款）：基线**附带 characters + 5 个剧本上下文键**
    （world_setting/storyline/chapters/endings/location）。理由同 characters stage：只给「库里
    已有 NPC」的话，LLM 无从知道该为哪个故事设计谁、能绑哪些 character_id —— 容易重名、
    编造不存在的 character_id。characters 可空数组（npcs 非空 = 库里有 NPC 草稿，但剧本可能
    尚未建任何选角卡）；5 个上下文键取自 config 快照（与 build_characters_from_product_full 同源）。
    """
    if not isinstance(data, dict):
        return None

    npcs_out: list[dict] = []
    for n in data.get("npcs") or []:
        if not isinstance(n, dict):
            return None
        lines_out: list[dict] = []
        for l in n.get("lines") or []:
            if not isinstance(l, dict):
                return None
            lines_out.append({
                "id": l.get("id"),
                "text": l.get("text") or "",
            })
        npcs_out.append({
            "id": n.get("id"),
            "name": n.get("name"),
            "role": n.get("role") or "npc",
            "description": n.get("description") or "",
            "portrait_prompt": n.get("portraitPrompt") or "",
            "voice_id": n.get("voiceId") or "",
            "character_id": n.get("characterId"),
            "lines": lines_out,
        })

    # 空 npcs 也继续：返回带 story 上下文的基线，供「一键生成 NPC」从零设计。
    # P1-A：与 build_characters_from_product_full 同款抽取 characters + 5 个上下文键。
    # characters 可空数组（npcs 非空即返回 dict，与 npcs 是否引用 character 无关）。
    config = data.get("config") or {}
    if not isinstance(config, dict):
        config = {}
    rows = data.get("characters")
    if not isinstance(rows, list):
        rows = []
    chars = []
    for c in rows:
        if not isinstance(c, dict) or not c.get("id"):
            continue
        # 与 build_characters_from_product_full 完全同形：avatar_url 与 ip_prompt 必须带
        # （两者都是「人工已产出」的唯一载体，不带进 prompt 会被 AI 当没做过而重来）。
        chars.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "faction": c.get("faction"),
            "faction_color": c.get("factionColor"),
            "identity": c.get("identity"),
            "identity_desc": c.get("identityDesc"),
            "role": c.get("role"),
            "vitality": c.get("vitality"),
            "wisdom": c.get("wisdom"),
            "insight": c.get("insight"),
            "skills": c.get("skills") or [],
            "hidden_quest": c.get("hiddenQuest"),
            "avatar_url": c.get("avatarUrl"), "ip_prompt": c.get("ipPrompt"),
        })
    return {
        "npcs": npcs_out,
        "characters": chars,
        "world_setting": config.get("world_setting") or {},
        "storyline": config.get("storyline") or {},
        "chapters": config.get("chapters") or {},
        "endings": config.get("endings") or {},
        "location": config.get("location") or {},
    }


def build_visual_from_product_full(data: dict) -> Optional[dict]:
    """视觉精修基线：从 product.theme 还原到前端**消费面**要的那两个字段。

    refine-panel.tsx 应用视觉精修时只读 visual.colors.primary 与 visual.template_id，
    其它一律忽略；且要求二者至少一个非空，否则只弹 warning
    （`refine-panel.tsx` 的 `toast.warning('视觉精修未返回可应用字段')`）。
    ⇒ 薄基线与消费面一致，不是敷衍。
    theme 由本模块 create_product（primaryColor）+ 前端精修（templateId）写入。
    """
    theme = data.get("theme") if isinstance(data, dict) else None
    theme = theme if isinstance(theme, dict) else {}
    primary = theme.get("primaryColor")
    template_id = theme.get("templateId")
    if not primary and not template_id:
        return None   # 库里无视觉内容 ⇒ 回落 state
    return {"colors": {"primary": primary}, "template_id": template_id}


def build_characters_from_product_full(data: dict) -> Optional[dict]:
    """从 /products/:id/full 的 data 建 `characters` 精修基线（T12）。

    ⚠️ **与 build_level/visual 的 None 约定刻意不同**：那两个在「库里没内容」时返回 None
    （空基线会让「删光重建」抹掉一切，必须拒答）；本函数**不返回 None**（产品存在即返回 dict）。
    理由：**空表就是存量剧本的期望起始态** —— 用户要的正是「对一个还没有角色的剧本一键生成」。
    若这里返回 None，`_refine_baseline` 会回落 Redis state，而存量剧本的 state 早已过 30 天 TTL
    ⇒ 命中「精修基线缺失」守卫 ⇒ **该功能对存量剧本构造上不可用**（那恰恰是它的主要用途）。

    `None` 只保留一个含义：**产品不存在**（由 get_product_full 的 404 表达），此时上层回落 state。

    基线里带剧本上下文（world_setting/storyline/chapters/endings/location）是必需的：
    只给「表里已有几个角色」的话，LLM 无从知道该为哪个故事设计谁、能绑哪些线索。
    上述 5 键只有 config 一个来源：world_setting / storyline 由 wenlv_creation_crew.py 出稿时写入，
    而 chapters/endings/location 在仓库内**无已知写入者** —— 读它不违反「表是唯一权威」，角色一律以表为准。
    """
    config = data.get("config") or {}
    if not isinstance(config, dict):
        config = {}
    rows = data.get("characters")
    if not isinstance(rows, list):
        rows = []
    chars = []
    for c in rows:
        if not isinstance(c, dict) or not c.get("id"):
            continue
        # 只取设计角色所需的语义字段。`avatar_url` 与 `ip_prompt` **必须带**：两者都是「人工已产出」的
        # 唯一载体（已选定头像 / 文生图 prompt）—— 不带进 prompt 的话 AI 重跑会把它们当没做过而重来。
        chars.append({
            "id": c.get("id"),
            "name": c.get("name"),
            "faction": c.get("faction"),
            "faction_color": c.get("factionColor"),
            "identity": c.get("identity"),
            "identity_desc": c.get("identityDesc"),
            "role": c.get("role"),
            "vitality": c.get("vitality"),
            "wisdom": c.get("wisdom"),
            "insight": c.get("insight"),
            "skills": c.get("skills") or [],
            "hidden_quest": c.get("hiddenQuest"),
            "avatar_url": c.get("avatarUrl"), "ip_prompt": c.get("ipPrompt"),
        })
    return {
        "characters": chars,
        "world_setting": config.get("world_setting") or {},
        "storyline": config.get("storyline") or {},
        "chapters": config.get("chapters") or {},
        "endings": config.get("endings") or {},
        "location": config.get("location") or {},
    }


class WenlvPersister:
    """落库客户端：包装 pms-server admin 端点。"""

    def __init__(self, base_url: str = PMS_SERVER_URL, token: str = INTERNAL_SERVICE_TOKEN):
        self.base_url = base_url
        self.token = token

    def _post(self, path: str, body: dict) -> dict:
        with httpx.Client(
            base_url=self.base_url,
            headers={"X-Internal-Service-Token": self.token, "Content-Type": "application/json"},
            timeout=20.0,
        ) as client:
            resp = client.post(path, json=body)
            resp.raise_for_status()
            return resp.json()

    def _get(self, path: str) -> dict:
        """与 _post 同款头/超时。**非 2xx 一律 raise_for_status 抛**（含 404）——
        区分 404 与网络失败是 get_product_full 的责任，不在这里吞。"""
        with httpx.Client(
            base_url=self.base_url,
            headers={"X-Internal-Service-Token": self.token, "Content-Type": "application/json"},
            timeout=20.0,
        ) as client:
            resp = client.get(path)
            resp.raise_for_status()
            return resp.json()

    def _patch(self, path: str, body: dict) -> dict:
        """与 _post 同款头/超时。单独一个方法是因为 httpx 走的是 `client.patch`。"""
        with httpx.Client(
            base_url=self.base_url,
            headers={"X-Internal-Service-Token": self.token, "Content-Type": "application/json"},
            timeout=20.0,
        ) as client:
            resp = client.patch(path, json=body)
            resp.raise_for_status()
            return resp.json()

    def save_research(self, research_id: str, **fields) -> dict:
        """把调研进度写回 pms-server（**逐节**调用，见 `services/venue_research.run_research`）。

        路径 `PATCH /api/admin/wenlv-research/research/{id}`（挂载点 `src/index.ts` +
        `routes/admin/wenlv-research.ts` 的 `route.patch('/research/:id')`）。端点收的键是
        `status / anchor / candidates / report / progress / search_log / error / finished_at`，
        **每个键整体替换、（除了不传的）不做 jsonb 深合并** —— 所以这里回写的是累积快照。

        ⚠️ `finished_at=True` 是一个**哨兵**：服务端那个键是 `z.coerce.date().nullable()`，
        收的是**字符串**，而 Python 的 `datetime` 对象经 json 序列化会直接 `TypeError`。
        故调用方只传布尔，由本方法换成一个 ISO 串。**不要**改成让调用方传 `datetime` 对象
        —— 400 在这个位置是**静默丢终态**（那行停在 running，用户要等看门狗 15 分钟才能重跑）。
        """
        body = {k: v for k, v in fields.items() if k != "finished_at"}
        if fields.get("finished_at"):
            body["finished_at"] = datetime.now(timezone.utc).isoformat()
        return self._patch(f"/api/admin/wenlv-research/research/{research_id}", body)

    def get_product_full(self, product_id: str) -> Optional[dict]:
        """GET /api/admin/wenlv/products/{id}/full 的 data（unsanitized 库行，编辑器载入用）。

        返回 None 与抛异常**语义不同，绝不能合并**：
          · None  —— HTTP 404，**库里没有这个产品**（admin/wenlv.ts 的 `/full` 就以此表达「不存在」）。
          · raise —— 其它非 2xx（5xx/403…）、连接失败、超时、响应形状不对。
        若把两者都吞成 None，一次网络抖动就被记成「库里没内容」，
        于是静默退化成老行为 —— 正是「看起来在工作、实际没接线」的失效模式。
        """
        try:
            body = self._get(f"/api/admin/wenlv/products/{product_id}/full")
        except httpx.HTTPStatusError as e:
            if e.response is not None and e.response.status_code == 404:
                return None
            raise
        data = body.get("data") if isinstance(body, dict) else None
        if not isinstance(body, dict) or not body.get("success") or not isinstance(data, dict):
            # 2xx 但不是预期封套：当失败抛，让上层回落 state，不冒充「库里没有」
            raise ValueError(f"products/{product_id}/full 响应不是 {{success:true,data:{{...}}}} 封套：{body!r:.200}")
        return data

    def create_product(self, product_id: str, name: str, mode: str = "narrative",
                       subtitle: str = "", theme: Optional[dict] = None, config: Optional[dict] = None,
                       venue_id: Optional[str] = None, ai_input: Optional[dict] = None) -> dict:
        body: dict = {"id": product_id, "name": name, "mode": mode, "subtitle": subtitle or None}
        if theme:
            body["theme"] = theme
        if config:
            body["config"] = config
        # 不传就不出现这两个键：pms-server 的 productHeadSchema 里 venueId / aiInput 都没有 default，
        # 但显式传 null 与「不传」在 POST 分支里同样落成 NULL —— 省略键是为了让请求体最小、日志最好读。
        if venue_id:
            body["venueId"] = venue_id
        if ai_input:
            body["aiInput"] = ai_input
        return self._post("/api/admin/wenlv/products", body)

    def create_node(self, product_id: str, node: dict, points: Optional[list] = None,
                    resolved_venue_point_id=_NOT_GIVEN) -> dict:
        """落一个节点。

        points = 本场地的点位清单（`site_material['points']`）。传了才做绑定解析与校验；
        不传（既有测试与直接调用方）则**绑定**一律 None。⚠️ 注意 **`triggerType` /
        `triggerCredential` 已与本参数无关** —— 它们恒为 `'manual'` / `None`（见下），
        故「不传即与改前行为一致」**只对绑定这一轴成立**。

        `resolved_venue_point_id` = 调用方**已解析好**的绑定值（`persist_draft` 复用它，
        免得同一节点解析两次、同一条 warning 打两遍）。不传则本方法自解析。

        🔴 `triggerType` / `triggerCredential` 恒落 'manual' / None —— **不由 AI 决定**。
        理由：它们表达的是**物理世界的铺设事实**（这个点有没有二维码、信标编的什么号），
        AI 无从知道。改前原样透传 AI 的即兴值，生产实测同一 draft 产品里
        manual/qrcode/beacon 混杂（出处：spec
        `docs/superpowers/specs/2026-09-20-wenlv-creation-flow-convergence-design.md`（外层仓库）
        §1.2，样本 = §1.1 生产实证表里「龙里龙门镇武侠探案」的节点行），
        其中「未绑点位 + qrcode + 空凭证」= 403 永远点不开。
        绑定点位后 `/trigger` 会自动走点位 code 分支、完全不再看 triggerType，语义正确。

        ⚠️ 本约束**只在这里**（出稿客户端）成立，**不得**下沉到 pms-server 的 admin 节点端点：
        那条路径同时是前端「应用精修」删光重建的入口（refine-panel.tsx 的 createNode），
        在那里强制会打回用户在编辑器里配好的值。
        """
        body = {
            "id": node["id"], "nodeType": node.get("node_type", "scene"),
            "title": node["title"], "storyText": node.get("story_text") or None,
            # 触发方式由人/现场决定，不由 AI。见本方法 docstring。
            "triggerType": "manual",
            "triggerCredential": None,
            "unlockCondition": build_wenlv_condition(node.get("unlock_collected", []), node.get("unlock_completed", [])),
            "effects": {
                "grant": node.get("grant_collectibles", []),
                "complete": node.get("complete_nodes", []),
            },
            "interactions": node.get("interactions", []),
            # 线下点位（虚实结合的唯一可靠来源）。2026-09-12 起 pms-server nodeSchema 开放该列；
            # 在此之前 AI 实测 11/11 节点产出的真实点位名全被丢弃。
            "location": node.get("location") or None,
            # 点位绑定：AI 给的 id 经 resolve_venue_point_id 校验后才落库。
            "venuePointId": (resolve_venue_point_id(node, points)
                             if resolved_venue_point_id is _NOT_GIVEN
                             else resolved_venue_point_id),
        }
        # 注：image / narrationUrl 不落 nodes 表 —— 它们是 S3 素材管线（asset-gen writeback）
        # 的回写目标列，出稿阶段还没有产物。pms-server admin nodeSchema **本来收**这两列
        # （为的是精修重建时不把用户已有的图与音频 zod-strip 掉），但出稿不发。
        # location_mapping 也不落库：其 chapter_id 实测填的是 END_*（结局 id）而非节点 id，
        # 与 node.id 对不上，故以 node.location 为唯一来源。
        return self._post(f"/api/admin/wenlv/products/{product_id}/nodes", body)

    def create_collectible(self, product_id: str, col: dict) -> dict:
        body = {
            "id": col["id"], "name": col["name"], "type": col.get("type", "clue"),
            "rarity": col.get("rarity", "common"), "description": col.get("description") or None,
        }
        return self._post(f"/api/admin/wenlv/products/{product_id}/collectibles", body)

    def create_character(self, product_id: str, ch: dict) -> dict:
        """POST 一个角色。**服务端是幂等重入的**（同 id 再 POST 返回既有行、不被新 body 覆盖），
        所以重跑出稿时这里可以无条件 POST，不会把人工改过的角色冲掉。"""
        hq = ch.get("hidden_quest")
        body = {
            "id": ch["id"], "name": ch.get("name"), "faction": ch.get("faction"),
            "factionColor": ch.get("faction_color"),
            "identity": ch.get("identity"), "identityDesc": ch.get("identity_desc"),
            "role": ch.get("role"),
            "ipPrompt": ch.get("ip_prompt"),
            "vitality": ch.get("vitality"), "wisdom": ch.get("wisdom"), "insight": ch.get("insight"),
            "skills": ch.get("skills") or [],
            "hiddenQuest": (
                {"title": hq.get("title"), "description": hq.get("description"),
                 "collectible_ids": hq.get("collectible_ids") or []}
                if isinstance(hq, dict) else None
            ),
            # ⚠️ **不发 avatar_url**：它是素材流水线的回写目标，AI 不产出。
            #    发空串会……（不会覆盖：服务端 POST 对已存在 id 直接返回既有行，故即使发了也无效；
            #    仍不发，是为了让这条「AI 不产出的列」在请求体里就不出现，一眼可查。）
        }
        return self._post(f"/api/admin/wenlv/products/{product_id}/characters", body)

    def create_npc(self, product_id: str, npc: dict) -> dict:
        """POST 一个 NPC。**服务端是幂等重入的**（同 id 再 POST 返回既有行）。"""
        body = {
            "id": npc["id"],
            "name": npc.get("name"),
            "role": npc.get("role"),
            "characterId": npc.get("character_id") or None,
            "portraitPrompt": npc.get("portrait_prompt") or npc.get("description"),
            "voiceId": npc.get("voice_id") or None,
            "description": npc.get("description") or None,
            "lines": npc.get("lines") or [],
        }
        return self._post(f"/api/admin/wenlv/products/{product_id}/npcs", body)

    def create_ending(self, product_id: str, ending: dict) -> dict:
        body = {
            "id": ending["id"], "title": ending["title"], "text": ending.get("text") or None,
            "triggerCondition": build_wenlv_condition(ending.get("collected_ids", []), []),
            "rewardId": ending.get("reward_id") or None,
            "priority": int(ending.get("priority") or 0),
        }
        return self._post(f"/api/admin/wenlv/products/{product_id}/endings", body)

    def create_tier(self, product_id: str, tier: dict) -> dict:
        body = {
            "id": tier["id"], "name": tier["name"], "description": tier.get("description") or None,
            "condition": build_wenlv_condition(tier.get("collected_ids", []), []),
            "rewardId": tier.get("reward_id") or None,
        }
        return self._post(f"/api/admin/wenlv/products/{product_id}/tiers", body)

    def create_reward(self, product_id: str, reward: dict) -> dict:
        body = {
            "id": reward["id"], "name": reward["name"], "type": reward.get("type", "coupon"),
            "value": reward.get("value") or None,
        }
        return self._post(f"/api/admin/wenlv/products/{product_id}/rewards", body)

    def publish(self, product_id: str) -> dict:
        return self._post(f"/api/admin/wenlv/products/{product_id}/publish", {})

    def persist_draft(self, product_id: str, name: str, mode: str, positioning: dict,
                      level: dict, visual: dict, config: dict,
                      site_material: Optional[dict] = None,
                      npcs: Optional[dict] = None) -> dict:
        """一键草稿整套落库：产品头 → 奖励 → 可收集物 → 角色 → NPC → 节点 → 结局 → 档位。"""
        # S2：场地归属与输入快照都从 site_material 派生，单一来源。
        # 快照存**整份** site_material（不是摘要）—— 事后要能回答「这次出稿 AI 到底看到了什么」。
        venue_id = ((site_material or {}).get("venue") or {}).get("id") or None
        # ===== P0 预校验：任一项失败则抛错，不落库任何内容 =====
        errors = []
        # 1. 角色必填字段
        for ch in (config.get("characters") or {}).get("characters", []) or []:
            if not ch.get("id"):
                errors.append(f"角色缺少 id: {ch}")
            if not (ch.get("name") or "").strip():
                errors.append(f"角色 {ch.get('id')} name 为空")
            if not (ch.get("faction") or "").strip():
                errors.append(f"角色 {ch.get('id')} faction 为空")
            if not (ch.get("identity") or "").strip():
                errors.append(f"角色 {ch.get('id')} identity 为空")
        # 2. 节点必填字段 + id 唯一
        node_ids = set()
        for n in level.get("nodes", []):
            nid = n.get("id")
            if not nid:
                errors.append(f"节点缺少 id: {n}")
            elif nid in node_ids:
                errors.append(f"节点 id 重复: {nid}")
            else:
                node_ids.add(nid)
            if not (n.get("title") or "").strip():
                errors.append(f"节点 {nid} title 为空")
        # 3. 结局/档位必填
        for e in level.get("endings", []):
            if not e.get("id"):
                errors.append(f"结局缺少 id: {e}")
        for t in level.get("tiers", []):
            if not t.get("id"):
                errors.append(f"档位缺少 id: {t}")
        # 4. NPC 必填字段（P3）
        for npc in (npcs or {}).get("npcs", []) or []:
            if not npc.get("id"):
                errors.append(f"NPC 缺少 id: {npc}")
            if not (npc.get("name") or "").strip():
                errors.append(f"NPC {npc.get('id')} name 为空")
            lines = npc.get("lines") or []
            if not isinstance(lines, list) or len(lines) == 0:
                errors.append(f"NPC {npc.get('id')} 至少要有 1 条台词")
        if errors:
            raise ValueError(f"草稿预校验失败（不落库）：{'; '.join(errors)}")
        # ===== 预校验通过，开始落库 =====
        self.create_product(product_id, name, mode=mode,
                            subtitle=positioning.get("world_tone", "")[:200],
                            theme={"primaryColor": (visual.get("colors") or {}).get("primary")},
                            config=config,
                            venue_id=venue_id, ai_input=site_material or None)
        for r in level.get("rewards", []):
            self.create_reward(product_id, r)
        for c in level.get("collectibles", []):
            self.create_collectible(product_id, c)
        # 角色：从 config 的剧本快照里取（与上面 create_collectible 的位置无关，
        # 但必须**在节点之前**——R3（T9）不在这里跑，这里只负责落库；
        # 顺序无所谓，选在 collectibles 之后只是为了让人读起来是「剧本层 → 关卡层」）。
        # ⚠️ 空数组是**合法输入**：一键草稿理论上必产角色（prompt 已要求），
        #    但 AI 偶发漏产时不该让整次出稿失败 —— 发布闸 R1（P5）才是最终那道。
        for ch in (config.get("characters") or {}).get("characters", []) or []:
            if ch.get("id"):
                self.create_character(product_id, ch)
        # P3：NPC 落库（在角色之后——NPC.character_id 引用角色，虽无 FK 约束但逻辑上应先有角色）
        for npc in (npcs or {}).get("npcs", []) or []:
            if npc.get("id"):
                self.create_npc(product_id, npc)
        # 点位绑定：单一来源 = site_material['points']（与上面的 venue_id 同源）。
        #
        # 🔴 但没有场地时**必须一个绑定都不发**：服务端节点 POST 有一道硬闸
        #   （admin/wenlv.ts:1118「产品未归属场地，不能引用点位」400），
        #   而客户端是逐节点 POST（`for n in nodes`），一次 400 只**中断循环** ——
        #   已 POST 成功的节点仍在库里 ⇒ 后果是「**部分落库 + 后续节点中断**」，不是整批拒绝。
        #   损害范围还不止节点：异常一路抛到 wenlv_creation_crew.py 的 `except`（:279），
        #   于是**节点循环之后的 endings / tiers 同样不落库**，整次出稿被记 FAILED。
        #
        # 「有点位、无场地」这条形状**不是** BFF /ai/draft 造的：它在 `venue_id` 非空时才
        #   `buildSiteMaterial`（wenlv-studio.ts:843），那条路径上二者必然同时有。
        #   可达路径是**绕过 BFF、直连 pms-ai-crew /draft 的调用方** —— 它们不经过 BFF 那道
        #   「空 venue_id 一律 400」的闸（同文件 :824），可以自行塞一份 `site_material`
        #   （含 points）却不给 `venue_id`，从而造出该形状。守卫因此保留。
        #   ⚠️ 2026-09-24：BFF 侧原先「未选场地时把 body **原样转发**（`payload = body`）」的
        #   那段透传早先也符合同一形状，但该路（连同「经 BFF 透传一份自带 site_material」的说法）
        #   已于本日删除，不再是可达路径 —— 故此处不再把它列为造出该形状的路径。保留守卫的理由
        #   已改由上述「直连 ai-crew」一条独立支撑，与 BFF 的实现变更解耦。
        #
        # 复用上面已推导好的 venue_id（不重复推导）：它是本函数 venue 归属的唯一来源。
        points = ((site_material or {}).get("points") or []) if venue_id else []
        if not venue_id and (site_material or {}).get("points"):
            logger.warning("site_material 有点位但没有场地 —— 本次出稿一律不绑点位（服务端会 400）")
        nodes = level.get("nodes", [])
        # 未绑点位的节点 id **必须回报**，否则「AI 没绑上」与「AI 认为无需绑」在
        # 出稿结果里长得一模一样，用户拿到一个「上线后才发现 16/17 节点免凭证」的产品。
        # 每个节点只解析一次（改前是 unbound 算一次、create_node 再算一次 ⇒ 同一节点两条
        # warning）。成对列表而非 {n["id"]: ...} 字典：节点 id 缺失/重复时字典会互相覆盖，
        # 而这里保序且无键冲突。
        resolved = [(n, resolve_venue_point_id(n, points)) for n in nodes]
        unbound = [n.get("id") for n, vid in resolved if vid is None]
        if unbound:
            if venue_id:
                logger.warning("出稿有 %d 个节点未绑定点位（需到场判定的节点请到创作台补绑）：%s",
                               len(unbound), unbound)
            else:
                # M1：无场地时说「去创作台补绑」是错的 —— 那时**没有点位可绑**，先得给产品挂场地。
                logger.warning("产品未归属场地，本次出稿 %d 个节点均无点位可绑（先给产品挂场地）：%s",
                               len(unbound), unbound)
        for n, vid in resolved:
            self.create_node(product_id, n, points=points, resolved_venue_point_id=vid)
        for e in level.get("endings", []):
            self.create_ending(product_id, e)
        for t in level.get("tiers", []):
            self.create_tier(product_id, t)
        return {"product_id": product_id, "status": "draft", "nodes_unbound": unbound}

    def enqueue_assets(self, product_id: str,
                       types: Optional[list] = None) -> dict:
        """P3：apply 草稿后自动触发素材生成。

        调 pms-server 的 `/api/admin/wenlv-asset-gen/batch`，由它从库里读
        节点/收集物/NPC/角色/结局/奖励/档位，按 types 展开成素材 job 入队。
        types 缺省 = 角色立绘 + NPC 立绘 + 印章 + 背景（apply 时的默认全量）。
        返回 batchId（前端可轮询素材进度）。
        """
        body = {
            "productId": product_id,
            "types": types or ["character_avatar", "npc_portrait", "stamp", "background"],
        }
        resp = self._post("/api/admin/wenlv-asset-gen/batch", body)
        data = resp.get("data") if isinstance(resp, dict) else None
        return data or resp

    def bootstrap_style_bible(self, product_id: str) -> dict:
        """P3：apply 时自举风格基线（素材 batch 要求 bible.artStyle 非空）。

        调 `/api/admin/wenlv-asset-gen/style-bible/bootstrap`。已有基线则复用（零花费），
        否则走 LLM 生成。返回 { styleBible, reused, batchId }。
        """
        resp = self._post("/api/admin/wenlv-asset-gen/style-bible/bootstrap",
                          {"productId": product_id})
        data = resp.get("data") if isinstance(resp, dict) else None
        return data or resp
