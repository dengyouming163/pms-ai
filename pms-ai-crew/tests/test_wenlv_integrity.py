"""确定性校验测试：对齐 pms-server src/services/wenlv-integrity.ts 规则（语义化输入）。"""
from src.services.wenlv_integrity import ACTION_TYPES, QUIZ_TYPES, validate_wenlv_integrity


def _base(mode="narrative"):
    return {
        "product": {"id": "P1", "name": "测试产品", "mode": mode},
        "nodes": [{"id": "NODE_1", "node_type": "scene", "title": "起点",
                   "unlock_collected": [], "unlock_completed": [],
                   "grant_collectibles": [], "complete_nodes": []}],
        "collectibles": [{"id": "CLUE_1", "name": "密信", "type": "clue"}],
        "endings": [{"id": "END_1", "title": "结局", "collected_ids": [], "reward_id": ""}],
        "rewards": [{"id": "REWARD_1", "name": "奖"}],
        "tiers": [],
    }


def test_narrative_requires_scene_and_ending():
    assert validate_wenlv_integrity(_base()) == []
    bad = _base()
    bad["endings"] = []
    assert any("结局" in e for e in validate_wenlv_integrity(bad))


def test_grant_reference_must_exist():
    bad = _base()
    bad["nodes"][0]["grant_collectibles"] = ["CLUE_MISSING"]
    errs = validate_wenlv_integrity(bad)
    assert any("CLUE_MISSING" in e for e in errs)


def test_rally_forbids_ending_requires_tier():
    rally = _base(mode="rally")
    errs = validate_wenlv_integrity(rally)
    assert any("结局" in e for e in errs)
    assert any("档位" in e for e in errs)


def test_rally_tier_condition_only_collected_stamp():
    rally = {
        "product": {"id": "P1", "name": "集章", "mode": "rally"},
        # 发章节点必须真的发放该印章：档位条件引用的印章若无人发放，该档位永远达不成
        # （可达性规则，2026-09-15）。TS 侧同名正例夹具同样发了章，这里对齐。
        "nodes": [{"id": "NODE_1", "node_type": "scene", "title": "点位",
                   "unlock_collected": [], "unlock_completed": [],
                   "grant_collectibles": ["STAMP_1"], "complete_nodes": []}],
        "collectibles": [{"id": "STAMP_1", "name": "章", "type": "stamp"}],
        "endings": [],
        "rewards": [{"id": "REWARD_1", "name": "奖"}],
        "tiers": [{"id": "TIER_1", "name": "档", "collected_ids": ["STAMP_1"], "reward_id": "REWARD_1"}],
    }
    assert validate_wenlv_integrity(rally) == []
    rally["tiers"][0]["collected_ids"] = ["STAMP_MISSING"]
    assert any("STAMP_MISSING" in e for e in validate_wenlv_integrity(rally))


# ---------------------------------------------------------------------------
# 可达性（2026-09-15）。旧规则只查「引用存在」，于是「引用了存在、但**永不被满足**的 id」
# 静默通过。这是 AI 生成剧本的系统性缺陷：scene 节点普遍不自 complete，后继节点却把前一个
# scene 当作 completed 引用 ⇒ 第 2 关硬死锁（生产实测 4 个产品共 28 处）。
#
# 用例设计要点：负例里被引用的 id 都**真实存在** —— 否则旧规则本来就报「不存在」，
# 用例在实现之前就是绿的，分不清「新规则咬住了」与「旧规则早就在报」。
# ---------------------------------------------------------------------------

def _reach_base():
    """最小可发布 narrative：NODE_1(scene) + END_1。NODE_2 依赖 NODE_1 完成。"""
    return {
        "product": {"id": "P1", "name": "可达性", "mode": "narrative"},
        "nodes": [
            {"id": "NODE_1", "node_type": "scene", "title": "村口",
             "unlock_collected": [], "unlock_completed": [],
             "grant_collectibles": [], "complete_nodes": []},
            # interactions 是 S4④ 新增的必填项：narrative 下的 puzzle 节点没有交互题目
            # 就是「答不了的谜题」。TS 侧同一次提交给对应夹具补了同样的交互题（见 dd88cf8d）。
            {"id": "NODE_2", "node_type": "puzzle", "title": "对暗号",
             "unlock_collected": [], "unlock_completed": ["NODE_1"],
             "grant_collectibles": [], "complete_nodes": ["NODE_2"],
             "interactions": [{"type": "single", "question": "暗号是？", "options": ["A"], "answer": "A"}]},
        ],
        "collectibles": [],
        "endings": [{"id": "END_1", "title": "结局", "collected_ids": [], "reward_id": ""}],
        "rewards": [],
        "tiers": [],
    }


