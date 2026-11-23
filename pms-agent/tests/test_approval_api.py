"""审批端点与恢复链路测试：不连库、不联网。

覆盖 Task 9 评审的两处缺口：
- 审批状态检查与置 running 的原子抢占（_claim_run：仅 awaiting_approval → running）。
- 恢复链路纯函数（execution_status 归一 / 事件类型 / error 码）与 price_adjust 契约
  （通过 httpx.MockTransport 注入假 transport，验证 200 passthrough、409/422 信封）。
"""
from contextlib import contextmanager

import json

import httpx
import pytest
from fastapi import HTTPException

from app.api import approvals
from app.api.approvals import ApproveRequest, _claim_run, approve_run
from app.api.runs import normalize_exec_status, run_error_code, run_event_type
from app.tools.client import HttpToolClient


class FakeCursor:
    """模拟 psycopg 游标：fetchone 返回 dict（dict_row），rowcount 由用例指定。"""

    def __init__(self, fetchone_result=None, rowcount: int = 1):
        self.fetchone_result = fetchone_result
        self.rowcount = rowcount
        self.executes: list[tuple] = []

    def execute(self, sql: str, params=None):
        self.executes.append((sql, params))

    def fetchone(self):
        return self.fetchone_result

    def fetchall(self):
        return []

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    """模拟 psycopg 连接：cursor() / transaction() 均为上下文管理器。"""

    def __init__(self, cursor: FakeCursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    @contextmanager
    def transaction(self):
        yield


def _fake_get_conn(cursor: FakeCursor):
    """构造替代 app.api.approvals.get_conn 的上下文管理器工厂。"""
    @contextmanager
    def _cm():
        yield FakeConn(cursor)

    return _cm


# ====== 恢复链路纯函数 ======

@pytest.mark.parametrize("raw,expected", [
    (None, "succeeded"),
    ("succeeded", "succeeded"),
    ("rejected", "rejected"),
    ("conflict", "conflict"),
    ("guard_rejected", "guard_rejected"),
    ("failed", "failed"),
    ("weird", "succeeded"),
])
def test_normalize_exec_status(raw, expected):
    assert normalize_exec_status(raw) == expected


@pytest.mark.parametrize("exec_status,event_type,error_code", [
    ("succeeded", "run_succeeded", None),
    ("rejected", "run_rejected", None),
    ("conflict", "run_failed", "price_conflict"),
    ("guard_rejected", "run_failed", "guard_rejected"),
    ("failed", "run_failed", "execution_failed"),
])
def test_event_type_and_error_code(exec_status, event_type, error_code):
    assert run_event_type(exec_status) == event_type
    assert run_error_code(exec_status) == error_code


# ====== approve 端点前置校验 ======

async def test_approve_invalid_decision_422():
    """非法决策在连库前就被拒绝（422）。"""
    with pytest.raises(HTTPException) as exc_info:
        await approve_run("r1", ApproveRequest(decision="maybe"))
    assert exc_info.value.status_code == 422


async def test_approve_unknown_run_404(monkeypatch):
    cursor = FakeCursor(fetchone_result=None)
    monkeypatch.setattr(approvals, "get_conn", _fake_get_conn(cursor))

    with pytest.raises(HTTPException) as exc_info:
        await approve_run("r1", ApproveRequest(decision="approve"))
    assert exc_info.value.status_code == 404


async def test_approve_not_awaiting_409(monkeypatch):
    cursor = FakeCursor(
        fetchone_result={"id": "r1", "status": "succeeded", "trace_id": None},
    )
    monkeypatch.setattr(approvals, "get_conn", _fake_get_conn(cursor))

    with pytest.raises(HTTPException) as exc_info:
        await approve_run("r1", ApproveRequest(decision="approve"))
    assert exc_info.value.status_code == 409


# ====== CAS 抢占 ======

@pytest.mark.parametrize("rowcount,claimed", [(1, True), (0, False)])
def test_claim_run_cas(rowcount, claimed):
    """仅当 UPDATE 命中 awaiting_approval 行（rowcount=1）才算抢占成功。"""
    cursor = FakeCursor(rowcount=rowcount)

    assert _claim_run(FakeConn(cursor), "r1") is claimed
    sql, params = cursor.executes[0]
    assert "AND status = 'awaiting_approval'" in sql
    assert params == ("r1",)


# ====== price_adjust HTTP 契约 ======

async def test_price_adjust_maps_409_and_422():
    tenant = {"merchant_id": "m1", "store_id": "s1"}
    proposal = {
        "proposal_id": "p1",
        "reason": "入住率高",
        "params": {
            "roomTypeId": "rt_001",
            "date": "2026-11-24",
            "expectedCurrentPrice": 300,
            "nextPrice": 380,
        },
    }

    # 200：请求体 7 字段严格对齐契约，响应原样透传
    captured: dict = {}

    def ok_handler(request: httpx.Request) -> httpx.Response:
        captured["url"] = str(request.url)
        captured["body"] = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "data": {"applied": True}})

    client = HttpToolClient(
        base_url="http://test", token="t",
        transport=httpx.MockTransport(ok_handler),
    )
    out = await client.price_adjust(tenant, proposal, approval_id="ap-1")

    assert out == {"ok": True, "data": {"applied": True}}
    assert captured["url"] == "http://test/price-adjust"
    body = captured["body"]
    assert set(body) == {
        "storeId", "roomTypeId", "date", "expectedCurrentPrice",
        "nextPrice", "reason", "approvalId",
    }
    assert body["storeId"] == "s1"
    assert body["approvalId"] == "ap-1"

    # 409（价格已被改）：不抛异常，返回 conflict 信封
    conflict_client = HttpToolClient(
        base_url="http://test", token="t",
        transport=httpx.MockTransport(lambda request: httpx.Response(409, json={})),
    )
    assert await conflict_client.price_adjust(tenant, proposal) == {
        "ok": False, "error": "price_conflict", "conflict": True,
    }

    # 422（护栏拒绝）：不抛异常，返回 guard_rejected 信封
    guard_client = HttpToolClient(
        base_url="http://test", token="t",
        transport=httpx.MockTransport(lambda request: httpx.Response(422, json={})),
    )
    assert await guard_client.price_adjust(tenant, proposal) == {
        "ok": False, "error": "guard_rejected", "guard_rejected": True,
    }
