"""文化素材 AI 补充：拼检索词 → 联网检索（一次）→ 组装 → 判定是否算数。

**为什么判定不交给 LLM**：界面上那句「公网未查到与该素材相关的独立来源」是这个
功能的可信度承重点。判定权在代码里（`decide_found`，规则是「有内容 **且** 有来源」），
模型就**没有**无来源地说「查到了」的可能。

⚠️ **「有来源」指的是「被模型点名引用的来源」**（`pick_used_sources` 收窄之后），
不是「检索回来了一堆来源」。这个区分是 2026-09-23 修第二个线上缺陷时补上的：
检索常回一堆与素材**无关**的结果，把它们当凭证等于替模型宣称「这些都支撑了这段话」。
模型点名的动作在组装步契约里（`used_sources` 字段），判定仍然在代码里。

**为什么检索不参与重试**：`WenlvCreationOrchestrator._run_agent(retries=N)` 会把整个
task 重跑。检索若包在里面，每次重试都是一次真实计费 ⇒ 本模块把检索与组装拆成两步，
检索只调一次（`SearchCultureInfo._run`），组装步自己重试。

设计依据：docs/superpowers/specs/2026-09-23-wenlv-material-collect-assist-design.md §4.4。
"""
import logging
from typing import Dict, List, Optional

from src.config import AI_MATERIAL_OPTIMIZE_DAILY_LIMIT

logger = logging.getLogger(__name__)

# 与服务端 `WENLV_MATERIAL_TYPES` 同集。
#
# ⚠️ 这六个值（及六个中文标签）在本仓还有**多处独立副本**。2026-09-23 实测**代码级 5 处**：
#   ① `pms-server/src/db/schema/wenlv.ts` 的 `WENLV_MATERIAL_TYPES` —— 真相源
#   ② `pms-server/src/routes/admin/wenlv.ts` 的 `materialTypeSchema` —— 手写 `z.enum([...])`
#      字面量；它**自己的注释**也写着「与 WENLV_MATERIAL_TYPES 必须一致」
#   ③ `pms-platform/pms-ops-app/src/lib/labels.ts` 的 `MATERIAL_TYPES` + `MATERIAL_TYPE_LABEL`
#   ④ `pms-platform/pms-wenlv-survey/src/api.js` 的 `MATERIAL_TYPES` + `MATERIAL_TYPE_LABEL`
#   ⑤ `pms-platform/pms-wenlv-web/src/lib/wenlv-venue-types.ts` 的 `WENLV_MATERIAL_TYPES` + `MATERIAL_TYPE_LABEL`
#  另有一处**散文式**（只列 5 类、缺「其他」）：本包 `src/tools/external_tools.py` 里检索工具的 `description`。
#
# 🔴 **上面这份清单不是穷举，而且它已经腐化过一次** —— 初稿写「三处」，订正成「四处」时
#   仍漏了 ④⑤。改枚举时**别照抄清单**，用命令重数（只搜**声明行**，且按符号搜，
#   避免把六个值以字面量搬进本文件）。
#
# 🔴 **用 ripgrep（`rg`）数，别用 `grep -r`** —— `grep` 的代价由**整棵非 node_modules 树**
#   决定（2026-09-23 实测遍历面 14458 个 *.ts/*.js/*.py，其中 `.next`/`dist` 构建产物只占
#   2288 ⇒ **剪 `--exclude-dir` 救不了它**：热缓存下 1s，冷缓存/高负载下同一条命令实测超过
#   120s）。带超时的环境里它会被杀掉，而「被 timeout 杀掉的 grep」看起来与「0 命中」一模一样
#   （本仓有前科）。`rg` 默认跳过隐藏目录与 `.git`、并遵守 `.gitignore`（`.next`/`dist` 都在
#   `.gitignore` 里，已实测确认）⇒ 代价不随构建产物增长。两者**匹配集合与行号**相同
#   （**路径渲染形式不同**：本机 Git Bash 下 rg 打 \.pms-platform-...、grep 打 ./pms-platform/... ⇒ 拿两份原始输出直接 diff 是**非空**的，别据此判「命令不等价」）：
#     rg -n --no-heading -e '(WENLV_)?MATERIAL_TYPES[[:space:]]*=|MATERIAL_TYPE_LABEL[[:space:]]*[:=]|materialTypeSchema[[:space:]]*=' -g '*.ts' -g '*.js' -g '*.py' .
#   （2026-09-23 实测：8 行 / 5 个文件，即上面 ①~⑤。读数会随代码腐化，**以你跑出来的为准**。）
#   （若本机没有 `rg`：装一个（`scoop install ripgrep` / `winget install BurntSushi.ripgrep.MSVC`）。
#   **别退回 `grep -r`** —— 它的超时风险就是上面那条。）
#   跨包**没有任何同步闸**（本片不加，超出范围）；包内只有各包测试里的字面量锁
#   （如 `pms-ops-app/src/lib/__tests__/labels.test.ts`），锁不住跨包漂移。
MATERIAL_TYPE_CN = {
    "history": "历史沿革",
    "legend": "民间传说",
    "craft": "非遗技艺",
    "festival": "民俗节庆",
    "dialect": "方言俚语",
    "other": "其他",
}

