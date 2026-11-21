"""场地网络调研流水线：消歧 → 5 节串行检索成文 → 汇总。

分层与 `wenlv_material_assist.py` 逐字同款：**检索与 LLM 都经参数注入**（默认实现是
`_default_search` / `_default_*_agent`），于是全部流程逻辑都能用假函数测，不真调 LLM、不花钱。
"""
import logging
import re
import time
from typing import Dict, List, Optional, Tuple

logger = logging.getLogger(__name__)

# 一条正文条目最多挂几条来源。超出的丢弃（保留前 N 条）——
# 挂 20 条来源的条目在界面上是一屏链接，没人会看，而且它几乎必然包含凑数的。
SOURCE_COUNT_MAX = 5

# ── 联系信息抹除（设计文档 §6.3 第 4 条：网上来的电话/住址一律不落）──
# 只抹「手机号」这一种**形状固定**的：住址没有可靠形状，靠正则拦只会误伤地名，
# 它由提示词约束 + 人工在 verify 节复核。**不要**为了「更全」在这里加宽正则 ——
# 每加一条就要问「会不会把真实的地名/年代/门牌吃掉」。
_PHONE_RE = re.compile(r"(?<!\d)1[3-9]\d{9}(?!\d)")

SECTION_KEYS = ("history", "materials", "points", "people", "context")

# 每节的检索词模板。城市与场地名都带上：只给场地名时 DashScope 会大量命中同名异地。
_SECTION_QUERY = {
    "history": "{city}{name} 历史沿革 地名由来 建村",
    "materials": "{city}{name} 文化 非遗 传说 民俗 节庆 手工艺",
    "points": "{city}{name} 景点 古建筑 古井 古树 步道 打卡点",
    "people": "{city}{name} 人物 传承人 手艺人 村史 公开报道",
    "context": "{city}{name} 旅游开发 门票 交通 现状 负面 报道",
}


def section_query_hint(hint: Optional[str]) -> str:
    """用户手填的更精确地名（「都不是」那条逃生口）。空白 ⇒ 空串（调用方回落自动组词）。"""
    return (hint or "").strip()


def build_section_query(section: str, name: str, city: str, hint: str = "") -> str:
    """一节的一次检索词。hint 非空时**替换掉场地名**（用户比我们知道得更准）。"""
    tmpl = _SECTION_QUERY.get(section)
    if tmpl is None:
        raise ValueError(f"未知的调研节：{section}")
    nm = section_query_hint(hint) or (name or "").strip()
    ct = (city or "").strip()
    return tmpl.format(city=f"{ct} " if ct else "", name=nm).strip()


def number_sources(sources: List[Dict]) -> Tuple[str, List[Dict]]:
    """给检索结果编号（**从 1 起**），并就地按 URL 去重。

    返回 `(编号文本, 去重后的来源列表)`。编号文本喂给模型，它回的是编号数组，
    所以**编号顺序 = 去重后列表的顺序** —— 调用方必须用同一份列表去查 `sources[n-1]`。
    （同族先例：`wenlv_material_assist.py` 的 `numbered_sources`。）
    """
    uniq: List[Dict] = []
    seen = set()
    for s in sources or []:
        url = (s or {}).get("url") or ""
        if not url or url in seen:
            continue
        seen.add(url)
        uniq.append({"title": s.get("title") or "", "site_name": s.get("site_name") or "", "url": url})
    lines = [f"{i + 1}. {u['title']}（{u['site_name']}）" for i, u in enumerate(uniq)]
    return "\n".join(lines), uniq


def scrub_contact(text: str) -> str:
    """抹掉手机号。命中处替换成一句说明，**不静默删** —— 静默删会让读者以为原文没有。"""
    if not isinstance(text, str) or not text:
        return text if isinstance(text, str) else ""
    return _PHONE_RE.sub("（已隐去联系方式）", text)