def test_r1_unlock_completed_must_be_completable():
    """R1 负例：NODE_1 存在，但没有任何节点 complete 它 ⇒ 该 unlock 永远无法满足。"""
    errs = validate_wenlv_integrity(_reach_base())
    assert not any("不存在" in e for e in errs)  # NODE_1 是存在的，旧规则不报——证明是**新规则**在咬
    assert any("NODE_1" in e and "永远无法满足" in e for e in errs)


def test_r1_positive_when_a_node_completes_it():
    """R1 正例：有节点 complete 它 ⇒ 零错误（防误报）。"""
    ok = _reach_base()
    ok["nodes"][0]["complete_nodes"] = ["NODE_1"]
    assert validate_wenlv_integrity(ok) == []


# 注：TS 侧有一条「visited 引用不报可达性错误」的用例；**此处刻意没有对应用例** ——
# Python 的输入形状里没有 visited 这一概念（只有 unlock_collected / unlock_completed），
# 校验器结构上不可能对 visited 报错，写出来只会是一条恒真的假用例。


def test_r2_ending_clue_must_be_granted():
    """R2 负例：结局引用一条存在、但无任何节点发放的线索 ⇒ 该结局永不触发。"""
    bad = _reach_base()
    bad["collectibles"] = [{"id": "CLUE_1", "name": "孤儿线索", "type": "clue"}]
    bad["endings"][0]["collected_ids"] = ["CLUE_1"]
    errs = validate_wenlv_integrity(bad)
    assert not any("不存在的线索" in e for e in errs)
    assert any("CLUE_1" in e and "永远无法满足" in e for e in errs)


def test_r2_positive_when_a_node_grants_it():
    ok = _reach_base()
    ok["collectibles"] = [{"id": "CLUE_1", "name": "密信", "type": "clue"}]
    ok["endings"][0]["collected_ids"] = ["CLUE_1"]
    ok["nodes"][0]["grant_collectibles"] = ["CLUE_1"]
    ok["nodes"][0]["complete_nodes"] = ["NODE_1"]
    assert validate_wenlv_integrity(ok) == []


def test_r2_rally_tier_stamp_must_be_granted():
    """集章档位引用的印章若无人发放，该档位永远达不成（R2 的 rally 形态）。"""
    rally = {
        "product": {"id": "P1", "name": "集章", "mode": "rally"},
        "nodes": [{"id": "NODE_1", "node_type": "scene", "title": "点位",
                   "unlock_collected": [], "unlock_completed": [],
                   "grant_collectibles": [], "complete_nodes": []}],
        "collectibles": [{"id": "STAMP_1", "name": "章", "type": "stamp"}],
        "endings": [],
        "rewards": [{"id": "REWARD_1", "name": "奖"}],
        "tiers": [{"id": "TIER_1", "name": "档", "collected_ids": ["STAMP_1"], "reward_id": "REWARD_1"}],
    }
    errs = validate_wenlv_integrity(rally)
    assert any("STAMP_1" in e and "永远无法达成" in e for e in errs)


# ---------------------------------------------------------------------------
# 交互规则（S4④：puzzle 判定 / scene 现场动作）。与 TS 侧
# pms-server src/services/__tests__/wenlv-integrity.test.ts 的
# 「interactions 规则」describe 块**一一对应**。
#
# 旧实现把整块写在 `mode === 'rally'` 且 `nodeType === 'puzzle'` 之内，
# 于是 scene 节点上的 interactions 从未被任何一道闸看过 —— 生产因此积压了
# 37 条 AI 写出、却谁也没渲染过的剧情题。本组用例把这个空洞钉死。
# ---------------------------------------------------------------------------