# 整理态的如实告知。**这句由代码拥有**，不使用模型的 note（与 `decide_found` 同一原则：
# 它告诉采集员「这不是从公网抄来的」，是可信度承重点，模型没有义务说它、也无法保证说得对）。
# 🔴 它**取代**了原先的 `NO_SOURCE_NOTE`。已核（2026-09-23）：旧常量全仓只有
#    本模块两处 + 测试一处引用，替换是安全的。
ORGANIZED_NOTE = "公网未查到你这条素材的独立来源；这段只整理了你的记录，没有新增内容。"

# 「公网没查到 + 采集员自己也没写记录」时的如实告知（2026-09-24）。
# 同样**由代码拥有**，理由与 `ORGANIZED_NOTE` 一致。
# 🔴 本串在 ops-app 的 `reasonMessage()` 里有一份**逐字副本**（跨服务两份，
#    同 `ORGANIZED_NOTE` 的既有惯例）——改这里就要改那里。
NO_SOURCE_NO_CONTENT_NOTE = (
    "公网没查到这条素材的资料，你也还没写现场记录 —— 没有可以整理的内容。"
    "补几句现场看到、听到的，或把标题写得更具体，再试一次。"
)

# 进检索词的正文上限。一次检索的输入实测已 4.5k~5.8k tokens，
# 长素材不截会把输入推得更高（钱与延迟都涨）。
_CONTENT_IN_QUERY_MAX = 300


def build_search_query(*, venue_name: str = "", city: str = "", point_name: str = "",
                       material_type: str = "", title: str = "",
                       content: str = "") -> str:
    """把表单上下文拼成一句检索词。

    返回空串 = **前置不足**（标题与内容都空）⇒ 调用方必须据此拒绝并如实回话，
    不要拿场地名硬查（那会查出整个场地的资料，与这条素材无关）。
    """
    t = (title or "").strip()
    c = (content or "").strip()
    if not t and not c:
        return ""

    where = "/".join(
        x for x in ((city or "").strip(), (venue_name or "").strip(), (point_name or "").strip()) if x
    )
    kind = MATERIAL_TYPE_CN.get((material_type or "").strip(), "")

    if where and t:
        subject = f"{where}的「{t}」"
    elif t:
        subject = f"「{t}」"
    else:
        subject = where

    line = "·".join(x for x in (kind, subject) if x)
    if c:
        line += (
            f"\n已知信息（采集员现场记录的一手材料，"
            f"**不要**把与之矛盾的说法写进答案）：{c[:_CONTENT_IN_QUERY_MAX]}"
        )
    return line + (
        "\n请联网查找该条目的公开资料（年代、沿革、涉及人物、文献出处、工艺工序等），"
        "只依据检索到的来源作答。"
    )


def normalize_sources(raw) -> List[Dict[str, str]]:
    """归一来源列表：丢非字典、丢空 url、按 url 去重、去空白。

    不接受「无 url 的来源」：来源列表是「这句话有出处」的凭证，
    没有可点开的地址就不是凭证（界面上的出处是可点的链接）。
    """
    if not isinstance(raw, list):
        return []
    out: List[Dict[str, str]] = []
    seen = set()
    for item in raw:
        if not isinstance(item, dict):
            continue
        url = str(item.get("url") or "").strip()
        if not url or url in seen:
            continue
        seen.add(url)
        out.append({
            "title": str(item.get("title") or "").strip(),
            "site_name": str(item.get("site_name") or "").strip(),
            "url": url,
        })
    return out