def split_items_by_source(
    items: List[Dict], source_count: int
) -> Tuple[List[Dict], List[Dict], List[Dict]]:
    """按「有没有可用来源」分流：`(进正文, 进待核实, 无法展示)`。**设计文档 §6.3 第 1 条的闸。**

    规则（**逐字对齐设计文档 §6.3 第 1 条**）：
      1. `sources` 里**过滤掉越界编号**（> source_count 或 < 1）。越界编号意味着模型编了一个
         不存在的来源 —— 放行它，界面上的链接会是错的。
      2. 过滤后**非空** ⇒ 进正文（保留过滤后的编号，最多 SOURCE_COUNT_MAX 条）。
      3. 过滤后**为空** ⇒ 进 verify 并标注「AI 推断，无来源」。

    🔴 **规则 3 对「越界」与「空数组」一视同仁，这不是疏忽。**
    设计文档 §6.3 第 1 条的原文是「无来源的内容**不许进正文条目**，**只能进 `verify`**」
    —— 「只能」是排他的，且**全文没有任何「丢弃」条款**。两者的差别只是模型的错法不同
    （空数组 = 老实说没有；越界编号 = 记错了编号），**可展示性相同**，都该让业务人员在
    待核实清单里看见。丢掉它们是**静默的信息损失**：现场跑一趟的成本远高于核对一条待核实项。

    ⚠️ 本函数原先（计划 Task 5 Step 5）把「过滤后为空且 `inferred` 不为真」的条目**丢弃**，
    与它自己引用的设计文档相矛盾 —— 那次改成 verify 是**按规格订正**，见计划 Task 5 的完成记录。
    `inferred` 标志仍然有用：它决定 verify 条目的**措辞来源**（模型自认 vs 我们判定），
    但**不再决定去留** —— 「模型标没标」不该是一个内容能不能被看见的依据。

    第三个返回值现为「**结构上无法展示**的条目」（不是 dict，连标题都取不出来）。
    保留三元组是因为调用方（Task 7 的流水线）要记数；但它已不含任何「有内容但被丢掉」的条目。
    """
    kept: List[Dict] = []
    verify: List[Dict] = []
    unrenderable: List[Dict] = []
    for it in items or []:
        if not isinstance(it, dict):
            # 不是 dict ⇒ 连 title/content 都取不出，塞进 report 会让前端渲染出空白卡片。
            # 这是**结构性**不可展示，与「有没有来源」无关。
            unrenderable.append({"title": "", "content": "", "raw": it})
            logger.warning("调研条目不是对象，无法展示：%r", it)
            continue
        raw = it.get("sources")
        nums = raw if isinstance(raw, list) else []
        good = [n for n in nums if isinstance(n, int) and 1 <= n <= source_count]
        # 去重且保序：同一编号写两遍是模型常见的小错，不该让它占两个额度
        seen = set()
        good = [n for n in good if not (n in seen or seen.add(n))][:SOURCE_COUNT_MAX]
        if good:
            kept.append({**it, "sources": good})
        else:
            if not good and nums:
                logger.warning(
                    "调研条目的来源编号全部越界，已降级为待核实：title=%r sources=%r",
                    it.get("title"), raw,
                )
            verify.append({**it, "sources": [], "note": "AI 推断，无来源"})
    return kept, verify, unrenderable


def dedupe_items(items: List[Dict]) -> List[Dict]:
    """按标题**精确相等**去重，保留先出现的。

    **不做模糊匹配**（同族：`wenlv_persist.resolve_venue_point_id` 的「宁可不绑，不可绑错」）。
    模糊匹配在本场景的代价是**内容被静默丢弃** —— 而「同名的两条」在这里
    往往真的是两件事（两个村的古井），合了就是丢证据。
    """
    out: List[Dict] = []
    seen = set()
    for it in items or []:
        if not isinstance(it, dict):
            continue
        t = it.get("title")
        key = t if isinstance(t, str) else ""
        if key in seen:
            continue
        seen.add(key)
        out.append(it)
    return out


# ═══════════════════════════════════════════════════════════════════════════
# 编排：五节串行 → 逐节累积回写 → 汇总（**汇总无 LLM**，见 assemble_report）
# ═══════════════════════════════════════════════════════════════════════════

