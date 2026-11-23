"""LLM Provider 抽象：回放（replay）与在线（live）共用同一接口。"""
from typing import Protocol, runtime_checkable


@runtime_checkable
class LLMProvider(Protocol):
    """大模型调用协议。

    complete 返回统一信封：{"content": str, "usage": {prompt_tokens, completion_tokens, total_tokens}}。
    回放模式未命中时抛 FixtureMissingError，禁止回落真实模型（规格 §10）。
    """

    async def complete(self, model: str, prompt: str) -> dict: ...
