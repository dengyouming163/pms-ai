"""建议采纳与收益归因纯函数测试（不连库）。

覆盖：
- estimate_baseline_revenue：入住率 × 房量估算，缺失回落单间夜，非法值不编造；
- summarize_insights：采纳率、归因增益、待回填数量与「归因非因果」标注。
"""
from app.insights import estimate_baseline_revenue, summarize_insights


def test_estimate_baseline_uses_occupancy_and_rooms():
    """428 元 × (40 房 × 75%) = 428 × 30 = 12840。"""
    revenue, rooms = estimate_baseline_revenue(428, 75, 40)
    assert rooms == 30
    assert revenue == 12840.0


def test_estimate_baseline_falls_back_to_single_room():
    """缺房量/入住率时回落 1 间夜，避免 0 基线或凭空放大。"""
    assert estimate_baseline_revenue(428, None, None) == (428.0, 1)
    assert estimate_baseline_revenue(428, 0, 40) == (428.0, 1)


def test_estimate_baseline_handles_invalid_values():
    assert estimate_baseline_revenue(None, "abc", -3) == (0.0, 1)


def test_summarize_insights_reports_rate_gain_and_pending():
    rows = [
        {"baseline_revenue": 12840, "observed_revenue": 13000},
        {"baseline_revenue": 8000, "observed_revenue": None},
    ]
    summary = summarize_insights(rows, decided_count=4)

    assert summary["adopted_count"] == 2
    assert summary["decided_count"] == 4
    assert summary["adoption_rate"] == 0.5
    assert summary["observed_count"] == 1
    assert summary["pending_backfill_count"] == 1
    assert summary["attribution_gain"] == 160.0
    assert "归因非因果" in summary["attribution_note"]


def test_summarize_insights_without_decisions_is_zero_not_nan():
    summary = summarize_insights([], decided_count=0)
    assert summary["adoption_rate"] == 0.0
    assert summary["attribution_gain"] == 0.0