# 看门狗阈值（秒）。与 pms-server 的 `RESEARCH_STALE_MS`
# （`src/services/wenlv-research.ts`：`15 * 60 * 1000`）是**同一份约定的两份副本，
# 改一处必须改两处**（同族：reasonMessage 与 ORGANIZED_NOTE 的文案副本）。
# 🔴 本文件的用途只是**自检**：总耗时逼近它时打一条 warning，说明该调阈值或改设计。
# 判「能不能重跑」的是 pms-server 那份，**不是**这份。
WATCHDOG_NOTE = 15 * 60

# 每节的中文标题 —— 喂给 agent 的 task 里用它（`_SECTION_QUERY` 是检索词模板，
# 两者服务不同的一跳，别合并）。
_SECTION_CN = {
    "history": "历史沿革与地名由来",
    "materials": "文化素材（历史/传说/技艺/节庆/方言）",
    "points": "特殊点位（只给区位线索，不许给坐标）",
    "people": "人物与机构线索（只写公开身份，无联系方式）",
    "context": "现状与风险（是否已开发运营、门票、交通、负面报道）",
}


def _default_search(query: str) -> Dict:
    """生产检索实现。**唯一检索原语**，刻意不注册进 ToolRegistry（见 SearchCultureInfo 的类注释）。"""
    from src.tools.external_tools import SearchCultureInfo
    return SearchCultureInfo()._run(query=query)


def _default_section_agent(section: str, desc: str) -> Dict:
    """生产成文实现：把「检索结果」当**给定输入**塞进 task（检索不参与重试）。

    🔴 用 `WenlvCreationOrchestrator._run_agent` 复用既有的 JSON 校验重试 ——
    自己写一份 `crew.kickoff()` 会让「模型吐了坏 JSON」这条路径**丢掉重试**，
    而它正是 LLM 结构化输出最常见的失败（见 `_run_agent` 的 retries 注释）。

    ⚠️ 本函数内的 import 是**故意**的：`src.agents.*` 一 import 就会触发
    `src.config` 的 Redis 连接重试（2026-09-24 实测 **53.69s** + 一屏日志）。
    放到函数内，pytest 用假 agent 时才不会白等那一分钟。
    """
    from src.agents.wenlv_creation.venue_research import section_agent
    from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator
    from src.schemas.venue_research import SectionResult

    orch = WenlvCreationOrchestrator(None)      # 不落 Redis：本流程的状态由 pms-server 拥有
    title = _SECTION_CN.get(section, section)
    return orch._run_agent(
        section_agent,
        f"本次主题：{title}\n\n{desc}\n\n输出 section JSON。",
        "section JSON", SectionResult, retries=1,
    )