def _scene_node(interactions):
    return {"id": "NODE_2", "node_type": "scene", "title": "村口",
            "unlock_collected": [], "unlock_completed": [],
            "grant_collectibles": [], "complete_nodes": [], "interactions": interactions}


def _puzzle_node(interactions):
    return {"id": "NODE_2", "node_type": "puzzle", "title": "对暗号",
            "unlock_collected": [], "unlock_completed": [],
            "grant_collectibles": [], "complete_nodes": [], "interactions": interactions}


def _with(node):
    d = _base()
    d["nodes"].append(node)
    return d


_Q = {"type": "single", "question": "q", "options": ["a"], "answer": "a"}


def test_puzzle_photo_rejected_points_to_scene():
    errs = validate_wenlv_integrity(_with(_puzzle_node([{"type": "photo", "question": "q"}])))
    assert any("不接受 photo" in e and "scene" in e for e in errs)


def test_puzzle_meditate_rejected_points_to_scene():
    errs = validate_wenlv_integrity(_with(_puzzle_node([{"type": "meditate", "question": "q", "seconds": 60}])))
    assert any("不接受 meditate" in e and "scene" in e for e in errs)


def test_puzzle_without_interactions_rejected():
    """narrative 下首次生效 —— 旧实现只校验 rally 分支"""
    assert any("必须有交互题目" in e for e in validate_wenlv_integrity(_with(_puzzle_node([]))))


def test_puzzle_empty_answer_rejected():
    assert any("答案不能为空" in e for e in validate_wenlv_integrity(_with(_puzzle_node([dict(_Q, answer="")]))))


def test_puzzle_legal_is_clean():
    assert validate_wenlv_integrity(_with(_puzzle_node([dict(_Q)]))) == []


def test_scene_quiz_with_answer_is_clean():
    """★救活 37 条的依据：scene 节点带剧情回味题合法"""
    assert validate_wenlv_integrity(_with(_scene_node([dict(_Q)]))) == []


def test_scene_quiz_empty_answer_rejected():
    assert any("答案不能为空" in e for e in validate_wenlv_integrity(_with(_scene_node([dict(_Q, answer="")]))))


def test_scene_photo_is_clean():
    assert validate_wenlv_integrity(_with(_scene_node([{"type": "photo", "question": "拍一张"}]))) == []


def test_scene_meditate_is_clean():
    assert validate_wenlv_integrity(_with(_scene_node([{"type": "meditate", "question": "静坐", "seconds": 60}]))) == []


def test_scene_meditate_bad_seconds_rejected():
    for seconds in (0, 1800.5, None, 2000):
        errs = validate_wenlv_integrity(_with(_scene_node([{"type": "meditate", "question": "q", "seconds": seconds}])))
        assert any("静坐时长" in e for e in errs), seconds


# ---------------------------------------------------------------------------
# 现场动作的题干非空（2026-09-18，块 C）。与 TS 侧
# pms-server src/services/__tests__/wenlv-integrity.test.ts 的
# 「scene 节点的现场动作题干（块 C）」describe 块**一一对应**。
# 发布闸此前对 photo 是零校验、meditate 只看 seconds；前端两个分支都直接渲染 question。
# ⚠️ 本组是**行为**判据，与 test_error_message_literals_match_ts_integrity 互补：
# 那条只比对**文案字面量集合**，若漏掉合并分支末尾的 `continue`（于是每个现场动作节点
# 都多报一条「交互类型非法」），文案集合不变、那条依然绿 —— 只有下面的
# test_scene_action_no_spurious_unknown_type 能抓住。
# ---------------------------------------------------------------------------

def test_scene_photo_without_question_rejected():
    errs = validate_wenlv_integrity(_with(_scene_node([{"type": "photo"}])))
    assert any("拍照打卡" in e and "题干" in e for e in errs), errs


def test_scene_photo_blank_question_rejected():
    errs = validate_wenlv_integrity(_with(_scene_node([{"type": "photo", "question": "   "}])))
    assert any("拍照打卡" in e and "题干" in e for e in errs), errs


