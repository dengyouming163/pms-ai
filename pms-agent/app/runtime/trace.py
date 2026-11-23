"""LangChain 追踪回调：把节点/工具/模型的开始/结束/错误写入事件流。

设计要点：
- 继承 BaseCallbackHandler，覆盖 on_chain_* / on_tool_* / on_llm_*。
- 事件写入器（sink）可注入：测试传假 sink 不连库；生产缺省 sink 用 DB 连接
  调 append_event（延迟导入避免循环依赖）。
- 任何 sink 异常都不得中断主流程：_emit 包 try/except，失败时记 warning 并
  best-effort 再写一条 trace_error（内层再捕获，防止递归失败拖垮）。
"""
from __future__ import annotations

import logging
from typing import Any, Callable

from langchain_core.callbacks import BaseCallbackHandler

from app.runtime.utils import now_utc

logger = logging.getLogger(__name__)

# sink 签名：(**kwargs) -> None，kwargs 含 run_id/node/type/payload/started_at/...
EventSink = Callable[..., Any]


def _default_sink(
    *,
    run_id: str,
    node: str | None,
    type: str,
    payload: dict | None = None,
    started_at=None,
    ended_at=None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    trace_id: str | None = None,
) -> None:
    """缺省事件写入器：开一条 DB 连接调 append_event。延迟导入 db 避免循环。"""
    from app.persistence.db import get_conn
    from app.persistence.events import append_event

    with get_conn() as conn:
        append_event(
            conn, run_id, node, type, payload,
            started_at=started_at, ended_at=ended_at,
            tokens_in=tokens_in, tokens_out=tokens_out, trace_id=trace_id,
        )


def _short(value: Any, limit: int = 500) -> str:
    """把任意值安全截断成短字符串，避免 payload 过大或不可序列化。"""
    try:
        text = value if isinstance(value, str) else repr(value)
    except Exception:
        text = "<unrepresentable>"
    return text[:limit]


class TraceCallbackHandler(BaseCallbackHandler):
    """把图执行过程落库到 agent_events；异常不影响主流程。"""

    def __init__(self, run_id: str, sink: EventSink | None = None,
                 trace_id: str | None = None):
        super().__init__()
        self.run_id = run_id
        self.trace_id = trace_id
        self._sink: EventSink = sink or _default_sink
        # run_id(str) -> {"node": str, "started_at": datetime}
        self._starts: dict[str, dict[str, Any]] = {}

    # ---- 内部 ----

    def _node_name(self, serialized: dict | None, kwargs: dict) -> str:
        """langgraph 把节点名放在 kwargs['name']；兜底取 serialized['name']。"""
        return (
            kwargs.get("name")
            or (serialized or {}).get("name")
            or "unknown"
        )

    def _emit(
        self,
        type: str,
        node: str | None,
        payload: dict | None = None,
        started_at=None,
        ended_at=None,
        tokens_in: int | None = None,
        tokens_out: int | None = None,
    ) -> None:
        try:
            self._sink(
                run_id=self.run_id, node=node, type=type, payload=payload or {},
                started_at=started_at, ended_at=ended_at,
                tokens_in=tokens_in, tokens_out=tokens_out, trace_id=self.trace_id,
            )
        except Exception as exc:
            logger.warning(
                "trace 写入事件失败 run_id=%s type=%s node=%s: %r",
                self.run_id, type, node, exc,
            )
            # best-effort 记一条 trace_error；若再次失败也只记日志，绝不向上抛
            try:
                self._sink(
                    run_id=self.run_id, node=node or "trace", type="trace_error",
                    payload={"error": repr(exc), "failed_type": type},
                    trace_id=self.trace_id,
                )
            except Exception:
                logger.warning("trace_error 写入也失败 run_id=%s", self.run_id)

    @staticmethod
    def _extract_tokens(response: Any) -> tuple[int | None, int | None]:
        """从 LLMResult 提取 prompt/completion token 数，取不到返回 (None, None)。"""
        for attr in ("llm_output", "usage"):
            usage = getattr(response, attr, None)
            if isinstance(usage, dict):
                tu = usage.get("token_usage") or usage
                if isinstance(tu, dict):
                    return tu.get("prompt_tokens"), tu.get("completion_tokens")
        return None, None

    # ---- 节点（chain） ----

    def on_chain_start(self, serialized, inputs, *, run_id, **kwargs):
        node = self._node_name(serialized, kwargs)
        started_at = now_utc()
        self._starts[str(run_id)] = {"node": node, "started_at": started_at}
        self._emit("node_start", node, payload={"node": node}, started_at=started_at)

    def on_chain_end(self, outputs, *, run_id, **kwargs):
        node = self._pop_node(run_id, kwargs)
        started_at = self._starts.get(str(run_id), {}).get("started_at")
        self._emit("node_end", node, payload={"node": node},
                   started_at=started_at, ended_at=now_utc())

    def on_chain_error(self, error, *, run_id, **kwargs):
        node = self._pop_node(run_id, kwargs)
        self._emit("node_error", node,
                   payload={"node": node, "error": _short(error)}, ended_at=now_utc())

    def _pop_node(self, run_id, kwargs) -> str | None:
        info = self._starts.pop(str(run_id), None)
        if info:
            return info["node"]
        return self._node_name(None, kwargs)

    # ---- 工具 ----

    def on_tool_start(self, serialized, input_str, *, run_id, **kwargs):
        node = self._node_name(serialized, kwargs)
        self._starts[str(run_id)] = {"node": node, "started_at": now_utc()}
        self._emit("tool_start", node,
                   payload={"tool": node, "input": _short(input_str)},
                   started_at=now_utc())

    def on_tool_end(self, output, *, run_id, **kwargs):
        info = self._starts.pop(str(run_id), {})
        node = info.get("node") or self._node_name(None, kwargs)
        self._emit("tool_end", node,
                   payload={"tool": node, "output": _short(output)},
                   started_at=info.get("started_at"), ended_at=now_utc())

    def on_tool_error(self, error, *, run_id, **kwargs):
        info = self._starts.pop(str(run_id), {})
        node = info.get("node") or self._node_name(None, kwargs)
        self._emit("tool_error", node,
                   payload={"tool": node, "error": _short(error)}, ended_at=now_utc())

    # ---- 模型 ----

    def on_llm_start(self, serialized, prompts, *, run_id, **kwargs):
        node = self._node_name(serialized, kwargs)
        self._starts[str(run_id)] = {"node": node, "started_at": now_utc()}
        self._emit("llm_start", node, payload={"model": node}, started_at=now_utc())

    def on_llm_end(self, response, *, run_id, **kwargs):
        info = self._starts.pop(str(run_id), {})
        node = info.get("node") or self._node_name(None, kwargs)
        tokens_in, tokens_out = self._extract_tokens(response)
        self._emit("llm_end", node,
                   payload={"model": node, "tokens_in": tokens_in, "tokens_out": tokens_out},
                   started_at=info.get("started_at"), ended_at=now_utc(),
                   tokens_in=tokens_in, tokens_out=tokens_out)

    def on_llm_error(self, error, *, run_id, **kwargs):
        info = self._starts.pop(str(run_id), {})
        node = info.get("node") or self._node_name(None, kwargs)
        self._emit("llm_error", node,
                   payload={"model": node, "error": _short(error)}, ended_at=now_utc())


__all__ = ["TraceCallbackHandler"]