def assemble_report(section_reports: Dict[str, Dict]) -> Tuple[Dict, List[Dict]]:
    """汇总步（**纯代码，无 LLM**）：跨节去重 + 抽待核实清单。

    返回 `(report, verify_items)`。verify 收录三类：
      ① **无可用来源**的条目（`split_items_by_source` 已标注「AI 推断，无来源」；
         ⚠️ 含「`sources: []`」与「编号全部越界」两种，见该函数的注释）；
      ② **只有单一来源**的条目 —— 一个来源能立论，但不足以定论，正该现场核；
      ③ 检索被 10 秒预算**截断**的节里的全部条目（结果**不完整**，不是「查无结果」）。

    ② 与 ③ 的判定都在这里，因为它们要跨节信息（本节来源总数），单节内部判不了。
    ③ 用的 `truncated` 来自 `SearchCultureInfo._run` 的**返回值**——2026-09-24 之前
    那个方法只打 warning 日志、不返回该键，于是本条是**死代码**（恒不触发）且看不出来
    （键名对、值恒 None）。见 tests 里那条「截断的节」用例。

    ⚠️ **与设计文档 §7 的差集（如实记，别让下一个读者以为都做了）**：设计列的四类
    verify 收录是「只有单一来源的 / **来源互相矛盾的** / AI 拿不准的 / 需要现场量或拍的」。
      · 「只有单一来源的」= ② ✓；「AI 拿不准的」≈ ①（无来源/自认推断）✓；
      · 🔴 **「来源互相矛盾的」没有实现** —— 判两段资料是否互相矛盾**不是可判定的
        机械操作**，而本函数是纯代码（无 LLM）。要做就得再引入一次 LLM 判定，
        属独立改动，本轮未做（设计 §6.2 第 3 步的「抽出一致性矛盾」同此）。
      · 「需要现场量或拍的」不另设判据 —— 整张 verify 清单就是给现场用的。
      · 另有一类**超出**设计清单：③ 截断的节。加它是为了不把「没查完」当成「查过了」，
        属**加严**，不丢信息（原来的做法会让那节点条目既无标注也不入清单）。
    """
    report: Dict[str, Dict] = {}
    verify: List[Dict] = []
    for section in SECTION_KEYS:
        body = section_reports.get(section) or {}
        items = dedupe_items(body.get("items") or [])
        # 第三个返回值是「结构上无法展示」的条目（不是 dict）—— **不是**被丢弃的内容。
        kept, no_source, _unrenderable = split_items_by_source(items, len(body.get("sources") or []))
        # 单一来源 ⇒ 进 verify（**仍然留在本节正文里**：它是可用的线索，不是废料）
        for it in kept:
            if len(it.get("sources") or []) == 1:
                verify.append({**it, "section": section, "note": "单一来源，请现场核实"})
        # 被截断的节：把它的全部条目也列入待核实（结果不完整）
        if body.get("truncated"):
            for it in kept:
                verify.append({**it, "section": section, "note": "检索被截断，结果可能不完整"})
        report[section] = {
            "items": [dict(it, content=scrub_contact(it.get("content") or "")) for it in kept],
            "sources": body.get("sources") or [],
            "note": body.get("note") or "",
            "not_found": bool(body.get("not_found")),
        }
        verify.extend(no_source)

    # ⚠️ 这里原先还有一行 `verify.extend(section_reports.get("__inferred__") or [])` ——
    # **没有任何调用方产出过 `__inferred__` 这个键**（全仓 grep 零命中），是死分支，
    # 且它会让下一个读者以为存在一个「由调用方补推断条目」的契约。已删。
    report["verify"] = {
        "items": dedupe_items(verify),
        "sources": [],
        "note": "这些条目只有单一来源、属 AI 推断、或所在节的检索被截断 —— 现场逐条核。",
        "not_found": False,
    }
    return report, verify


_RESOLVE_TAIL = "是什么地方 简介"


def _numbered_with_urls(uniq: List[Dict]) -> str:
    """消歧题面专用的编号列表：**带 URL**。

    不复用 `number_sources` 的那份 —— 那份给的是「编号 标题（站点）」，没有 URL，
    而消歧的输出契约（`ResearchCandidate.source_urls`）要的正是 URL。两处刻意不同：
    分节成文的输出是**编号数组**（`ResearchItem.sources`），编号就够；消歧的输出是
    **链接**，必须给 URL。合成一份会让一边的契约落空（消歧那条：模型只能瞎编或给空）。
    """
    return "\n".join(f"{i + 1}. {u['title']}（{u['site_name']}）{u['url']}"
                     for i, u in enumerate(uniq))


