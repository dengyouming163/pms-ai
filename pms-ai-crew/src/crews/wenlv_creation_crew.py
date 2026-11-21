# src/crews/wenlv_creation_crew.py
"""文旅 AI 创作流水线 Orchestrator：一键草稿（5 阶段）+ 分步精修 + 校验重试熔断。

复用 video_script 的 Redis 状态机 + 分阶段校验重试模式；无人工 confirm 断点，一键跑完
5 阶段（项目定位 → 剧本 6 步 → 关卡设计 → 视觉设计 → 完整性校验）落库 draft。
稳定产出闭环（spec §5.4）：⑤ 校验不过 → 带错误清单重跑对应阶段（最多 2 次）→ 仍失败
标记 FAILED（需人工），绝不静默入库。
"""
import json
import logging
from typing import Dict, Optional
from crewai import Crew, Process, Task

logger = logging.getLogger(__name__)

from src.agents.wenlv_creation import (
    project_positioning_agent, SCRIPT_AGENTS, level_designer_agent, visual_designer_agent,
    npc_designer_agent, character_designer_agent, ending_designer_agent,
    collectible_image_agent, reward_designer_agent,
    skeleton_designer_agent,
)
from src.schemas.common import looks_truncated_json
from src.schemas.wenlv_creation import (
    ProjectPositioning, WorldSetting, Storyline, Characters, Chapters, Endings,
    LocationMapping, LevelDesign, VisualDesign, WenlvNpcs,
    CollectibleImagePrompt, WenlvRewards, WenlvPlotSkeleton,
)
from src.services.wenlv_integrity import validate_wenlv_integrity
from src.services.wenlv_persist import (
    WenlvPersister, build_level_from_product_full, build_visual_from_product_full,
    build_npcs_from_product_full, build_characters_from_product_full,
)

# 剧本 6 步：agent ↔ schema 对应（顺序固定）
SCRIPT_STEPS = [
    ("world", WorldSetting),
    ("storyline", Storyline),
    ("characters", Characters),
    ("chapters", Chapters),
    ("endings", Endings),
    ("location", LocationMapping),
]


def _culture_brief(site_material: Optional[dict]) -> str:
    """场地名 + 地址 + 文化素材全文，喂给项目定位 agent 塑造世界调性。"""
    if not site_material:
        return ""
    venue = site_material.get("venue") or {}
    lines = [f"场地名称：{venue.get('name') or ''}"]
    if venue.get("address"):
        lines.append(f"场地地址：{venue['address']}")
    if venue.get("city"):
        lines.append(f"所在城市：{venue['city']}")
    culture = venue.get("culture") or []
    if culture:
        lines.append("在地文化素材（采风实录，务必融入世界观）：")
        for m in culture:
            src = f"（来源：{m['source']}）" if m.get("source") else ""
            lines.append(f"- [{m.get('type', '')}] {m.get('title', '')}：{m.get('content', '')}{src}")
    return "\n".join(lines)


def _points_brief(site_material: Optional[dict]) -> str:
    """结构化点位清单（**含点位 id**）。

    供**两处**注入，调用方各自追加该步的用法说明：
      ① 剧本第 6 步 location —— 让 mappings.location 用真实点位名
      ② 第 3 阶段关卡设计   —— 让 LevelNode.venue_point_id 用真实点位 id
         （2026-09-20 前这里只喂 ①，而产出 LevelNode 的是 ②，
          于是「让 AI 绑点位」的改动在那一步根本看不到 id，恒无效果）

    清单行格式：`- [<id>] <名字>；位置：…；备注：…；坐标：…`
    """
    if not site_material:
        return ""
    points = site_material.get("points") or []
    if not points:
        return ""
    lines = ["本场地的真实点位清单（不得虚构地点名与 id）："]
    for p in points:
        pid = p.get("id")
        name = p.get("name") or ""
        head = f"- [{pid}] {name}" if pid else f"- {name}"
        bits = [head]
        if p.get("address"):
            bits.append(f"位置：{p['address']}")
        if p.get("remark"):
            bits.append(f"备注：{p['remark']}")
        geo = p.get("geo") or {}
        if geo.get("lat") is not None and geo.get("lng") is not None:
            bits.append(f"坐标：{geo['lat']},{geo['lng']}")
        lines.append("；".join(bits))
    return "\n".join(lines)


class StageFailedError(Exception):
    """阶段生成失败：Pydantic 校验重试后仍不合格，或完整性校验重试后仍失败。"""


def _parse_json(raw: str) -> dict:
    """从 LLM 输出提取 JSON（剥 markdown 围栏 + 词法修复，复用 video_script 逻辑）。"""
    from src.crews.video_script_crew import _parse_json as _pj, _fix_json_string_newlines
    try:
        return _pj(raw)
    except Exception as first_err:
        try:
            return _pj(_fix_json_string_newlines(raw))
        except Exception as e:
            # 区分「被 max_tokens 截断」与「写错语法」：前者改提示词无用，只能加预算
            if looks_truncated_json(raw):
                raise ValueError(
                    f"输出被截断（撞 LLM max_tokens 上限），JSON 未闭合，原文 {len(raw)} 字符：{e}"
                ) from e
            raise first_err


