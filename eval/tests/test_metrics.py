"""评测指标纯函数测试（TDD：先失败后实现）。"""
import pytest

from eval.metrics import (
    mean,
    percentile,
    routing_accuracy,
    tool_f1,
    wilson_lower,
)


def test_routing_accuracy():
    assert routing_accuracy([("revenue", "revenue"), ("ops", "revenue")]) == 0.5
    assert routing_accuracy([]) == 0.0


def test_tool_f1_penalizes_extra_calls():
    assert tool_f1({"a", "b"}, {"a", "b", "c"}) == pytest.approx(0.8)
    assert tool_f1({"a"}, {"a"}) == 1.0


def test_tool_f1_edge_cases():
    # 期望与实参都为空（如 direct 路由不调工具）视为完美
    assert tool_f1(set(), set()) == 1.0
    # 单边为空但另一边有调用 → 0 分
    assert tool_f1(set(), {"a"}) == 0.0
    assert tool_f1({"a"}, set()) == 0.0
    # 完全无交集 → 0 分（避免除零）
    assert tool_f1({"a"}, {"b"}) == 0.0


def test_wilson_lower_is_conservative():
    assert wilson_lower(30, 30) < 1.0
    assert wilson_lower(0, 10) == 0.0
    assert wilson_lower(10, 10) > 0.7


def test_percentile_and_mean():
    assert percentile([1, 2, 3, 4], 95) == 4
    assert percentile([], 95) == 0.0
    assert mean([1.0, 2.0]) == 1.5
    assert mean([]) == 0.0