def resolve_venue(venue_name: str, city: str = "", address: str = "",
                  hint: str = "", user_id: str = "",
                  search_fn=None, agent_fn=None) -> Dict:
    """消歧：一次检索 + 一次 agent，产出候选（含候选为空这种正当结果）。

    返回 `{"candidates", "search_log", "reason"}`。`reason` 是**给客户端看的分类码**：
    `""` 有候选 / `search_failed` 联网检索失败 / `agent_failed` 检索成功但模型没产出候选
    / `no_candidate` 检索与模型都正常、公网就是查不到。

    🔴 四态**必须分开**：把 `agent_failed` 混进 `no_candidate`，界面就会对业务人员说
    「公网查不到这个场地」—— 那是一句我们没有依据的断言（同族注释见
    `src/schemas/venue_research.py` 的 `CandidateList`）。两者的处置也不同：
    前者换更精确的地名重试，后者直接重试。

    `user_id` 当前不参与检索词组装（配额/日志化未做，设计决策 9：先不设闸）。
    **不要**因为它没用就删掉参数 —— 跨服务签名由 BFF 决定，删了会让调用点报错而
    错误信息不指向真因（同族：signature-change-grep-all-test-stubs）。
    """
    search_fn = search_fn or _default_search
    agent_fn = agent_fn or _default_disambiguate
    nm = section_query_hint(hint) or (venue_name or "").strip()
    q = " ".join(x for x in [(city or "").strip(), nm, (address or "").strip(),
                             _RESOLVE_TAIL] if x)
    res = search_fn(q)
    ok = bool(res.get("ok"))
    numbered, uniq = number_sources(res.get("sources") or [])
    log = [{"section": "resolve", "query": q, "source_count": len(uniq),
            "truncated": bool(res.get("truncated")),
            "error": "" if ok else (res.get("error") or "检索失败")}]
    if not ok and not uniq:
        return {"candidates": [], "search_log": log, "reason": "search_failed"}
    body = _numbered_with_urls(uniq)
    try:
        out = agent_fn(q, f"检索到的资料：\n{res.get('answer') or '（无正文）'}\n\n"
                          f"来源列表（引用时按这些 URL，**不要自己拼**）：\n{body or '（无来源）'}\n\n"
                          f"输出 candidates JSON。")
    except Exception as e:
        logger.warning("消歧成文失败: %s", e)
        return {"candidates": [], "search_log": log, "reason": "agent_failed"}
    # 置信度归一：模型给别的词（"很高"/"HIGH"/漏写）时落成 low —— 宁可让界面提示
    # 「不确定」，也不要让一个非法枚举值流到前端（前端按枚举渲染时把它显示成空白）。
    allowed_urls = {u["url"] for u in uniq}
    clean: List[Dict] = []
    for c in (out.get("candidates") or []):
        if not isinstance(c, dict):
            continue
        if c.get("confidence") not in ("high", "medium", "low"):
            c["confidence"] = "low"
        # 🔴 取交集：只留本次检索结果里**真实出现过**的 URL。题面把 URL 给了模型，
        # 而转抄长 URL 是会错的（少一个字符就是一个不存在的页面，界面上照样像模像样）。
        c["source_urls"] = [u for u in (c.get("source_urls") or [])
                            if isinstance(u, str) and u in allowed_urls]
        clean.append(c)
    return {"candidates": clean, "search_log": log,
            "reason": "" if clean else "no_candidate"}


def _default_disambiguate(query: str, desc: str) -> Dict:
    """生产消歧实现。**重依赖全在函数内 import**：本模块被 `src/api/venue_research.py`
    在模块级 import，把 crewai 提到模块级会让**测试的进口耗时从 2.05s 涨到 44.49s**
    （实测，见 `tests/test_venue_research_api.py` 头注）。`query` 不单独用 ——
    它已经拼在 `desc` 里，留着是为了与 `agent_fn` 的两参契约一致。
    """
    from src.agents.wenlv_creation.venue_research import disambiguator_agent
    from src.crews.wenlv_creation_crew import WenlvCreationOrchestrator
    from src.schemas.venue_research import CandidateList

    orch = WenlvCreationOrchestrator(None)   # 不落 Redis：状态归 pms-server，诊断态另有键
    return orch._run_agent(disambiguator_agent, desc, "candidates JSON", CandidateList, retries=1)


def _section_task(section, venue_name, city, anchor, res, numbered) -> str:
    """一节成文的 task 描述。**检索结果是参数**（不是 agent 自己取的）——
    这正是「检索不参与重试」的落实方式（同族：`_default_assemble` 的注释）。"""
    return (
        f"调研对象：{anchor.get('name') or venue_name}"
        f"（{anchor.get('region') or city}）\n"
        f"说明：{anchor.get('one_liner') or ''}\n\n"
        f"联网检索到的资料（**只能用这里出现的事实**）：\n{res.get('answer') or '（无正文）'}\n\n"
        f"检索到的来源列表（**引用时按下面的编号**）：\n{numbered or '（无来源）'}\n\n"
        f"🔴 `sources` 只列你真的引用了其内容的编号；本条没有来源支撑时给 [] 并"
        f"把 inferred 给 true。"
    )