def test_scene_meditate_without_question_rejected():
    errs = validate_wenlv_integrity(_with(_scene_node([{"type": "meditate", "seconds": 60}])))
    assert any("静坐计时" in e and "题干" in e for e in errs), errs


def test_scene_meditate_bad_seconds_and_missing_question_reports_both():
    """两条规则互不吞并（反向：不能被题干校验短路掉 seconds 那条）。"""
    errs = validate_wenlv_integrity(_with(_scene_node([{"type": "meditate", "seconds": 0}])))
    assert any("静坐时长" in e for e in errs), errs
    assert any("静坐计时" in e and "题干" in e for e in errs), errs


def test_scene_meditate_good_question_bad_seconds_reports_only_seconds():
    """两条规则互不吞并（正向）。"""
    errs = validate_wenlv_integrity(_with(_scene_node([{"type": "meditate", "question": "静坐一会儿", "seconds": 0}])))
    assert any("静坐时长" in e for e in errs), errs
    assert not any("题干" in e for e in errs), errs


def test_scene_action_no_spurious_unknown_type():
    """回归：photo/meditate 合成分支后必须仍 `continue`，否则每个现场动作节点都会
    掉进兜底分支多报一条「交互类型非法」，与 TS 侧分叉。"""
    errs = validate_wenlv_integrity(_with(_scene_node([{"type": "photo"}, {"type": "meditate", "seconds": 60}])))
    assert not any("交互类型" in e for e in errs), errs


def test_scene_unknown_type_rejected():
    errs = validate_wenlv_integrity(_with(_scene_node([{"type": "foo", "question": "q"}])))
    assert any("'foo'" in e for e in errs)


def test_rally_scene_unknown_type_rejected():
    """两个 mode 下都要生效"""
    d = _base(mode="rally")
    d["nodes"].append(_scene_node([{"type": "foo", "question": "q"}]))
    errs = validate_wenlv_integrity(d)
    assert any("'foo'" in e for e in errs)


# ---------------------------------------------------------------------------
# 跨语言判定分叉（S4④ 收口）。Python 校验器是 AI 生成流水线的闸，TS 校验器是发布闸；
# 同一份内容可能在「一侧通过、另一侧被拦」。以下两条是 2026-09-17 实证的分叉。
# 修法一律是**改 Python 去匹配 TS**：TS 是发布闸，放宽它会让坏内容发布出去。
# ---------------------------------------------------------------------------

def test_scene_single_answer_empty_list_rejected():
    """分叉 B：JS String([]) === '' ⇒ TS 拦；Python str([]) === '[]' ⇒ 曾放行。钉住对齐。"""
    assert any("答案不能为空" in e for e in validate_wenlv_integrity(_with(_scene_node([dict(_Q, answer=[])]))))


def test_puzzle_single_answer_empty_list_rejected():
    assert any("答案不能为空" in e for e in validate_wenlv_integrity(_with(_puzzle_node([dict(_Q, answer=[])]))))


def test_single_answer_nonempty_list_is_not_empty():
    """反向对照：不能把所有 list 都判空（JS String(['a']) === 'a' 是非空）。"""
    assert validate_wenlv_integrity(_with(_scene_node([dict(_Q, answer=["a"])]))) == []


def test_scene_meditate_integral_float_accepted():
    """分叉 C：JSON 60.0 → JS number 60（isInteger 真）⇒ 通过；Python 是 float ⇒ 曾误报。钉住对齐。"""
    assert validate_wenlv_integrity(_with(_scene_node([{"type": "meditate", "question": "q", "seconds": 60.0}]))) == []


def test_scene_meditate_non_integral_float_rejected():
    assert any("静坐时长" in e for e in validate_wenlv_integrity(_with(_scene_node([{"type": "meditate", "question": "q", "seconds": 60.5}]))))


# ---------------------------------------------------------------------------
# judge 答案取值域（2026-09-17）。
# 全链路只认 'true' | 'false' 字面量：schema 类型（pms-server db/schema/wenlv.ts）、
# 创作台下拉、pms-nimi 的 pickedJudge、engine 的 isAnswerCorrect 逐字比较。生成器此前
# 没有任何取值域契约，AI 按人类可读写 ⇒ 生产全库 17 条 judge 写成「对」「正确」，
# 客户端提交 'true'/'false' 永远不等。旧校验器只查「答案非空」，这 17 条一路通行。
# **两种 node_type 都要覆盖** —— 旧校验器只在 puzzle 分支里检查，才让脏数据积压。
# ---------------------------------------------------------------------------

