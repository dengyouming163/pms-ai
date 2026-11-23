"""租户校验纯函数测试：阻断任意的跨商户读写（M1 评审修复）。

注意：这是本地演示的收敛护栏（允许列表），真正的租户身份应由认证主体推导，
见 M2 硬化任务。这里只保证：tenant 必填且受限时不在允许列表即拒绝。
"""
from app.api.runs import validate_tenant

ALLOWED = ["demo-yunqi"]


def test_accepts_allowed_merchant():
    assert validate_tenant({"merchant_id": "demo-yunqi"}, ALLOWED) is None


def test_rejects_missing_merchant():
    status, detail = validate_tenant({}, ALLOWED)
    assert status == 400
    assert "merchant_id" in detail


def test_rejects_none_tenant():
    status, detail = validate_tenant(None, ALLOWED)
    assert status == 400


def test_rejects_merchant_not_in_allowlist():
    status, detail = validate_tenant({"merchant_id": "other-hotel"}, ALLOWED)
    assert status == 403
    assert "other-hotel" in detail


def test_empty_allowlist_allows_any_non_empty_merchant():
    """未配置允许列表（本地单测/离线）时不额外限制，只要求 merchant_id 非空。"""
    assert validate_tenant({"merchant_id": "m1"}, []) is None
