"""契约一致性：schema 里每个 Literal 字段的合法取值，必须写进对应 agent 的提示词。

回归背景（2026-09-11 生产事故）：
level_designer 的输出契约只列了**字段名**，没列 trigger_type / collectibles[].type 的
合法取值，模型只能猜 —— 它猜了 'auto'/'node'（trigger_type）与 'reward'（type），
两次尝试（首次 JSON 语法错、重试 11 个 literal_error）全部 pydantic 校验失败，
StageFailedError 直接冒泡 → 整条 5 阶段流水线 FAILED。
用户侧表现为「AI 一键创作一直没有进度、一直没有结果」。

同一份 schema 里另有 mode 与 node_type 两个 Literal 字段，它们的取值**都写进了提示词**
且从不失败 —— 这就是差异所在：LLM 猜不中枚举是必然事件，靠运气不是策略。
故钉成测试：新增 Literal 字段必须登记归属，且取值必须明写。
"""
from pathlib import Path
from typing import Literal, get_args, get_origin

from pydantic import BaseModel

from src.schemas import wenlv_creation as S

AGENT_DIR = Path(__file__).resolve().parents[1] / "src" / "agents" / "wenlv_creation"

# Literal 字段 → 承载它的 agent 提示词文件。
# 新增任何 Literal 字段都必须在此登记，否则 test_every_literal_field_is_declared 会红。
# 值为 None 表示「外部归属」：该字段的 LLM 提示词不在本仓 agents/ 里，取值检查
# 由归属仓库自己的测试兜（见 test_every_literal_value_is_stated_in_prompt 的跳过逻辑）。
LITERAL_OWNERS = {
    ("ProjectPositioning", "mode"): "project_positioning.py",
    ("WenlvNpc", "role"): "npc_designer.py",
    ("LevelNode", "node_type"): "level_designer.py",
    ("LevelNode", "trigger_type"): "level_designer.py",
    ("LevelCollectible", "type"): "level_designer.py",
    ("SkeletonNode", "node_type"): "skeleton_designer.py",
    ("SkeletonEdge", "edge_type"): "skeleton_designer.py",
    # WenlvNode/WenlvNodeProp 是 node_refine 的镜像契约（保持两套 schema 形状一致，
    # 见 tests/test_wenlv_props_schema.py），但 node_refine 的 LLM 调用由 pms-server
    # node-refiner 直连（其 prompt.ts 已明写 kind 四个取值），Python 侧无 agent 承载。
    ("WenlvNodeProp", "kind"): None,
}


def _scan_backstory(src: str, start: int) -> str:
    """从 `start` 之后的那个 `(` 起做括号配平扫描，返回其内容。"""
    open_idx = src.index("(", start)
    depth = 0
    for i in range(open_idx, len(src)):
        if src[i] == "(":
            depth += 1
        elif src[i] == ")":
            depth -= 1
            if depth == 0:
                return src[open_idx + 1:i]
    raise AssertionError("backstory(...) 括号不配平")


def _backstory(filename: str) -> str:
    """抽出 agent 文件里**第一个** backstory=( ... ) 的字符串内容。

    用括号配平扫描而非 import：import agent 模块会触发 src.config 的 Redis 连接重试
    （2026-09-24 实测 **53.69s** + 一屏日志，原注释估的 22s 还偏乐观），单测不该依赖网络状态。

    ⚠️ 只取第一个 —— 文件里**有多个 agent** 时必须用 `_backstory_of(filename, role)`，
    否则会拿 A agent 的约束去 B agent 的提示词里找。
    """
    src = (AGENT_DIR / filename).read_text(encoding="utf-8")
    return _scan_backstory(src, src.index("backstory=("))


def _backstory_of(filename: str, role: str) -> str:
    """按 `role="…"` 定位 agent，取它的 backstory。

    不按「第几个 backstory」定位：位置索引会被一次重排悄悄换掉对象，
    于是断言跑去检查**另一个 agent** 的提示词 —— 那既可能假绿（约束恰好也在那边写了，
    于是删掉本 agent 的也没人发现），也可能假红。`role` 是 agent 的身份，不随顺序变。
    """
    src = (AGENT_DIR / filename).read_text(encoding="utf-8")
    anchor = f'role="{role}"'
    assert anchor in src, f"{filename} 里没有 {anchor} —— agent 被改名或删掉了？"
    return _scan_backstory(src, src.index("backstory=(", src.index(anchor)))