_JUDGE = {"type": "judge", "question": "这句话对吗？"}


def _judge_node_fns():
    return (("puzzle", _puzzle_node), ("scene", _scene_node))


def _value_domain_errs(errs):
    return [e for e in errs if "只能是 'true' 或 'false'" in e]


def _empty_answer_errs(errs):
    return [e for e in errs if "答案不能为空" in e]


def test_judge_human_readable_answer_rejected_by_value_domain():
    for name, node_fn in _judge_node_fns():
        for bad in ("对", "正确"):
            errs = validate_wenlv_integrity(_with(node_fn([dict(_JUDGE, answer=bad)])))
            value = _value_domain_errs(errs)
            assert len(value) == 1, (name, bad, errs)
            assert bad in value[0], (name, bad, errs)
            # 不是「答案不能为空」那条 —— 它非空，问题在取值域
            assert _empty_answer_errs(errs) == [], (name, bad, errs)


def test_judge_true_false_accepted():
    for name, node_fn in _judge_node_fns():
        for ok in ("true", "false"):
            assert validate_wenlv_integrity(_with(node_fn([dict(_JUDGE, answer=ok)]))) == [], (name, ok)


def test_judge_missing_answer_key_reports_empty_not_value_domain():
    """缺 answer 键走的是「答案不能为空」分支（先判空、后判取值域）。
    两侧的越界写法本就不同：TS 的 JSON.stringify(undefined) 返回 undefined（非字符串），
    Python 的 json.dumps(None) 返回 'null' —— 本用例把「顺序」钉死，两侧都不得让缺键落进取值域。"""
    for name, node_fn in _judge_node_fns():
        errs = validate_wenlv_integrity(_with(node_fn([{"type": "judge", "question": "q"}])))
        assert len(_empty_answer_errs(errs)) == 1, (name, errs)
        assert _value_domain_errs(errs) == [], (name, errs)


def test_non_judge_answer_not_restricted_to_boolean():
    """规则不得越界：single 的答案可以是任意文本（含中文「对」）。变异取证的目标用例。"""
    for name, node_fn in _judge_node_fns():
        errs = validate_wenlv_integrity(_with(node_fn(
            [{"type": "single", "question": "q", "options": ["对", "错"], "answer": "对"}])))
        assert errs == [], (name, errs)


def test_judge_non_string_answer_rejected_by_value_domain():
    """answer 是数字 1 之类的非字符串真值：不做隐式转换，一律报取值域。"""
    for name, node_fn in _judge_node_fns():
        errs = validate_wenlv_integrity(_with(node_fn([dict(_JUDGE, answer=1)])))
        assert len(_value_domain_errs(errs)) == 1, (name, errs)


# ---------------------------------------------------------------------------
# 两侧同构守卫（防再次分叉）。上面两条分叉的教训：同一套规则写在两个语言里，
# 靠人眼逐行对齐迟早会漂开。这两条直接读 TS 源文件做对拍。
# ---------------------------------------------------------------------------

import re
from pathlib import Path  # noqa: E402

_PY_INTEGRITY = Path(__file__).resolve().parents[1] / "src" / "services" / "wenlv_integrity.py"
_TS_ENGINE = Path(__file__).resolve().parents[2] / "pms-server" / "src" / "services" / "wenlv-engine.ts"
_TS_INTEGRITY = Path(__file__).resolve().parents[2] / "pms-server" / "src" / "services" / "wenlv-integrity.ts"


def _ts_const_list(source: str, name: str) -> list[str]:
    m = re.search(rf"export const {name} = \[(.*?)\] as const", source, re.S)
    assert m, f"未能在 wenlv-engine.ts 中找到 {name}"
    return re.findall(r"'([^']*)'", m.group(1))


