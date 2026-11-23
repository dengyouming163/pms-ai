"""事件溯源与追踪回调测试：纯函数 + 假 sink + 假连接，不连库不连网。

- next_seq 是纯函数（不连库），直接断言。
- TraceCallbackHandler 通过注入假 sink 验证 on_* 回调能写入、且 sink 抛错时
  不中断主流程（不会向上抛异常，并 best-effort 记一条 trace_error）。
- append_event / list_events 通过 FakeConn（fetchone/fetchall 返回 dict，模拟
  psycopg 的 dict_row 行工厂）验证：不连真实库时，事件仓储对 dict 行的访问
  必须用键而非整数下标，否则 append_event 会 KeyError、list_events 会损坏数据
  （Task 8 回归：dict_row 漏网缺陷）。
"""
import uuid
from contextlib import contextmanager

import pytest
from psycopg.errors import UniqueViolation

from app.persistence.events import append_event, list_events, next_seq
from app.runtime.trace import TraceCallbackHandler


class _Desc:
    """模拟 psycopg cursor.description 元素：只暴露 .name。"""

    def __init__(self, name: str):
        self.name = name


class FakeCursor:
    """模拟 psycopg 游标：fetchone/fetchall 返回 dict（dict_row 行工厂行为）。

    insert_failures：前 N 次 INSERT 执行抛 UniqueViolation，模拟并发 seq 冲突；
    之后的 INSERT 成功。设为极大值可模拟「一直冲突」。
    """

    def __init__(self, fetchone_result=None, fetchall_result=None, insert_failures: int = 0):
        self.fetchone_result = fetchone_result
        self.fetchall_result = fetchall_result if fetchall_result is not None else []
        self.insert_failures = insert_failures
        self.insert_attempts = 0  # 已尝试的 INSERT 次数（含失败）
        # 与 list_events 的 SELECT 列对齐
        self.description = [_Desc(n) for n in [
            "seq", "node", "type", "payload", "started_at", "ended_at",
            "tokens_in", "tokens_out", "trace_id", "created_at",
        ]]
        self.executes: list[tuple] = []  # 记录每次 (sql, params)，失败的也记录

    def execute(self, sql: str, params=None):
        self.executes.append((sql, params))
        if "INSERT" in sql.upper():
            self.insert_attempts += 1
            if self.insert_attempts <= self.insert_failures:
                raise UniqueViolation()

    def fetchone(self):
        return self.fetchone_result

    def fetchall(self):
        return self.fetchall_result

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False


class FakeConn:
    """模拟 psycopg 连接：cursor() 与 transaction() 都是上下文管理器。"""

    def __init__(self, cursor: FakeCursor):
        self._cursor = cursor

    def cursor(self):
        return self._cursor

    @contextmanager
    def transaction(self):
        # psycopg conn.transaction() 是上下文管理器；测试中无需真实事务
        yield


def test_append_event_reads_dict_row_by_key_not_index():
    """P0-1 回归：db.py 用 dict_row，fetchone 返回 dict。必须 row['max_seq']，
    否则 row[0] 抛 KeyError: 0，append_event 首次调用即崩。"""
    cur = FakeCursor(fetchone_result={"max_seq": 5})
    conn = FakeConn(cur)

    seq = append_event(conn, "run-1", node="run", type="run_started",
                       payload={"goal": "x"})

    assert seq == 6  # 5 + 1
    # 执行了两条 SQL：查 max + 插入
    assert len(cur.executes) == 2
    select_sql, _ = cur.executes[0]
    assert "max_seq" in select_sql  # 聚合列起了别名
    insert_sql, insert_params = cur.executes[1]
    assert "INSERT" in insert_sql.upper()
    # 插入参数中 seq 位置应为 6
    assert insert_params[1] == 6


def test_append_event_first_seq_when_no_rows():
    """空 run：fetchone 返回 {'max_seq': 0}（COALESCE 兜底），首条事件 seq=1。"""
    cur = FakeCursor(fetchone_result={"max_seq": 0})
    seq = append_event(FakeConn(cur), "run-new", node="run", type="run_started")
    assert seq == 1
    assert cur.executes[1][1][1] == 1


def test_append_event_retries_multiple_times_before_success():
    """≥3 并发同 run 写时，旧实现只重试一次（range(2)）会直接抛错。
    新实现须有界重试多次：前 2 次 INSERT 冲突、第 3 次成功，最终返回正确 seq。"""
    cur = FakeCursor(fetchone_result={"max_seq": 5}, insert_failures=2)

    seq = append_event(FakeConn(cur), "run-1", node="run", type="run_started")

    assert seq == 6
    # 共尝试了 3 次 INSERT（前 2 次冲突、第 3 次成功）
    assert cur.insert_attempts == 3
    # 最后一次 INSERT 的 seq 参数应为 6
    assert cur.executes[-1][1][1] == 6


