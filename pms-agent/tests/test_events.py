"""事件溯源与追踪回调测试：纯函数 + 假 sink，不连库不连网。

- next_seq 是纯函数（不连库），直接断言。
- TraceCallbackHandler 通过注入假 sink 验证 on_* 回调能写入、且 sink 抛错时
  不中断主流程（不会向上抛异常，并 best-effort 记一条 trace_error）。
"""
import uuid

from app.persistence.events import next_seq
from app.runtime.trace import TraceCallbackHandler


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