def numbered_sources(sources) -> str:
    """把来源列表渲染成带 **1-based 编号** 的清单，供组装步按编号引用。

    🔴 编号口径必须与 `pick_used_sources()` 的解析口径**同一套**（1 起、按列表顺序）：
    两处各写一份，模型照 A 报编号而代码按 B 取来源 —— 取到的是**别的**来源，
    而且**两条都报成功**（本仓有「跨跳丢参」同族前科）。所以两边都先过
    `normalize_sources()`，保证渲染与解析看到的是同一个列表。
    """
    items = normalize_sources(sources)
    lines = []
    for i, s in enumerate(items, start=1):
        site = f"【{s['site_name']}】" if s["site_name"] else ""
        lines.append(f"{i}. {site}{s['title'] or '（无标题）'} {s['url']}")
    return "\n".join(lines) or "（本次没有来源）"


def pick_used_sources(sources, used) -> List[Dict[str, str]]:
    """按模型点名的**1-based 编号**把来源收窄成「它真的引用了的那几条」。

    这是 2026-09-23 修第二个线上缺陷（序号匹配）的落点。为什么要收窄而不是信任全量
    `sources`：检索常回一堆**与这条素材无关**的来源，把它们全挂上去等于替模型宣称
    「这些都支撑了这段话」——前端会展示 10 条无关链接 + 一个「合并」动作。

    **fail-closed**：`used` 不是数组（含 key 缺失、None、字符串）⇒ 返回 `[]` ⇒ 下游
    `decide_found` 判 False ⇒ 走整理步。理由：模型没点名就等于没有凭证，
    「没点名」绝不能被读成「全用了」。越界编号、重复编号、非整数一律丢弃（不抛）。
    """
    items = normalize_sources(sources)
    if not isinstance(used, list):
        return []
    out: List[Dict[str, str]] = []
    picked = set()
    for raw in used:
        # `bool` 是 `int` 的子类 —— 不挡的话模型回 `true` 会被 int() 读成 1 号来源。
        if isinstance(raw, bool):
            continue
        try:
            n = int(raw)
        except (TypeError, ValueError):
            continue
        if n < 1 or n > len(items) or n in picked:
            continue
        picked.add(n)
        out.append(items[n - 1])
    return out


def decide_found(*, content: str, sources) -> bool:
    """判「公网到底查到没查到」。规则：**有内容 且 有至少一条来源**。

    🔴 这条规则是「不许编」的落点：模型给不出来源时，无论它写了多漂亮的内容，
    一律判未查到（调用方会把内容清空）。别为了「别白花钱」放宽它。

    ⚠️ 调用方必须传**收窄之后**的来源（`pick_used_sources` 的结果），不要把检索回来的
    全量 `sources` 直接喂进来 —— 那样「有来源」这一半就被检索结果的存在本身满足了，
    与模型有没有引用它无关（这正是第二个线上缺陷的形态）。
    """
    return bool((content or "").strip()) and bool(normalize_sources(sources))


# ---------- 每日配额 ----------

def _seconds_until_local_midnight(now=None) -> int:
    """到本地午夜的秒数，下限 60。

    🔴 下限 60 不是保险起见：`redis.expire(key, 0)` 会**立刻删掉 key** ——
    23:59:59 发起的那一次若算出 0 秒，当天计数会被当场清零 ⇒ 那一秒里配额无限。
    跨过午夜后 key 里仍写着旧日期，多活 60 秒无害。
    """
    from datetime import datetime, timedelta
    n = now or datetime.now()
    nxt = (n + timedelta(days=1)).replace(hour=0, minute=0, second=0, microsecond=0)
    return max(60, int((nxt - n).total_seconds()))


def quota_key(user_id: str, day: str) -> str:
    return f"wenlv:material-optimize:{user_id}:{day}"