def test_append_event_raises_after_exhausting_retries():
    """冲突持续到耗尽重试次数时，必须向上抛异常（不得静默成功，也不得死循环）。"""
    cur = FakeCursor(fetchone_result={"max_seq": 5}, insert_failures=10**9)

    with pytest.raises(UniqueViolation):
        append_event(FakeConn(cur), "run-1", node="run", type="run_started")

    # 重试有界：INSERT 尝试次数应等于最大重试次数（5），而非无限循环
    assert cur.insert_attempts == 5


def test_list_events_returns_dict_rows_unchanged():
    """P0-1 回归：dict_row 下 fetchall 已是 dict 列表，不得再 dict(zip(cols, row))
    否则值会被列名覆盖（{'seq': 'seq', ...}），SSE 数据全损坏。"""
    raw = [
        {"seq": 1, "node": "run", "type": "run_started", "payload": {"goal": "x"},
         "started_at": None, "ended_at": None, "tokens_in": None,
         "tokens_out": None, "trace_id": None, "created_at": "t0"},
        {"seq": 2, "node": "supervisor", "type": "node_start", "payload": {},
         "started_at": "t1", "ended_at": None, "tokens_in": None,
         "tokens_out": None, "trace_id": "tr", "created_at": "t2"},
    ]
    cur = FakeCursor(fetchall_result=raw)
    out = list_events(FakeConn(cur), "run-1", after_seq=0)

    assert out == raw  # 原样返回，值未被列名覆盖
    assert out[0]["seq"] == 1  # 是整数 1，不是字符串 "seq"
    assert out[1]["type"] == "node_start"


def test_seq_is_monotonic():
    assert next_seq(0) == 1
    assert next_seq(41) == 42


def test_seq_handles_none_as_zero():
    """MAX(seq) 为空时 COALESCE 回落到 0，next_seq 应从 1 开始。"""
    assert next_seq(None) == 1


def test_trace_callback_emits_node_events_to_injected_sink():
    calls: list[dict] = []

    def sink(**kwargs):
        calls.append(kwargs)

    h = TraceCallbackHandler("run-x", sink=sink, trace_id="trace-1")
    rid = uuid.uuid4()
    h.on_chain_start({"name": "supervisor"}, {"goal": "x"}, run_id=rid, name="supervisor")
    h.on_chain_end({"route": "revenue"}, run_id=rid, name="supervisor")

    types = [c["type"] for c in calls]
    assert "node_start" in types
    assert "node_end" in types
    # 每次写入都携带 run_id 与 trace_id
    for c in calls:
        assert c["run_id"] == "run-x"
        assert c["trace_id"] == "trace-1"


def test_trace_callback_ignores_graph_interrupt():
    """interrupt() 挂起会以 GraphInterrupt 结束节点，属正常控制流，不应记为错误。"""
    calls: list[dict] = []

    def sink(**kwargs):
        calls.append(kwargs)

    class GraphInterrupt(Exception):
        pass

    h = TraceCallbackHandler("run-i", sink=sink)
    rid = uuid.uuid4()
    h.on_chain_start({"name": "revenue_request_approval"}, {}, run_id=rid,
                     name="revenue_request_approval")
    h.on_chain_error(GraphInterrupt({"type": "approval_required"}), run_id=rid,
                     name="revenue_request_approval")

    types = [c["type"] for c in calls]
    assert "node_error" not in types
    assert "trace_error" not in types


def test_trace_callback_emits_tool_and_llm_events():
    calls: list[dict] = []

    def sink(**kwargs):
        calls.append(kwargs)

    h = TraceCallbackHandler("run-z", sink=sink)
    h.on_tool_start({"name": "occupancy"}, "{}", run_id=uuid.uuid4(), name="occupancy")
    h.on_tool_end('{"ok": true}', run_id=uuid.uuid4(), name="occupancy")
    h.on_llm_start({"name": "gpt"}, ["p"], run_id=uuid.uuid4(), name="gpt")
    h.on_llm_end(_FakeLLMResult(prompt_tokens=10, completion_tokens=5),
                 run_id=uuid.uuid4(), name="gpt")

    types = [c["type"] for c in calls]
    assert "tool_start" in types
    assert "tool_end" in types
    assert "llm_start" in types
    assert "llm_end" in types


def test_trace_callback_swallows_sink_errors():
    """sink 抛任何异常都不得中断主流程：不向上抛，并 best-effort 记 trace_error。"""
    calls: list[dict] = []

    def boom(**kwargs):
        calls.append(kwargs)
        raise RuntimeError("db down")

    h = TraceCallbackHandler("run-y", sink=boom)
    # 不应抛异常
    h.on_chain_start({"name": "revenue_collect"}, {}, run_id=uuid.uuid4(),
                     name="revenue_collect")
    h.on_chain_end({}, run_id=uuid.uuid4(), name="revenue_collect")

    # sink 抛错后仍会尝试写 trace_error（即便 trace_error 写入也失败，被内层捕获）
    assert any(c["type"] == "trace_error" for c in calls)


class _FakeLLMResult:
    """模拟 langchain LLMResult：llm_output 含 token_usage。"""

    def __init__(self, prompt_tokens=0, completion_tokens=0):
        self.llm_output = {"token_usage": {
            "prompt_tokens": prompt_tokens, "completion_tokens": completion_tokens,
        }}
