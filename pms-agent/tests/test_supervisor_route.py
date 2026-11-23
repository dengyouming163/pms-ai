import pytest
from app.graph.supervisor import route_goal


@pytest.mark.parametrize("goal,expected", [
    ("明天青岩店要不要涨价？", "revenue"),
    ("给我一份今天的经营晨报", "ops"),
    ("客人问无线网密码", "guest"),
    ("看看携程渠道有没有超时订单", "ota"),
    ("你好", "direct"),
])
def test_route_goal(goal, expected):
    assert route_goal(goal) == expected