class WenlvCreationOrchestrator:
    """一键草稿流水线编排器（同步 LLM 调用，外层经 asyncio.to_thread 包裹）。"""

    def __init__(self, redis=None):
        self.redis = redis
        self.state_key = "wenlv_creation:state"
        self.persister = WenlvPersister()

    # ---------- 状态持久化（复用 video_script 模式） ----------
    def _get_state(self, project_id: str) -> Dict:
        if not self.redis:
            return {"status": "CREATED", "output": {}}
        raw = self.redis.get(f"{self.state_key}:{project_id}")
        if raw:
            return json.loads(raw)
        return {"status": "CREATED", "output": {}}

    def _set_state(self, project_id: str, status: str, output: Dict):
        if not self.redis:
            return
        self.redis.set(f"{self.state_key}:{project_id}",
                       json.dumps({"status": status, "output": output}, ensure_ascii=False))
        self.redis.expire(f"{self.state_key}:{project_id}", 30 * 86400)

    # ---------- 单阶段执行（Pydantic 校验 + 重试 + 熔断） ----------
    # retries 的取值，三层意思，缺一不可：
    #   ① 默认 2 = 对齐模块 docstring 的自述契约「校验不过 → 带错误清单重跑……（最多 2 次）」
    #      ⇒ 单阶段路径（项目定位 / 剧本 6 步 / 视觉设计 / 精修）为 1 次首发 + 2 次重跑 = 3 次 kickoff。
    #   ② _run_level_design_with_retry 的两处调用【显式传 retries=1】：它自身还有一轮
    #      `for _ in range(2)` 的「带完整性错误清单」重跑；两层都拉满是乘法，最坏 kickoff 次数会从
    #      2 + 2×2 = 6 涨到 3 + 2×3 = 9，每次都是真 LLM 调用。
    #   ③ 两层都不许设 0：StageFailedError 在 _run_level_design_with_retry 里【没有被捕获】
    #      （`for` 循环无 try），内层设 0 会让「JSON 形状类失败」一次重试都没有，直接冒泡熔断。
    def _run_agent(self, agent, task_desc: str, expected: str, schema_cls, retries: int = 2) -> Dict:
        last_err: Optional[Exception] = None
        for attempt in range(retries + 1):   # 首发 + retries 次重跑
            if attempt == 0:
                desc = task_desc
            else:
                desc = task_desc + (
                    f"\n\n上次输出 JSON 校验失败：{last_err}。"
                    f"请严格按字段输出合法 JSON，不要 markdown 围栏，不要多余文字。"
                )
            task = Task(description=desc, expected_output=expected, agent=agent)
            crew = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=True)
            result = crew.kickoff()
            raw = str(result.raw) if hasattr(result, "raw") else str(result)
            try:
                return schema_cls(**_parse_json(raw)).model_dump()
            except Exception as e:
                last_err = e
        raise StageFailedError(f"{expected} 校验重试后仍失败：{last_err}") from last_err

    # ---------- 关卡设计 + 完整性校验重试熔断（独立闭环，供一键草稿与分步精修复用） ----------
    def _run_level_design_with_retry(self, script_out: Dict, positioning: Optional[Dict] = None,
                                     theme: str = "", site_material: Optional[dict] = None,
                                     id_prefix_instruction: str = "", npcs: Optional[Dict] = None) -> Dict:
        """关卡设计 → 校验 → 带错误清单重跑（最多 2 次）→ 仍失败抛 StageFailedError。

        site_material 为**带默认值的关键字参数**：既有两处测试以位置参数 ("P1", {}) 调用，
        不可改成必填（见 tests/test_wenlv_creation_crew.py）。
        """
        positioning = positioning or {}
        mode = positioning.get("mode", "narrative")
        # 点位清单（含 id）必须喂给**这一步** —— 它才是产出 LevelNode 的一步。
        points_brief = _points_brief(site_material)
        points_suffix = ""
        if points_brief:
            points_suffix = (
                f"\n\n{points_brief}\n"
                f"每个节点的 venue_point_id 必须从上面方括号里的 id 中选取（一个节点最多绑一个）；"
                f"纯剧情、不需要玩家到场的节点留空字符串。**不得虚构 id**，不得把点位名写进该字段。"
            )
        # P3：把 NPC 清单喂给关卡设计 —— node.npcId 必须引用真实 NPC（不造 id），
        # 且无 NPC 的节点不写 npcId（避免悬挂引用）。
        npc_list = (npcs or {}).get("npcs") or []
        npc_suffix = ""
        if npc_list:
            npc_suffix = (
                f"\n\n【NPC 清单】{json.dumps(npc_list, ensure_ascii=False)}\n"
                f"节点的 npc_id（或 npcId）必须**只**引用上面清单中的 NPC id；"
                f"不需要说话人的节点**不要**写该字段（避免悬挂引用导致发布失败）。"
            )
        level = self._run_agent(
            level_designer_agent,
            f"剧本产出：{json.dumps(script_out, ensure_ascii=False)}\nmode：{mode}\n"
            f"输出 level_design JSON。{id_prefix_instruction}{points_suffix}{npc_suffix}",
            "level_design JSON", LevelDesign, retries=1,
        )
        draft = self._build_draft(positioning, level, {}, theme=theme, script=script_out)
        errors = self._validate(draft)
        for _ in range(2):
            if not errors:
                break
            # 提成局部变量：原来这 6 段 f-string 隐式拼接的末段**紧贴位置参数**
            # `"level_design JSON", LevelDesign`，删掉末段会让 `"level_design JSON"` 被隐式拼进
            # 本 desc、LevelDesign 前移成 expected ⇒ 报错指向调用点而非根因。提出来后
            # 「后缀丢失」是一行可读的改动（f"{points_suffix}" → f""）。
            retry_desc = (
                f"上次关卡设计校验失败，错误清单：{json.dumps(errors, ensure_ascii=False)}\n请修复引用闭环/可达性/题型后重新输出 level_design JSON。\n"
                f"题型规则：puzzle 只能放 single/multiple/judge/input 且答案非空；judge 的 answer 只能是 \"true\" 或 \"false\"（对＝true、错＝false），不要写「对」「正确」这类中文；scene 可放这些题型，也可放 photo/meditate；meditate 的 seconds 为 1~1800 整数。\n"
                f"可达性错误的含义：unlock_completed 引用的节点无人 complete（需写进某节点的 complete_nodes，"
                f"最稳妥是每节点把自己 id 写进自己的 complete_nodes）；结局/档位引用的线索或印章无人 grant"
                f"（需写进某节点的 grant_collectibles）。\n剧本产出：{json.dumps(script_out, ensure_ascii=False)}"
                f"{id_prefix_instruction}{points_suffix}{npc_suffix}"
            )
            level = self._run_agent(
                level_designer_agent,
                retry_desc,
                "level_design JSON", LevelDesign, retries=1,
            )
            draft = self._build_draft(positioning, level, {}, theme=theme, script=script_out)
            errors = self._validate(draft)
        if errors:
            raise StageFailedError(f"完整性校验重试后仍失败：{errors}")
        return level

    # ---------- 一键草稿（5 阶段） ----------
    def run_draft(self, project_id: str, theme: str, mode: str = "narrative",
                  style_tag: str = "guochao", locations: Optional[list] = None,
                  site_material: Optional[dict] = None) -> Dict:
        try:
            self._set_state(project_id, "DRAFTING", {})
            import re
            prod_num_match = re.search(r'(\d+)', project_id)
            prod_num = prod_num_match.group(1) if prod_num_match else project_id
            id_prefix_instruction = f"\n\n【id 命名铁律】本产品编号为 {prod_num}。所有 id 必须以 '_{prod_num}_' 嵌入：角色 CHAR_{prod_num}_001、NPC NPC_{prod_num}_001、节点 NODE_{prod_num}_001、线索 CLUE_{prod_num}_001、结局 END_{prod_num}_001、奖励 REWARD_{prod_num}_001、档位 TIER_{prod_num}_001。不得使用无前缀或其他编号的 id。"
            # ① 项目定位（S2：注入场地名/地址/文化素材全文）
            culture = _culture_brief(site_material)
            positioning_desc = (
                f"主题：{theme}\n用户指定 mode：{mode}\n风格偏好：{style_tag}\n"
                f"线下地点：{json.dumps(locations or [], ensure_ascii=False)}\n"
            )
            if culture:
                positioning_desc += f"\n{culture}\n"
            positioning_desc += id_prefix_instruction + "输出 project_positioning JSON。"
            positioning = self._run_agent(
                project_positioning_agent, positioning_desc,
                "project_positioning JSON", ProjectPositioning,
            )
            # ② 剧本 6 步子流水线（S2：仅第 6 步 location 注入点位清单）
            script_out: Dict = {}
            prev: Dict = positioning
            points_brief = _points_brief(site_material)
            for name, schema_cls in SCRIPT_STEPS:
                step_desc = f"上游产出：{json.dumps(prev, ensure_ascii=False)}\n当前子任务：{name}\n"
                if name == "location" and points_brief:
                    step_desc += (f"\n{points_brief}\n"
                                  f"mappings 里的 location 必须从上表的地点名中选取，不得虚构地点名；"
                                  f"方括号里的点位 id 是给关卡设计用的键，**不是**地点名，不要写进 location。\n")
                step_desc += id_prefix_instruction + f"输出 {name} JSON。"
                step = self._run_agent(
                    SCRIPT_AGENTS[SCRIPT_STEPS.index((name, schema_cls))],
                    step_desc,
                    f"{name} JSON", schema_cls,
                )
                script_out[name] = step
                prev = step
            # ②.5 P3：NPC 生成（带角色上下文，character_id 只引用已有角色）
            #   放在关卡设计之前：关卡设计需要引用真实 NPC id。
            npc_base = {
                "characters": script_out.get("characters", {}),
                "npcs": [],
                "world_setting": script_out.get("world", {}),
                "storyline": script_out.get("storyline", {}),
                "chapters": script_out.get("chapters", {}),
                "endings": script_out.get("endings", {}),
                "location": script_out.get("location", {}),
            }
            npc_desc = (
                f"已有草稿：{json.dumps(npc_base, ensure_ascii=False)}\n"
                f"其中 characters 是基线角色（选角卡），npcs 为空（首次生成）。\n"
                f"world_setting/storyline/chapters/endings/location 是剧本上下文，请参考以避免重名、合理设置 character_id。\n"
                f"{id_prefix_instruction}输出 npc_setting JSON（包含 npcs 列表）。"
            )
            npcs = self._run_agent(
                npc_designer_agent, npc_desc, "npc_setting JSON", WenlvNpcs,
            )
            # ③ 关卡设计（含完整性校验 + 重试熔断）—— P3：注入 NPC 清单
            level = self._run_level_design_with_retry(script_out, positioning, theme,
                                                      site_material=site_material,
                                                      id_prefix_instruction=id_prefix_instruction,
                                                      npcs=npcs)
            # ④ 视觉设计
            visual = self._run_agent(
                visual_designer_agent,
                f"项目定位：{json.dumps(positioning, ensure_ascii=False)}\n剧本/关卡：{json.dumps({**script_out, 'level': level}, ensure_ascii=False)[:4000]}\n输出 visual_design JSON。",
                "visual_design JSON", VisualDesign,
            )
            # P3：**不直接落库** —— 整份草稿存 Redis 草稿区，由前端「预览→应用」触发 apply_draft。
            #   这样 AI 生成失败/不合意时可以丢弃重跑，不会污染线上库。
            out = {
                "product_id": project_id,
                "positioning": positioning,
                "level": level,
                "visual": visual,
                "script": script_out,
                "npcs": npcs,
                "theme": theme,
                "site_material": site_material,
            }
            self._set_state(project_id, "DRAFT_READY", out)
            return {"status": "DRAFT_READY", "output": out}
        except StageFailedError as e:
            self._set_state(project_id, "FAILED", {"error": str(e)})
            return {"status": "FAILED", "error": str(e)}
        except Exception as e:
            # 兜底：LLM 网络异常 / 落库（pms-server HTTP）失败 / 任何未预期错误。
            # 不接住的话异常会冒泡穿越 run_draft，经 asyncio.to_thread 到 api 的
            # create_task 后被静默丢弃（仅打一条 "Task exception was never retrieved"），
            # 状态永停 DRAFTING —— 用户永远转圈，且几分钟算力白烧、无处可查。
            msg = f"未预期异常：{type(e).__name__}: {e}"
            logger.exception("文旅一键草稿失败 project_id=%s", project_id)
            self._set_state(project_id, "FAILED", {"error": msg})
            return {"status": "FAILED", "error": msg}

    # ---------- P3：草稿应用 / 预览 / 丢弃 ----------
    def apply_draft(self, project_id: str) -> Dict:
        """把 Redis 里的 DRAFT_READY 草稿事务落库 + 自动入队素材。

        流程：读 state → persist_draft（含 P0 预校验，失败则整体不落） →
        enqueue_assets（角色立绘/NPC 立绘/印章/背景）。
        成功后把 state 切到 APPLIED（保留草稿内容备查，但不再可 apply）。
        """
        state = self._get_state(project_id)
        if state.get("status") != "DRAFT_READY":
            return {"status": "ERROR",
                    "error": f"无可应用草稿（当前状态：{state.get('status')}）"}
        out = state.get("output") or {}
        positioning = out.get("positioning") or {}
        level = out.get("level") or {}
        visual = out.get("visual") or {}
        script_out = out.get("script") or {}
        npcs = out.get("npcs")
        theme = out.get("theme", "")
        site_material = out.get("site_material")
        try:
            persist_res = self.persister.persist_draft(
                project_id, theme, positioning.get("mode", "narrative"),
                positioning, level, visual,
                config={"world_setting": script_out.get("world", {}),
                        "storyline": script_out.get("storyline", {}),
                        "characters": script_out.get("characters", {})},
                site_material=site_material,
                npcs=npcs,
            )
        except Exception as e:
            msg = f"落库失败：{type(e).__name__}: {e}"
            logger.exception("apply_draft 落库失败 project_id=%s", project_id)
            return {"status": "FAILED", "error": msg}
        # 素材入队（非致命：入队失败不回滚已落库内容，但要把错误带回前端）
        asset_err = None
        batch_id = None
        try:
            # 先自举风格基线：batch 端点要求 bible.artStyle 非空，否则 409。
            # 已有则复用（零花费），否则 LLM 生成。
            self.persister.bootstrap_style_bible(project_id)
            enq = self.persister.enqueue_assets(project_id)
            batch_id = enq.get("batchId") if isinstance(enq, dict) else None
        except Exception as e:
            asset_err = f"素材入队失败：{type(e).__name__}: {e}"
            logger.warning("apply_draft 素材入队失败 project_id=%s: %s", project_id, asset_err)
        result = {
            "product_id": project_id,
            "nodes_unbound": (persist_res or {}).get("nodes_unbound", []),
            "asset_batch_id": batch_id,
            "asset_error": asset_err,
        }
        self._set_state(project_id, "APPLIED", {**out, "apply_result": result})
        return {"status": "APPLIED", "output": result}

    def discard_draft(self, project_id: str) -> Dict:
        """丢弃草稿：清 Redis 状态。"""
        self.redis.delete(f"{self.state_key}:{project_id}")
        return {"status": "DISCARDED", "product_id": project_id}

    # ---------- 组装草稿 + 校验 ----------
    def _build_draft(self, positioning: Dict, level: Dict, visual: Dict, theme: str = "",
                     script: Optional[Dict] = None) -> Dict:
        name = theme.strip() or positioning.get("world_tone", "")
        # `script` 的注解写了 Dict，但**运行期不作保证**：既有调用点里有把第一个位置参数传成
        # 字符串的（tests/test_wenlv_creation_crew.py 以 "P1" 调用 _run_level_design_with_retry）。
        # 非 dict 一律当「无角色」—— 校验器是发布闸，不该在投影处炸成 AttributeError。
        characters_doc = script.get("characters") if isinstance(script, dict) else None
        return {
            "product": {"id": "", "name": name, "mode": positioning.get("mode", "narrative")},
            "nodes": level.get("nodes", []),
            "collectibles": level.get("collectibles", []),
            "endings": level.get("endings", []),
            "tiers": level.get("tiers", []),
            "rewards": level.get("rewards", []),
            # 角色（R3 用）：**照 schema 写下的形状**透传 —— `Character.hidden_quest` 是嵌套的
            # （见 src/schemas/wenlv_creation.py），校验器读的就是这个嵌套形状。**不要在这里摊平**：
            # 本文件对 nodes 的字段（unlock_collected 等）是 schema 扁平声明的，从来没有
            # 「先摊平再读」这一步；在此洗形只会造出校验器不认的键（恒 0 命中）。
            "characters": [
                ch for ch in ((characters_doc or {}).get("characters") or [])
                if isinstance(ch, dict) and ch.get("id")
            ],
        }

    def _validate(self, draft: Dict) -> list[str]:
        return validate_wenlv_integrity(draft)

    # ---------- 分步精修（单个 agent 重跑 + 重跑校验） ----------
    def _refine_baseline_from_db(self, project_id: str, stage: str) -> Optional[Dict]:
        """从 pms-server 的库里建 level/visual/npc_setting 精修基线（T11）。

        返回 None = 库里没有可用基线（产品不存在 / 该 stage 在库中无内容 / 条件形状认不出）；
        **抛** = 读取本身失败（网络/5xx/响应形状异常）。两种情况都不许静默混为一谈 ——
        把网络抖动记成「库里没内容」正是「看起来在工作、实际没接线」的失效。
        """
        full = self.persister.get_product_full(project_id)
        if full is None:
            logger.info("精修基线：产品 %s 不在库中（404）", project_id)
            return None
        if stage == "level":
            base = build_level_from_product_full(full)
            empty_note = "五个子资源全空 / 某条解锁条件的形状认不出"
        elif stage == "characters":
            # ⚠️ 本分支**不会**因「表里没角色」而落到 empty_note：
            #    build_characters_from_product_full 对存在的产品恒返回 dict（空表 = 有效空基线）。
            #    这正是它与 level/visual 的 None 约定**刻意不同**之处 —— 理由见该函数 docstring。
            base = build_characters_from_product_full(full)
            empty_note = "（本 stage 不会出现此情形：产品存在即有基线）"
        elif stage == "npc_setting":
            base = build_npcs_from_product_full(full)
            empty_note = "npcs 表为空"
        else:
            base = build_visual_from_product_full(full)
            empty_note = "theme 里 primaryColor 与 templateId 都为空"
        if base is None:
            logger.info("精修基线：%s 在库中无可用 %s 基线（%s），回落 state", project_id, stage, empty_note)
        return base

    def _refine_baseline(self, project_id: str, stage: str, out: Dict) -> Dict:
        """level/visual/npc_setting 的基线：**库优先，读不到才回落 state**；characters 走同一条路但**不回落**。"""
        try:
            base = self._refine_baseline_from_db(project_id, stage)
        except Exception as e:
            # 读库失败（5xx / 连接失败 / 超时 / 封套不对）：回落 state，但留下 WARN 级痕迹 ——
            # 若在这里静默成 None，日志里就只剩「回落 state」，没有人能事后回答
            # 「这次到底是库里真没内容，还是 pms-server 挂了」。
            logger.warning("精修基线：读库失败（%s: %s），回落 state project_id=%s",
                           type(e).__name__, e, project_id)
            base = None
        # npc_setting 是独立 stage（不进 script），输出键 "npcs" 与 stage 名不同
        state_key = "npcs" if stage == "npc_setting" else stage
        if stage == "characters":
            # ⚠️ 与其余 stage **刻意相反**：characters 永不回落 state。
            #    产品存在 ⇒ build_characters_from_product_full 恒返回 dict（空表也是有效基线），base 非空；
            #    产品 404 ⇒ base 为 None，此时必须返回 {} 让上方的 `if not base` 守卫拒答 ——
            #    绝不能拿 state 里那份陈旧草稿顶上（存量剧本的 state 常已过期，而「库优先」正是 T12 的契约）。
            return base or {}
        return base or out.get(state_key, {})

    # ---------- S3 npc_voice stage（TTS 合成 + 重试 + 哈希缓存，T24） ----------
    # 与上面 LLM 驱动的 stage 不同：npc_voice 不调 agent，而是逐句调火山 TTS API。
    # 架构约束（同 S1）：AI crew 不直接写 pms-server DB、也不上传素材库 OSS。
    #   故本 stage 把音频以 base64 返回，由 admin 路由负责上传素材库（npc_voice 类型）+
    #   回写 npc.lines[i].voiceUrl/duration（spec §5.5 / §7.4）。
    #   现有 pms-ai-crew 全仓无 OSS/asset 上传机制（wenlv_persist 只做 JSON HTTP 落库，
    #   wenlv_image 的 provider 也只产 URL 不上传字节），故选 base64 回传。
    TTS_RETRY_DELAYS = (1, 2, 4)   # 指数退避秒数，与 retries=3 对齐（spec §7.6）
    TTS_CONCURRENCY = 5            # 并发上限（spec §7.7：火山 QPS=10，留余量）

    def _synthesize_with_retry(self, adapter, text: str, voice_id: str,
                               retries: int = 3) -> tuple[bytes, int]:
        """调 TtsVolcanoAdapter.synthesize，重试 3 次，指数退避（1s/2s/4s）。

        覆盖三类瞬时失败：火山 API 限流、网络抖动、偶发 5xx。密钥失效重试也救不回，
        但重试无副作用，让它跑满 3 次再由调用方记 failed（spec §7.6）。
        """
        import time
        last_err: Optional[Exception] = None
        for attempt in range(retries + 1):   # 首发 + retries 次重跑
            try:
                return adapter.synthesize(text, voice_id)
            except Exception as e:
                last_err = e
                if attempt < retries:
                    time.sleep(self.TTS_RETRY_DELAYS[attempt])
        assert last_err is not None
        raise last_err

    def _run_npc_voice_stage(self, project_id: str, out: Dict) -> Dict:
        """S3 npc_voice stage：逐句 TTS 合成 + 并发限 5 + 哈希缓存 + 重试退避。

        输入：npc.lines[].text + npc.voice_id（来自 DB 库行或 Redis state 的 S1 产出）。
        输出：{npcs: [{npc_id, lines: [{line_id, voiceUrl, duration, audio_base64,
                                        voice_hash, skipped, error}]}]}，
        供 admin 路由上传素材库 + 回写 npc.lines[i].voiceUrl/duration。

        哈希缓存（spec §7.5）：表内 voiceUrl 字段本身即缓存 —— admin 路由在 text 未变时
        保留 voiceUrl、text 变时清空（admin/wenlv.ts 的 NPC upsert merge 逻辑）。
        故本 stage 读到 baseline line 带 voiceUrl ⇒ 视为 (text + voice_id) 未变 ⇒ 跳过合成。
        voice_hash 一并返回，供 admin 路由做素材库去重（spec §7.5「相同 hash 复用同一音频」）。
        """
        import base64 as _b64
        import hashlib
        from concurrent.futures import ThreadPoolExecutor, as_completed
        from src.services.tts_volcano import TtsVolcanoAdapter

        # 基线：DB 优先（含 voiceUrl/duration 供缓存命中判断），回落 Redis state（S1 产出，无 voiceUrl）。
        # 不复用 _refine_baseline：那个走 build_npcs_from_product_full，会**剥离** voiceUrl/duration
        #（S1 喂 LLM 的基线不该带 TTS 产物）；S3 恰恰需要它们做缓存判断。
        npcs: list = []
        try:
            full = self.persister.get_product_full(project_id)
        except Exception as e:
            # 读库失败（5xx/连接失败）回落 state，留 WARN 痕迹（与 _refine_baseline 同款语义）。
            logger.warning("npc_voice 基线：读库失败（%s: %s），回落 state project_id=%s",
                           type(e).__name__, e, project_id)
            full = None
        if full is not None:
            for n in full.get("npcs") or []:
                if not isinstance(n, dict):
                    continue
                lines = []
                for l in n.get("lines") or []:
                    if not isinstance(l, dict):
                        continue
                    lines.append({
                        "id": l.get("id"),
                        "text": l.get("text") or "",
                        "voiceUrl": l.get("voiceUrl") or "",
                        "duration": l.get("duration") or 0,
                    })
                npcs.append({"id": n.get("id"), "voice_id": n.get("voiceId") or "", "lines": lines})
        if not npcs:
            # 回落 state：S1 写的 out["npcs"] = {"npcs": [...]}，lines 无 voiceUrl → 全量合成。
            state_npcs = out.get("npcs") or {}
            state_list = (state_npcs.get("npcs") if isinstance(state_npcs, dict)
                          else state_npcs if isinstance(state_npcs, list) else []) or []
            for n in state_list:
                if not isinstance(n, dict):
                    continue
                lines = []
                for l in n.get("lines") or []:
                    if not isinstance(l, dict):
                        continue
                    lines.append({"id": l.get("id"), "text": l.get("text") or "",
                                  "voiceUrl": "", "duration": 0})
                npcs.append({"id": n.get("id"), "voice_id": n.get("voice_id") or "", "lines": lines})
        if not npcs:
            return {"status": "ERROR",
                    "error": "npc_voice 基线缺失：库与状态中均无 NPC 草稿。"
                             "请先跑 S1（npc_setting）生成 NPC 设定。"}

        # 展开为单句合成任务清单
        tasks: list[dict] = []
        for npc in npcs:
            voice_id = npc.get("voice_id") or ""
            for line in npc.get("lines") or []:
                text = (line.get("text") or "").strip()
                if not text:
                    continue   # 空台词跳过（schema：text 必填非空）
                tasks.append({
                    "npc_id": npc.get("id"),
                    "voice_id": voice_id,
                    "line_id": line.get("id"),
                    "text": text,
                    "voice_hash": hashlib.sha256(f"{text}|{voice_id}".encode("utf-8")).hexdigest(),
                    "existing_voice_url": line.get("voiceUrl") or "",
                    "existing_duration": line.get("duration") or 0,
                })
        if not tasks:
            return {"status": "DRAFT_READY", "npcs": []}

        adapter = TtsVolcanoAdapter()

        def _do_synth(task: dict) -> tuple[dict, dict]:
            """单句合成（含缓存命中 + 重试）。失败不抛 —— 返回 error 字符串，不阻塞其他 line。"""
            # 哈希缓存：表内已有 voiceUrl ⇒ (text + voice_id) 未变 ⇒ 跳过（spec §7.5 一级缓存）。
            if task["existing_voice_url"]:
                return (task, {
                    "line_id": task["line_id"],
                    "voiceUrl": task["existing_voice_url"],
                    "duration": task["existing_duration"],
                    "audio_base64": "",
                    "voice_hash": task["voice_hash"],
                    "skipped": True,
                    "error": None,
                })
            try:
                audio_bytes, duration = self._synthesize_with_retry(
                    adapter, task["text"], task["voice_id"])
                return (task, {
                    "line_id": task["line_id"],
                    "voiceUrl": "",   # AI crew 不上传 OSS；admin 路由上传后回填
                    "duration": duration,
                    "audio_base64": _b64.b64encode(audio_bytes).decode("ascii"),
                    "voice_hash": task["voice_hash"],
                    "skipped": False,
                    "error": None,
                })
            except Exception as e:
                # 失败：该 line voiceUrl 留空，不阻塞其他 line（spec §7.6）
                logger.warning("npc_voice 合成失败 npc=%s line=%s: %s: %s",
                               task["npc_id"], task["line_id"], type(e).__name__, e)
                return (task, {
                    "line_id": task["line_id"],
                    "voiceUrl": "",
                    "duration": 0,
                    "audio_base64": "",
                    "voice_hash": task["voice_hash"],
                    "skipped": False,
                    "error": f"{type(e).__name__}: {e}",
                })

        # 并发限 5（spec §7.7）—— 用线程池而非 asyncio：orchestrator 全同步（class docstring），
        # 且 TtsVolcanoAdapter.synthesize 是 requests.post 阻塞调用，线程池是自然匹配。
        results_by_npc: dict = {}
        with ThreadPoolExecutor(max_workers=self.TTS_CONCURRENCY) as pool:
            futures = {pool.submit(_do_synth, t): t for t in tasks}
            for fut in as_completed(futures):
                task, line_res = fut.result()
                results_by_npc.setdefault(task["npc_id"], []).append(line_res)

        # 按 NPC 聚合 + 保持 NPC 内 line 输入顺序
        npc_results = []
        for npc in npcs:
            npc_id = npc.get("id")
            line_results = results_by_npc.get(npc_id, [])
            line_order = {l.get("id"): i for i, l in enumerate(npc.get("lines") or [])}
            line_results.sort(key=lambda r: line_order.get(r["line_id"], 0))
            npc_results.append({"npc_id": npc_id, "lines": line_results})

        # 写 state 元数据（不含 audio_base64 —— 避免 Redis 膨胀；音频字节一次性经 HTTP 回传给 admin）
        out["npc_voice"] = {
            "npc_count": len(npc_results),
            "lines_total": sum(len(nr["lines"]) for nr in npc_results),
            "lines_skipped": sum(1 for nr in npc_results for l in nr["lines"] if l["skipped"]),
            "lines_failed": sum(1 for nr in npc_results for l in nr["lines"] if l["error"]),
        }
        self._set_state(project_id, "DRAFT_READY", out)
        return {"status": "DRAFT_READY", "npcs": npc_results}

    def run_refine(self, project_id: str, stage: str, instruction: str) -> Dict:
        """对某环节精修：重跑对应 agent（输入=已有草稿+精修指令），再跑校验。"""
        # stage ∈ world/storyline/characters/chapters/endings/location/level/visual/npc_setting/npc_optimize/npc_voice
        #       + character_optimize/ending_optimize/collectible_image/reward_batch（refine 阶段补充）
        # 基线来源（T11 起分叉）：
        #   · level / visual —— **先取 pms-server 库里的当前内容**（GET /products/:id/full），
        #     库里读不到才回落 Redis state。production 的权威草稿就是**库里当前的内容**
        #     （含创作台里的人工编辑），既不是 AI 当初产出的那一版，也不是 30 天 TTL 的 state：
        #     state 过期后老路直接拒答，而拿「AI 原始快照」当基线更糟 —— 用户的手工编辑不进 prompt，
        #     AI 产出的新 level 不含它们，而前端 applyLevel 是「删光旧子资源再按精修结果重建」，
        #     用户点一次「应用精修」就静默抹掉人工改动。
        #   · characters —— 同上（**库优先**）：基线=表内当前角色 + config 里的剧本上下文。
        #     存量剧本的 Redis state 已过 30 天 TTL，只走 state 必被「基线缺失」守卫拒答，
        #     而那正是本 stage 的主要用途（给存量剧本补角色）。
        #   · 其余 5 个（world/storyline/chapters/endings/location）—— 仍只从 state 取，
        #     界面不开放精修入口，故未接 DB。
        #   · npc_voice（T24 S3）—— 不走 LLM agent，逐句调 TTS API；分支到 _run_npc_voice_stage。
        state = self._get_state(project_id)
        out = state.get("output", {})
        if stage == "npc_voice":
            # S3 旁白 TTS：非 LLM stage，独立分支（不用 _run_agent / schema / agent 三件套）
            return self._run_npc_voice_stage(project_id, out)
        if stage == "level":
            schema_cls = LevelDesign
            agent = level_designer_agent
            base = self._refine_baseline(project_id, stage, out)
        elif stage == "visual":
            schema_cls = VisualDesign
            agent = visual_designer_agent
            base = self._refine_baseline(project_id, stage, out)
        elif stage == "npc_setting":
            schema_cls = WenlvNpcs
            agent = npc_designer_agent
            base = self._refine_baseline(project_id, stage, out)
        elif stage == "npc_optimize":
            schema_cls = WenlvNpcs
            agent = npc_designer_agent
            base = self._refine_baseline(project_id, "npc_setting", out)
            if not base:
                return {"status": "ERROR", "error": "精修基线缺失：无法优化 NPC。"}
            step_desc = (
                f"剧本上下文：{json.dumps(base, ensure_ascii=False)}\n"
                f"精修指令：{instruction}\n"
                f"请根据以上剧本上下文，对指令中指定的单个 NPC 做全字段重生（含 persona 和 relationships），"
                f"输出 npcs JSON（只含这一个 NPC）。"
            )
            refined = self._run_agent(agent, step_desc, "npc_setting JSON", WenlvNpcs)
            out["npcs"] = refined
            self._set_state(project_id, "DRAFT_READY", out)
            return {"status": "DRAFT_READY", "output": out}
        elif stage == "character_optimize":
            # 单角色优化（板块1）：基线 = characters + 剧本上下文
            schema_cls = Characters
            agent = character_designer_agent
            base = self._refine_baseline(project_id, "characters", out)
            if not base:
                return {"status": "ERROR", "error": "精修基线缺失：无法优化角色（characters 表为空）。"}
            # instruction 期望含 {character_id, name, identity, ip_prompt}（前端传入）
            step_desc = (
                f"剧本上下文：{json.dumps(base, ensure_ascii=False)}\n"
                f"已有角色列表：{json.dumps(base.get('characters', []), ensure_ascii=False)}\n"
                f"精修指令：{instruction}\n"
                f"请对指令中指定的单个角色做全字段重生，输出 characters JSON（只含这一个角色）。"
            )
            refined = self._run_agent(agent, step_desc, "characters JSON", Characters)
            out.setdefault("script", {})["characters"] = refined
            self._set_state(project_id, "DRAFT_READY", out)
            return {"status": "DRAFT_READY", "output": out}
        elif stage == "ending_optimize":
            # 单结局优化（板块5）：基线 = script.endings（剧本6步之一，存于 state.script.endings，与 world/storyline/chapters 同款；
            #                              不走 _refine_baseline_from_db，因 endings 在该函数无显式分支）
            agent = ending_designer_agent
            base = out.get("script", {}).get("endings", {})
            if not base:
                return {"status": "ERROR", "error": "精修基线缺失：无法优化结局（endings 草稿为空，state.script.endings 不存在）。"}
            # 注：Endings schema（LenientModel, extra="ignore"）会丢弃 ending_image_prompt 字段。
            # 这里不调 _run_agent（它只返回 schema-validated dict），自己跑 LLM + 解析 raw 保留 ending_image_prompt。
            step_desc = (
                f"剧本上下文：{json.dumps(base, ensure_ascii=False)}\n"
                f"已有节点/线索库（如有）：{json.dumps(out.get('level', {}).get('nodes', []) + out.get('level', {}).get('collectibles', []), ensure_ascii=False)}\n"
                f"精修指令：{instruction}\n"
                f"请对指令中指定的单个结局做全字段重生（含 ending_image_prompt 字段），输出 endings JSON（只含这一个结局）。"
            )
            task = Task(description=step_desc, expected_output="endings JSON", agent=agent)
            crew = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=True)
            result = crew.kickoff()
            raw = str(result.raw) if hasattr(result, "raw") else str(result)
            try:
                parsed = _parse_json(raw)
            except Exception as e:
                return {"status": "ERROR", "error": f"ending_optimize LLM 输出 JSON 解析失败: {e}"}
            # 提取 endings 数组的第一个（含 ending_image_prompt，未在 Endings schema 声明）
            endings_arr = parsed.get("endings", []) if isinstance(parsed, dict) else []
            if not isinstance(endings_arr, list) or not endings_arr:
                return {"status": "ERROR", "error": "ending_optimize LLM 输出无 endings 数组"}
            ending_raw = endings_arr[0] if isinstance(endings_arr[0], dict) else {}
            # 用 Endings schema 校验（丢弃 ending_image_prompt），同时单独提取 ending_image_prompt
            try:
                refined = Endings(**{"endings": [ending_raw]}).model_dump()
            except Exception as e:
                return {"status": "ERROR", "error": f"ending_optimize schema 校验失败: {e}"}
            ending_image_prompt = ending_raw.get("ending_image_prompt")
            out.setdefault("script", {})["endings"] = refined
            self._set_state(project_id, "DRAFT_READY", out)
            return {"status": "DRAFT_READY", "output": out, "ending_image_prompt": ending_image_prompt}
        elif stage == "collectible_image":
            # 线索图鉴图生成（板块4）：不需要基线
            schema_cls = CollectibleImagePrompt
            agent = collectible_image_agent
            step_desc = (
                f"生成指令：{instruction}\n"
                f"请根据线索元信息生成图鉴图文生图 prompt，输出 CollectibleImagePrompt JSON。"
            )
            refined = self._run_agent(agent, step_desc, "CollectibleImagePrompt JSON", CollectibleImagePrompt)
            self._set_state(project_id, "DRAFT_READY", out)
            return {"status": "DRAFT_READY", "image_prompt": refined}
        elif stage == "reward_batch":
            # 批量奖励生成（板块6）：基线 = level（rewards 上下文）
            schema_cls = WenlvRewards
            agent = reward_designer_agent
            base = self._refine_baseline(project_id, "level", out)
            if not base:
                return {"status": "ERROR", "error": "生成奖励基线缺失：无法基于空草稿生成奖励。"}
            step_desc = (
                f"剧本上下文：{json.dumps(base, ensure_ascii=False)}\n"
                f"生成指令：{instruction}\n"
                f"请批量生成 3-5 个奖励，输出 WenlvRewards JSON。"
            )
            refined = self._run_agent(agent, step_desc, "WenlvRewards JSON", WenlvRewards)
            self._set_state(project_id, "DRAFT_READY", out)
            return {"status": "DRAFT_READY", "rewards": refined}
        elif stage == "skeleton_generate":
            # 剧情骨架生成：基线 = level（剧本完整上下文）
            from src.schemas.wenlv_creation import WenlvPlotSkeleton
            from src.agents.wenlv_creation import skeleton_designer_agent
            schema_cls = WenlvPlotSkeleton
            agent = skeleton_designer_agent
            base = self._refine_baseline(project_id, "level", out)
            if not base:
                return {"status": "ERROR", "error": "生成骨架基线缺失：无法基于空草稿生成剧情骨架。"}
            step_desc = (
                f"剧本上下文：{json.dumps(base, ensure_ascii=False)}\n"
                f"生成指令：{instruction}\n"
                f"请生成剧情骨架（有向图），输出 WenlvPlotSkeleton JSON。"
            )
            refined = self._run_agent(agent, step_desc, "WenlvPlotSkeleton JSON", WenlvPlotSkeleton)
            self._set_state(project_id, "DRAFT_READY", out)
            return {"status": "DRAFT_READY", "skeleton": refined}
        elif stage == "characters":
            # 基线**库优先**（T12）。要点：剧本上下文（world/storyline/chapters/endings/location）
            # 从基线里的同名键注入 —— world_setting/storyline 来自 config 快照（另 3 键仓库内无已知写入者），不是 state
            #（存量剧本的 state 早已过期）。
            schema_cls = Characters
            agent = SCRIPT_AGENTS[[s[0] for s in SCRIPT_STEPS].index("characters")]
            base = self._refine_baseline(project_id, stage, out)
        elif stage in dict(SCRIPT_STEPS):
            # 其余 5 个（world/storyline/chapters/endings/location）界面不开放精修入口，故未接 DB。
            idx = [s[0] for s in SCRIPT_STEPS].index(stage)
            schema_cls = SCRIPT_STEPS[idx][1]
            agent = SCRIPT_AGENTS[idx]
            base = out.get("script", {}).get(stage, {})
        else:
            return {"status": "ERROR", "error": f"未知精修环节 {stage}"}
        if not base:
            # 基线缺失（库里没有、Redis 状态过期/被清空，或产品非 AI 创建）时必须拒绝：
            # 否则 agent 会基于空草稿「从零生成」，而前端 applyLevel 是
            # 「删光旧子资源再按精修结果重建」—— 用户点一次「应用精修」就静默丢光内容。
            # 宁可报错，也不能把「精修」偷偷变成「覆盖」。
            return {"status": "ERROR",
                    "error": f"精修基线缺失：库与状态中均无 {stage} 草稿（可能状态已过期，或该产品非 AI 创建）。"
                             f"已拒绝精修，以免基于空草稿重生成后整体替换现有内容。"}
        # P1-A：npc_setting 基线现带 characters + 5 个剧本上下文键（见 build_npcs_from_product_full）。
        # characters 分支没显式说明（base 直接 dump 进 prompt）—— npc_setting 率先做对，但保持同款风格
        # （一句话 prompt、不引入新结构），让 LLM 知道这些键的用途，避免把 characters 误当成 NPC 候选、
        # 把 character_id 编造成不存在的 id、NPC 名与角色名重复。
        if stage == "npc_setting":
            step_desc = (
                f"已有草稿：{json.dumps(base, ensure_ascii=False)}\n"
                f"其中 characters 是基线角色（选角卡），npcs 是已有 NPC（可为空）。\n"
                f"world_setting/storyline/chapters/endings/location 是剧本上下文，请参考以避免重名、合理设置 character_id。\n"
                f"精修指令：{instruction}\n输出更新后的 {stage} JSON。"
            )
        else:
            step_desc = (
                f"已有草稿：{json.dumps(base, ensure_ascii=False)}\n"
                f"精修指令：{instruction}\n输出更新后的 {stage} JSON."
            )
        refined = self._run_agent(
            agent,
            step_desc,
            f"{stage} JSON", schema_cls,
        )
        if stage == "characters":
            # ⚠️ 只写 state 的 script.characters（= 「AI 出稿快照」，与 config.characters 同义），
            #    **不写表**。表由前端「应用精修」经 admin 路由写（与 level 同款分工：
            #    AI 出稿、人确认、前端落库）。直接写表会让「应用」这个确认动作形同虚设。
            out.setdefault("script", {})[stage] = refined
        elif stage == "level":
            out["level"] = refined
        elif stage == "visual":
            out["visual"] = refined
        elif stage == "npc_setting":
            out["npcs"] = refined
        else:
            out.setdefault("script", {})[stage] = refined
        self._set_state(project_id, "DRAFT_READY", out)
        return {"status": "DRAFT_READY", "output": out}