def incr_and_check_quota(redis, user_id: str, *, limit: int, day: str) -> Dict:
    """先自增再判；超限则**回退**并拒绝。

    为什么「先自增」而不是「先读再写」：读-改-写在并发下会超发（两个请求同时
    读到 49、同时写 50，双双放行）。INCR 是原子的，所以放行次数至多 `limit`。

    为什么拒了要 DECR：否则被拒的那次也占一个计数 —— 采集员连点 5 下就把
    当天配额烧光。回退后计数稳定在 limit，语义是「已用满」。

    🔴 无 Redis 时 **fail-closed**：这是付费端点，配额是它唯一的闸，放行等于拆闸。
    """
    if redis is None:
        return {"allowed": False, "used": 0, "limit": limit, "reason": "quota_unavailable"}
    try:
        n = int(redis.incr(quota_key(user_id, day)))
        if n == 1:
            # TTL **到当天结束**（设计文档 §4.6）：跨天自然归零，不依赖定时任务。
            redis.expire(quota_key(user_id, day), _seconds_until_local_midnight())
        if n > limit:
            redis.decr(quota_key(user_id, day))
            return {"allowed": False, "used": limit, "limit": limit, "reason": "quota_exceeded"}
        return {"allowed": True, "used": n, "limit": limit, "reason": ""}
    except Exception:
        # 计数本身出错也 fail-closed（同原因）
        return {"allowed": False, "used": 0, "limit": limit, "reason": "quota_unavailable"}


def release_quota(redis, user_id: str, day: str) -> None:
    """退还一次（DECR）—— 用于**「没查完」**的失败路径。

    设计依据：设计文档 §5 的逐态表。表里「请求超时」一行写明「**不扣一次配额**
    （配额只在拿到 200 时计）」，而「组装环节失败」一行写的是「**同上按「没查完」处理**」
    ⇒ 组装失败也退还。所以本函数在两类路径上被调用：`search_failed`、`assemble_failed`。

    🔴 **不退还的两种**（别顺手加）：
    - `no_source_organized`（检索成功但公网没资料 ⇒ 出整理稿）：那次 DashScope 检索**是真花了钱的**，
      整理步本身也真跑了一次 LLM（D7）；
    - 成功：显然。
    这条分界有对照用例（`test_optimize_no_source_keeps_quota`）——
    少了它，退还逻辑写宽成「任何非成功都退还」也全绿。

    ⚠️ **已知残余**：BFF 侧的 60s 超时 ai-crew **感知不到**（请求还在跑，终态未知），
    所以那一种「没查完」仍会计一次 —— 本函数复不到那条路径。**有意不修**（别读成遗漏）：
    要对账就得引入跨层的状态查询或幂等键，超出本模块范围；代价有上界（超时是少数路径，
    且每次对应一次真实产出前的失败）。如实记账。
    """
    if redis is None:
        return
    try:
        redis.decr(quota_key(user_id, day))
    except Exception as e:
        # 退还失败不能影响主流程（用户拿到的结果比这重要）
        logger.warning("配额退还失败（不影响主流程）: user_id=%s day=%s err=%s", user_id, day, e)


def today_key() -> str:
    """本地日期的 YYYYMMDD。用本地时间而不是 UTC：配额的语义是「今天」，
    对采集员而言「今天」是他手表上的今天。"""
    from datetime import datetime
    return datetime.now().strftime("%Y%m%d")


# ---------- 编排 ----------

# 组装步重试上限（首发 + 1 次重跑）。
# 🔴 重试**只在这一层**：`_default_assemble` 把它交给 `_run_agent`，外层
# `optimize_material` 捕获异常后**不再重试** —— 两层都拉满是乘法（3 × 3 次真实
# LLM 调用），而且外层加循环会让**检索**跟着重跑（每次都是真实计费）。
_ASSEMBLE_RETRIES = 1


def _default_search(query: str) -> Dict:
    """生产检索实现：唯一的检索原语。**刻意不注册进 ToolRegistry** ——
    见 src/tools/external_tools.py 里 SearchCultureInfo 的类注释。"""
    from src.tools.external_tools import SearchCultureInfo
    return SearchCultureInfo()._run(query=query)