def run_research(
    research_id: str,
    venue_name: str,
    city: str,
    anchor: Dict,
    hint: str = "",
    research_user_id: str = "",
    search_fn=None,
    agent_fn=None,
    persist_fn=None,
) -> Dict:
    """跑完整场调研，**每完成一节即回写**。

    回写的是**累积快照**（report/progress/search_log 全量），不是增量 ——
    pms-server 侧就是整体替换，深合并的语义说不清（数组怎么并？删掉的元素去哪？）。

    `persist_fn(research_id, **fields)` 必传（由 API 层注入 `WenlvPersister.save_research`）。
    `research_user_id` 目前**不用**（报告里不落操作人，操作人在 pms-server 的 started_by），
    留着是因为 API 层已经在传（`api/venue_research.py`）—— **不要**据此以为归属传递可省。

    单节失败**不传染**其余节：该节记 `failed` 并照常回写，其余节继续跑；
    五节全失败才整份 `failed`，否则部分成功记 `partial`。
    """
    search_fn = search_fn or _default_search
    agent_fn = agent_fn or _default_section_agent

    started = time.monotonic()
    progress: Dict[str, str] = {}
    report: Dict[str, Dict] = {}
    search_log: List[Dict] = []

    for section in SECTION_KEYS:
        q = build_section_query(section, venue_name, city, hint)
        progress[section] = "running"
        res = search_fn(q)
        ok = bool(res.get("ok"))
        truncated = bool(res.get("truncated"))
        numbered, uniq = number_sources(res.get("sources") or [])
        search_log.append({
            "section": section, "query": q,
            "source_count": len(uniq), "truncated": truncated,
            "error": "" if ok else (res.get("error") or "检索失败"),
        })
        if not ok and not uniq:
            progress[section] = "failed"
            report[section] = {"items": [], "sources": [], "note": res.get("error") or "检索失败",
                               "not_found": False}
            persist_fn(research_id, status="running", report=report,
                       progress=dict(progress), search_log=search_log)
            continue
        try:
            out = agent_fn(section, _section_task(section, venue_name, city, anchor, res, numbered))
        except Exception as e:                      # 单节成文失败**不传染**其余节
            logger.warning("调研分节成文失败 section=%s: %s", section, e)
            progress[section] = "failed"
            report[section] = {"items": [], "sources": uniq, "note": "资料整理失败",
                               "not_found": False}
            persist_fn(research_id, status="running", report=report,
                       progress=dict(progress), search_log=search_log)
            continue
        report[section] = {
            "items": out.get("items") or [],
            "sources": uniq,
            "note": out.get("note") or "",
            "not_found": bool(out.get("not_found")),
            "truncated": truncated,
        }
        progress[section] = "done"
        persist_fn(research_id, status="running", report=report,
                   progress=dict(progress), search_log=search_log)

    full_report, _verify = assemble_report(report)
    done_n = sum(1 for v in progress.values() if v == "done")
    if done_n == 0:
        status, error = "failed", "五个主题的检索与整理全部失败，请稍后重试"
    elif done_n < len(SECTION_KEYS):
        status, error = "partial", ""
    else:
        status, error = "ready", ""
    elapsed = time.monotonic() - started
    if elapsed > WATCHDOG_NOTE * 0.5:
        logger.warning("调研总耗时 %.0fs 已逼近看门狗阈值 %ds —— 该调阈值或改设计",
                       elapsed, WATCHDOG_NOTE)
    # 终态回写。**不 try/except**：写不上必须让调用方知道（那行会停在 running，
    # 由看门狗放行重跑）。这里吞掉异常就会造出「报告已就绪但库里显示调研中」的假象。
    persist_fn(research_id, status=status, report=full_report,
               progress=dict(progress), search_log=search_log,
               error=error, finished_at=True)
    return {"status": status, "progress": progress, "report": full_report}