def test_type_lists_match_ts_engine():
    """题型清单必须与 TS 侧同源 —— 这是两侧闸口径一致的地基。"""
    src = _TS_ENGINE.read_text(encoding="utf-8")
    assert list(QUIZ_TYPES) == _ts_const_list(src, "QUIZ_TYPES")
    assert list(ACTION_TYPES) == _ts_const_list(src, "ACTION_TYPES")


def _strip_placeholders(s: str) -> str:
    """把 JS 模板 ${expr} 与 Python f-string {expr} 统一归一成 {}，只比对**字面文案**：
    两侧的表达式写法本来就不同（`{label}` vs `${label}`），漂开的是文案本身。"""
    return re.sub(r"\$?\{[^}]*\}", "{}", s)


def _ts_check_interactions_src(ts_src: str) -> str:
    # TS 侧在 aab3902b（节点模型简化为 requires/grants/puzzle，2026-10-03）把
    # interactions 数组收敛为单个 puzzle 对象，函数同步更名 checkInteractions → checkPuzzle。
    # 终止锚点仍是 2 空格缩进的 `};`：内部嵌套的 checkQuizFields 以 4 空格 `    };` 收尾，
    # 不会提前截断（与原 checkInteractions 时代的配平依据相同）。
    m = re.search(r"const checkPuzzle = \(.*?\n  \};", ts_src, re.S)
    assert m, "未能在 wenlv-integrity.ts 中定位 checkPuzzle 函数体"
    return m.group(0)


def _py_check_interactions_src(py_src: str) -> str:
    """取 `_check_interactions` 的**函数体**。

    终止锚点必须落在「函数体边界」（`# NPC 引用完整性` 那段顶层注释），**不能**用
    `if product.get("mode") == "rally":`（rally 分流处）：后者会把「函数定义处 → 分流处」
    之间的**非 checkInteractions** 代码（NPC 调用块、R3 规则块）一并吞进窗口，于是本测试
    就从「比对两个 checkInteractions 函数体」悄悄退化成「比对一段跨块区间」，与 TS 侧窗口
    （`const checkInteractions = (…};`）不再同构 —— 任何在 Python 侧该区间新落的**字面量**
    `errs.append("…")` 都会凭空造出「Python 独有」的假分叉（R3 落地时实际踩到过）。
    注意抽取逻辑只认**字面量参数**形态（见下方 `re.findall` 的正则）：参数是变量的
    `errs.append(x)` 抽不到，也就不会造出假分叉。
    """
    m = re.search(r"def _check_interactions\(.*?\n    # NPC 引用完整性", py_src, re.S)
    assert m, "未能在 wenlv_integrity.py 中定位 _check_interactions 函数体"
    return m.group(0)


def _ts_check_interactions_src(ts_src: str) -> str:
    # TS 侧在 aab3902b（节点模型简化为 requires/grants/puzzle，2026-10-03）把
    # interactions 数组收敛为单个 puzzle 对象，函数同步更名 checkInteractions → checkPuzzle。
    # 终止锚点仍是 2 空格缩进的 `};`：内部嵌套的 checkQuizFields 以 4 空格 `    };` 收尾，
    # 不会提前截断（与原 checkInteractions 时代的配平依据相同）。
    m = re.search(r"const checkPuzzle = \(.*?\n  \};", ts_src, re.S)
    assert m, "未能在 wenlv-integrity.ts 中定位 checkPuzzle 函数体"
    return m.group(0)