def _default_assemble(payload: Dict, answer: str, sources: List[Dict[str, str]]) -> Dict:
    """生产组装实现：把「检索结果」当**给定输入**塞进 task，让 agent 只做整理。

    🔴 检索结果在这里是**参数**，不是 agent 自己去取的 —— 这正是「检索不参与重试」
    的落实方式：`_run_agent` 重跑时重跑的只有这一步（纯文本 → JSON，便宜且快），
    检索不会跟着重跑。
    """
    from src.agents.wenlv_creation.material_assist import material_assist_agent
    from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator
    from src.schemas.wenlv_material_assist import MaterialOptimizeResult

    desc = (
        f"素材类型：{MATERIAL_TYPE_CN.get(payload.get('material_type') or '', '未指定')}\n"
        f"标题：{(payload.get('title') or '').strip()}\n"
        f"采集员现场记录（一手材料，优先保留）：{(payload.get('content') or '').strip()}\n"
        f"所在场地：{(payload.get('city') or '').strip()}"
        f"{(payload.get('venue_name') or '').strip()}"
        f"{(payload.get('point_name') or '').strip()}\n\n"
        f"联网检索到的资料（**只能用这里出现的事实**）：\n{answer}\n\n"
        f"检索到的来源列表（**引用时按下面的编号**）：\n{numbered_sources(sources)}\n\n"
        f"输出 material_optimize JSON。\n"
        f"🔴 `used_sources` **只列你在 content 里真的引用了其内容的编号**（如 [1,3]）；\n"
        f"   检索结果与这条素材无关时，给 **[]** 并且 content 也给空串 —— "
        f"不要为了凑数把没用到的编号写进来。"
    )
    orch = WenlvCreationOrchestrator(None)   # 不落 Redis 状态：本流程没有 project_id
    return orch._run_agent(
        material_assist_agent, desc, "material_optimize JSON",
        MaterialOptimizeResult, retries=_ASSEMBLE_RETRIES,
    )


def _default_organize(payload: Dict) -> Dict:
    """生产整理实现：**不喂检索结果**（设计文档 §4.1 的分支图 / D3）。

    🔴 与 `_default_assemble` 的功能差别**只有一样**，但那一样就是全部：
    这个 task 里**既没有**「联网检索到的资料」，**也没有**来源列表 ——
    连参数都没有（`answer` / `sources` 都不在签名里，见
    `test_default_organize_takes_no_search_result`）。

    为什么把这当承重设计：整理态**不标出处**，采集员无从分辨哪一句是新的。
    一旦把检索结果塞进来，模型会把公网那点未必相关的资料当成依据，
    产出**看起来有出处**的内容 —— 而 D3 的「不新增事实」**没有代码闸**，
    这个签名是它唯一一层工程保障。

    🔴产出契约用 `MaterialOrganizeResult`（**不是**组装步那个类）：整理步没有来源可引用，
    把 `used_sources` 挂上来只会给这条**必经兜底路径**新增一个合规面。别为「省一个类」合并
    —— 见 `src/schemas/wenlv_material_assist.py` 头注的 🔴。
    """
    from src.agents.wenlv_creation.material_assist import material_assist_agent
    from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator
    from src.schemas.wenlv_material_assist import MaterialOrganizeResult

    desc = (
        f"素材类型：{MATERIAL_TYPE_CN.get(payload.get('material_type') or '', '未指定')}\n"
        f"标题：{(payload.get('title') or '').strip()}\n"
        f"采集员现场记录（一手材料，**只能整理它**）：{(payload.get('content') or '').strip()}\n"
        f"所在场地：{(payload.get('city') or '').strip()}"
        f"{(payload.get('venue_name') or '').strip()}"
        f"{(payload.get('point_name') or '').strip()}\n\n"
        f"**本次没有任何联网资料。** 只做这几件事：把口语理顺、把重复的合并、"
        f"把明显的错别字改掉、把散乱的句子按时间或工序顺序排好。\n"
        f"🔴 **不得**补充年代、人名、地名、数字、事件、工序、书名 —— 原稿里没有的信息一个都不许出现。\n"
        f"🔴 **不得**添加「参考资料」「来源」「据……」这类出处标记。\n"
        f"整理后的信息量**只许变少或持平，不许变多**。\n\n"
        f"输出 material_optimize JSON（**只要 content 与 note 两个字段**）。"
    )
    orch = WenlvCreationOrchestrator(None)   # 不落 Redis 状态：本流程没有 project_id
    return orch._run_agent(
        material_assist_agent, desc, "material_optimize JSON",
        MaterialOrganizeResult, retries=_ASSEMBLE_RETRIES,
    )


