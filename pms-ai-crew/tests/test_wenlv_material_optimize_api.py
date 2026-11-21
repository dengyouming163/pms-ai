"""端点契约用例。

⚠️ 不打真 HTTP（本仓测试不用 TestClient，见 tests/test_wenlv_creation_crew.py 的手法）：
直接调路由函数，用 monkeypatch 替掉服务层的 optimize_material。
这样测的是**契约**（字段名、调用参数），不是 FastAPI 的管道。
"""
import src.api.wenlv_creation as api


def test_request_model_field_names_are_snake_case():
    """字段名是 ops-app ↔ BFF ↔ ai-crew 三层的契约，改一处就静默变空串。"""
    m = api.MaterialOptimizeRequest(
        venue_name="龙门古镇", city="黔南", point_name="古井",
        material_type="legend", title="锁井传说", content="王大爷说…", user_id="u1",
    )
    assert m.model_dump() == {
        "venue_name": "龙门古镇", "city": "黔南", "point_name": "古井",
        "material_type": "legend", "title": "锁井传说", "content": "王大爷说…",
        "user_id": "u1",
    }


def test_request_model_all_fields_have_defaults():
    """全字段可缺省：表单里场地/点位/来源都可能没有，缺省不该 422。"""
    assert api.MaterialOptimizeRequest().model_dump() == {
        "venue_name": "", "city": "", "point_name": "",
        "material_type": "", "title": "", "content": "", "user_id": "",
    }


def test_endpoint_passes_payload_and_redis(monkeypatch):
    seen = {}

    def fake_optimize(payload, *, redis=None, **kw):
        seen["payload"] = payload
        seen["redis"] = redis
        return {"found": False, "content": "", "sources": [], "note": "n", "reason": "no_source_organized"}

    monkeypatch.setattr(api, "optimize_material", fake_optimize)
    monkeypatch.setattr(api, "_get_redis", lambda: "REDIS-STUB")

    import asyncio
    out = asyncio.run(api.material_optimize(api.MaterialOptimizeRequest(title="t", user_id="u9")))
    assert seen["payload"]["title"] == "t"
    assert seen["payload"]["user_id"] == "u9"
    assert seen["redis"] == "REDIS-STUB"
    # 用 D2 之后的真实分类码，不用已消失的 `no_source` —— 桩里的码是**示例**，
    # 写一个 ai-crew 已经不会再产出的值，会让后来读测试的人以为它还在。
    assert out["reason"] == "no_source_organized"


def test_route_is_registered_at_expected_path():
    paths = {(r.path, tuple(sorted(getattr(r, "methods", []) or []))) for r in api.router.routes}
    assert ("/wenlv-creation/material-optimize", ("POST",)) in paths