def _literal_fields() -> dict:
    """内省 schema 模块，产出 {(模型名, 字段名): {合法取值}}。"""
    out = {}
    for name, obj in vars(S).items():
        if isinstance(obj, type) and issubclass(obj, BaseModel):
            for field_name, field in obj.model_fields.items():
                if get_origin(field.annotation) is Literal:
                    out[(name, field_name)] = set(get_args(field.annotation))
    return out


def test_every_literal_field_is_declared():
    """schema 里每个 Literal 字段都要有提示词归属，防止新增字段悄悄漏掉。"""
    found = set(_literal_fields())
    assert found == set(LITERAL_OWNERS), (
        f"未登记归属: {found - set(LITERAL_OWNERS)}；"
        f"已登记但 schema 里不存在: {set(LITERAL_OWNERS) - found}"
    )


def test_every_literal_value_is_stated_in_prompt():
    """每个 Literal 字段的全部合法取值都必须字面出现在其 agent 的 backstory 里。"""
    fields = _literal_fields()
    problems = []
    for key, filename in LITERAL_OWNERS.items():
        if filename is None:
            continue  # 外部归属：提示词在别的仓库，取值检查由归属仓库兜
        text = _backstory(filename)
        missing = sorted(v for v in fields[key] if v not in text)
        if missing:
            problems.append(f"  {key[0]}.{key[1]} 少 {missing}（{filename}）")
    assert not problems, (
        "以下 Literal 字段的合法取值未写进提示词，模型只能猜，猜错即整条流水线 FAILED：\n"
        + "\n".join(problems)
    )


# ---------------------------------------------------------------------------
# 场地网络调研（2026-09-24）的四条反幻觉约束
#
# 🔴 这两条用例走 `_backstory_of()` 读源码，**不 import agent 模块**。
# 计划的原稿写的是 `from src.agents.wenlv_creation.venue_research import section_agent`，
# 实测那一次 import 要 **53.69 秒**（`src.config` 连不上 Redis，逐个 key 重试后回落到
# env fallback，另加一屏日志）—— 本文件开头 `_backstory` 的注释早有记载，原稿没照做。
# 代价：本用例证明不了「模块能 import」。那件事由下面这条手工探针证明过，且 Task 7
# 的流水线会真正 import 它：
#   py -3 -c "import src.agents.wenlv_creation.venue_research as m; print(m.section_agent)"
#   → IMPORT_SECONDS 53.69 / HAS_SECTION True / HAS_DISAMB True
# 若要把它变成长效闸，应另开一条**独立的** import 烟测（一次 54s），
# 而不是让每个断言提示词字面量的用例都付这个成本。
# ---------------------------------------------------------------------------


def test_venue_section_agent_提示词含四条反幻觉约束():
    """钉的是**提示词里确实写了**这几条 —— 不是「模型会遵守」。

    ⚠️ 判别力说明（如实）：只能防「有人把这些话删了」，防不住「模型读了还不照做」。
    后者由代码闸兜（`split_items_by_source` 的来源编号校验 / `scrub_contact` 的联系信息
    抹除，见 tests/test_venue_research.py）—— 那两条才是真正的兜底。
    """
    b = _backstory_of("venue_research.py", "场地资料检索整理员")
    assert "只用检索结果里出现的事实" in b      # 约束 1：不许用模型自己的记忆补事实
    assert "每条必须挂来源编号" in b            # 约束 1 的落地形态（sources 编号）
    assert "不许换算" in b and "清代" in b      # 约束 2：不许把「清代」换算成具体年份
    assert "查不到就如实说" in b                # 约束 3：not_found 的出口（空手是正当结果）
    assert "不写任何个人联系方式" in b          # 约束 4：隐私
    assert "不许写经纬度" in b                  # 点位节不落坐标（网上坐标现场对不上）


def test_venue_disambiguator_要求即使无歧义也给候选():
    """消歧不能替业务人员拍板 —— 只有一个强命中时也必须给候选。

    理由不是「礼貌」：地名重名是常态，agent 认为的无歧义与真实的无歧义不是一回事，
    而它认错的代价是**整份报告查的是另一个地方**且看不出来。
    """
    b = _backstory_of("venue_research.py", "场地名称消歧员")
    assert "只输出候选" in b
    assert "即使只有一个强命中" in b