def optimize_material(payload: Dict, *, redis=None,
                      search_fn=_default_search, assemble_fn=_default_assemble,
                      organize_fn=_default_organize,
                      limit: Optional[int] = None, day: Optional[str] = None) -> Dict:
    """文化素材 AI 补充（同步，外层经 asyncio.to_thread 包裹）。

    `search_fn` / `assemble_fn` / `organize_fn` 是**测试注入点**，默认值即生产实现。
    🔴 默认值必须是**真的默认值**，不能写成 `=None` 再在函数体里 `or` 兜底 ——
    `test_optimize_default_fns_are_production_implementations` 断言的就是
    `inspect.signature(optimize_material).parameters["search_fn"].default is not None`；
    写成 `None` 那条恒假（`None is not None` 为 False），而「函数体里 `or` 兜底」
    在**行为上完全正确**、只是不满足这条签名断言 —— 改测试去迁就签名会把
    「默认值即生产实现」这条契约一起改掉，所以改的是签名。
    （`_default_search` / `_default_assemble` / `_default_organize` 定义在本函数**之前**，
    可以直接当默认值。）

    ⚠️ **注入 `organize_fn` 不是可选的**：公网查不到时会走整理步，不注入就会去调**真 LLM**。

    返回的 `reason` 是**稳定分类码**（ok / **no_source_organized** / **no_source_no_content** /
    insufficient_input / quota_exceeded / quota_unavailable / search_failed / assemble_failed），
    前端按它兜底文案；`note` 是可直接展示的中文句子。

    🔴 **`ok` 与 `no_source_organized` 的 `content` 都是有内容的**，语义完全不同：
      - `ok`                   ⇒ `found=True`，**公网补充稿**，`sources` 非空，带出处；
      - `no_source_organized`  ⇒ `found=False`，**整理稿**，`sources` 恒为 `[]`，无出处。
    ⚠️ `ok` 的 `sources` 是**模型点名引用的那几条**（`pick_used_sources` 收窄后），
    **不是**检索回来的全量 —— 附件列表要能一条条对上正文，别把「查到过」当「引用过」。
    前端**按 `reason` 判别**，不要用 `found` —— `found` 的语义是「公网找到了吗」，
    拿它推「内容是什么性质」是「恰好等价」式前提（设计文档 §1.2）。
    """
    limit = AI_MATERIAL_OPTIMIZE_DAILY_LIMIT if limit is None else limit
    day = day or today_key()

    out = {"found": False, "content": "", "sources": [], "note": "", "reason": "ok"}

    query = build_search_query(
        venue_name=payload.get("venue_name") or "",
        city=payload.get("city") or "",
        point_name=payload.get("point_name") or "",
        material_type=payload.get("material_type") or "",
        title=payload.get("title") or "",
        content=payload.get("content") or "",
    )
    if not query:
        out["reason"] = "insufficient_input"
        out["note"] = "标题和内容至少填一个，AI 才有东西可查。"
        return out

    user_id = str(payload.get("user_id") or "").strip() or "anonymous"
    quota = incr_and_check_quota(redis, user_id, limit=limit, day=day)
    if not quota["allowed"]:
        out["reason"] = quota["reason"]
        out["used"] = quota["used"]
        out["limit"] = quota["limit"]
        out["note"] = ("今天的 AI 补充次数已用完，明天再来。"
                       if quota["reason"] == "quota_exceeded"
                       else "AI 补充暂时不可用，请稍后再试。")
        return out

    # ① 检索：**只调一次**，不参与重试（设计文档 §4.4）
    search = search_fn(query)
    if not isinstance(search, dict) or not search.get("ok"):
        release_quota(redis, user_id, day)   # 「没查完」⇒ 退还（设计文档 §5）
        out["reason"] = "search_failed"
        out["note"] = "联网检索没成功，请稍后再试。"
        return out

    sources = normalize_sources(search.get("sources"))

    # ② 有来源 ⇒ 组装步（喂检索结果，可重试）
    if sources:
        try:
            assembled = assemble_fn(payload, str(search.get("answer") or ""), sources)
        except Exception:
            release_quota(redis, user_id, day)   # §5「同上按『没查完』处理」⇒ 也退还
            out["reason"] = "assemble_failed"
            out["note"] = "资料整理没成功，请稍后再试。"
            return out

        content = str((assembled or {}).get("content") or "").strip()
        raw_used = (assembled or {}).get("used_sources")
        if raw_used is None:
            # 正常路径**进不来这里**：契约里 `used_sources` 是必填，缺了先由 pydantic 报错、
            # 再由 `_run_agent` 带错误清单重跑兜住。这条只在**有人给它加上默认值**之后才会出现，
            # 而那天正是「漏写」与「判定无关」被混成同一个结果的那天 —— 留一条可查的痕迹。
            logger.warning("组装步产出缺 used_sources（契约本应保证其存在），按「未引用」处理")
        used = pick_used_sources(sources, raw_used)
        # 🔴 `decide_found` **仍然**是这一态的判据（有内容 且 有来源），别删。
        # ⚠️ 喂进去的必须是**收窄后**的 `used`，不是全量 `sources` —— 否则「有来源」这一半
        #    由检索结果的存在本身满足，与模型有没有引用它无关（这正是第二个线上缺陷的形态）。
        if decide_found(content=content, sources=used):
            out["found"] = True
            out["content"] = content
            out["sources"] = used
            out["note"] = str((assembled or {}).get("note") or "").strip()
            out["used"] = quota["used"]
            out["limit"] = quota["limit"]
            return out
        # 组装步跑通了但给不出内容、**或一条来源都没点名** ⇒ **掉到整理步**。
        # 这不是故障，是「公网那点资料对不上这条素材」（设计文档 §5 把这两行**分开列**）。

    # ③ 整理步：**不喂检索结果**（D2 / D3）—— 连参数都没有
    #
    # 🔴 **内容为空 ⇒ 不进整理步**（2026-09-24：入口门槛放宽成「标题或内容至少一个」
    #    之后带出的**新可达组合**，见 `test_optimize_title_only_and_no_source_skips_organize`）。
    #    整理步唯一的输入就是 `content`（`_default_organize` 里「只能整理它」），
    #    空输入下 `MaterialOrganizeResult.content` 仍必填 ⇒ 模型**必须**吐点什么，
    #    而这一态的对外文案写死了「只整理了你的记录，没有新增内容」——
    #    模型一旦补了年代/人名，那句话就把**编造**冒充成采集员的一手材料。
    #    ⚠️ 也**不能**让它落进下面那条空白分支（报「资料整理没成功」）：什么都没坏，
    #    那是**假故障**，还会请采集员白重试一次并再扣一次配额。
    #    ⚠️ 判据用**原始入参**的 content，不是组装步的产出 —— 掉到这里时说明
    #    「公网那点资料对不上这条素材」，此刻采集员若自己写了记录，整理它仍然有价值。
    if not str(payload.get("content") or "").strip():
        out["reason"] = "no_source_no_content"
        out["note"] = NO_SOURCE_NO_CONTENT_NOTE
        # ⚠️ **不退配额**（与 `no_source_organized` 同口径，D7）：检索 200 了，钱真花了。
        out["used"] = quota["used"]
        out["limit"] = quota["limit"]
        return out

    try:
        organized = organize_fn(payload)
    except Exception:
        # D4：我们**自己**坏了 ⇒ 不出整理稿
        release_quota(redis, user_id, day)
        out["reason"] = "assemble_failed"
        out["note"] = "资料整理没成功，请稍后再试。"
        return out

    content = str((organized or {}).get("content") or "").strip()
    if not content:
        # 整理步跑通了但产出空白 ⇒ 同上（我们没拿回东西，不该扣钱）
        release_quota(redis, user_id, day)
        out["reason"] = "assemble_failed"
        out["note"] = "资料整理没成功，请稍后再试。"
        return out

    out["found"] = False
    out["content"] = content
    out["sources"] = []
    out["note"] = ORGANIZED_NOTE          # 代码拥有，不用模型的 note
    out["reason"] = "no_source_organized"
    # ⚠️ **不退配额**（D7）：检索 200 了 + 整理步也真跑了一次 LLM，两次都花了钱
    out["used"] = quota["used"]
    out["limit"] = quota["limit"]
    return out
