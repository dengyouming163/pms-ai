"""评测指标：全部为纯函数，便于单测，也被 run_eval 与报告复用。

指标口径见 docs/superpowers/specs/2026-11-21-pms-ai-design.md §11.2。
"""
from __future__ import annotations

import math
from collections.abc import Iterable


def routing_accuracy(pairs: Iterable[tuple[str, str]]) -> float:
    """路由准确率：[(实际路由, 期望路由)] 中一致的比例。空集返回 0。"""
    pairs = list(pairs)
    if not pairs:
        return 0.0
    return sum(1 for actual, expected in pairs if actual == expected) / len(pairs)


def tool_f1(expected: set[str], actual: Iterable[str]) -> float:
    """工具选择 F1：期望集合与实际调用集合的调和平均。

    两者都为空（direct 路由不调工具）视为完美 1.0；
    单边为空或完全无交集返回 0.0（避免除零，且不奖励瞎调）。
    """
    expected = set(expected)
    actual = set(actual)
    if not expected and not actual:
        return 1.0
    if not expected or not actual:
        return 0.0
    true_positive = len(expected & actual)
    if true_positive == 0:
        return 0.0
    precision = true_positive / len(actual)
    recall = true_positive / len(expected)
    return 2 * precision * recall / (precision + recall)


def wilson_lower(successes: int, total: int, z: float = 1.96) -> float:
    """Wilson 置信区间下界（95%），用于小样本成功率保守估计。"""
    if total <= 0:
        return 0.0
    p = successes / total
    denominator = 1 + z * z / total
    center = p + z * z / (2 * total)
    margin = z * math.sqrt((p * (1 - p) + z * z / (4 * total)) / total)
    return max(0.0, (center - margin) / denominator)


def mean(values: Iterable[float]) -> float:
    values = list(values)
    if not values:
        return 0.0
    return sum(values) / len(values)


def percentile(values: Iterable[float], q: float) -> float:
    """最近秩百分位：q=95 表示 95% 的样本不超过该值。空集返回 0。"""
    values = sorted(values)
    if not values:
        return 0.0
    rank = math.ceil(q / 100 * len(values))
    return values[min(max(rank, 1), len(values)) - 1]