def test_error_message_literals_match_ts_integrity():
    """两侧交互校验（TS checkPuzzle / PY _check_interactions）抛出的错误文案集合必须一致。
    文案是这套闸对用户可见的契约；结构可以不同（TS 已收敛为单 puzzle 对象，PY 仍是
    interactions 数组），文案不能各写一份。"""
    # TS 侧错误收集已收口为局部 push(message, code, target) 辅助函数（统一包装
    # issues.push）， errs.push 时代结束；且 push 是三参调用，文案后跟 `, 'CODE'`
    # 而非闭括号 —— 故只锚定「push( 反引号模板串」，不要求尾部 `)`。负向后行断言
    # 排除 issues.push( 等方法调用。与 PY 侧 errs.append(f"文案") 同为字面量提取，
    # 变量参数照旧抽不到、不造假分叉。
    ts_msgs = {_strip_placeholders(m) for m in
               re.findall(r"(?<![\w.])push\(`([^`]*?)`", _ts_check_interactions_src(_TS_INTEGRITY.read_text(encoding="utf-8")))}
    py_msgs = {_strip_placeholders(m) for m in
               re.findall(r"errs\.append\(f?\"([^\"]*?)\"\)", _py_check_interactions_src(_PY_INTEGRITY.read_text(encoding="utf-8")))}
    assert ts_msgs, "未能从 TS 侧提取到任何文案 —— 守卫本身失效了"
    assert py_msgs, "未能从 Python 侧提取到任何文案 —— 守卫本身失效了"
    assert ts_msgs == py_msgs, (
        f"两侧文案分叉：TS 独有 {sorted(ts_msgs - py_msgs)}；Python 独有 {sorted(py_msgs - ts_msgs)}")


# ---------------------------------------------------------------------------
# 结局可区分性（2026-09-18）。条件语言无否定、state 单调 ⇒ 任意两个可满足的结局
# 条件必然同时可满足 ⇒ 互斥的多结局**数学上不可能**，只能是阶梯（见 spec §2.1）。
# 于是发布闸改为要求**可区分性**，与 pms-server src/services/wenlv-integrity.ts 同规则：
#   ① 两个结局的引用集合完全相同 ⇒ 拒绝（无法区分，玩家拿到哪个无意义）；
#   ② 同一产品内 priority 重复 ⇒ 拒绝（平手会退化到 id 字典序，任意）。
# ⚠️ PY 侧的结局条件是**扁平的 collected_ids 列表**（生成侧 build_wenlv_condition 的
# completed 恒为空），不是 TS 的条件树 —— 故直接对 collected_ids 去重排序即可，无需遍历函数。
# ---------------------------------------------------------------------------

def _ending(eid, title, collected_ids, priority=None):
    e = {"id": eid, "title": title, "collected_ids": collected_ids, "reward_id": ""}
    if priority is not None:
        e["priority"] = priority
    return e


def _two_ending_base(endings):
    """两个结局的最小可发布 narrative：全部线索都被 NODE_1 发放（避免可达性规则干扰）。"""
    d = _base()
    d["nodes"][0]["grant_collectibles"] = ["CLUE_1", "CLUE_2"]
    d["nodes"][0]["complete_nodes"] = ["NODE_1"]
    d["collectibles"] = [
        {"id": "CLUE_1", "name": "密信", "type": "clue"},
        {"id": "CLUE_2", "name": "玉佩", "type": "clue"},
    ]
    d["endings"] = endings
    return d


def _ref_dup_errs(errs):
    return [e for e in errs if "达成条件完全相同" in e]


def _priority_dup_errs(errs):
    return [e for e in errs if "priority 重复" in e]


def test_reject_two_endings_with_identical_reference_set():
    """顺序不同、集合相同 ⇒ 仍视为无法区分（集合比较，不是列表比较）。"""
    d = _two_ending_base([
        _ending("END_1", "真相大白", ["CLUE_1", "CLUE_2"], priority=1),
        _ending("END_2", "旧梦重游", ["CLUE_2", "CLUE_1"], priority=2),
    ])
    errs = validate_wenlv_integrity(d)
    assert _ref_dup_errs(errs), errs


def test_reject_duplicate_priority_within_product():
    d = _two_ending_base([
        _ending("END_1", "真相大白", ["CLUE_1"], priority=3),
        _ending("END_2", "旧梦重游", ["CLUE_2"], priority=3),
    ])
    errs = validate_wenlv_integrity(d)
    assert _priority_dup_errs(errs), errs


def test_distinct_conditions_and_priorities_are_clean():
    """负向：条件不同且 priority 不同 ⇒ 不得产出这两条错误。"""
    d = _two_ending_base([
        _ending("END_1", "真相大白", ["CLUE_1"], priority=1),
        _ending("END_2", "旧梦重游", ["CLUE_1", "CLUE_2"], priority=5),
    ])
    errs = validate_wenlv_integrity(d)
    assert _ref_dup_errs(errs) == [], errs
    assert _priority_dup_errs(errs) == [], errs
