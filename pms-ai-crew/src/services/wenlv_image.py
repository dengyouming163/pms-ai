"""文生图 provider 抽象（spec §5.3 可插拔路由）。

- ImageProvider：抽象基类，`async generate(prompt, asset_type) -> dict`。
- MockImageProvider：占位 provider，返回占位图 URL（spec §9 文生图失败回退占位图）。
- WanxImageProvider：通义万相 DashScope 异步提交 + 轮询，返回真实图片 URL。
- JimengImageProvider：即梦 provider 占位（未实现，抛 NotImplementedError）。
"""
import os
import asyncio
from abc import ABC, abstractmethod

import httpx


DASHSCOPE_BASE_URL = os.getenv(
    "DASHSCOPE_BASE_URL",
    os.getenv("LLM_BASE_URL_DASHSCOPE", "https://dashscope.aliyuncs.com"),
)
# 🔴 注意：DASHSCOPE_BASE_URL 默认使用纯域名根（不含 /compatible-mode/v1 后缀），
# 因为 wanx-v1 文生图走 DashScope 原生端点 /api/v1/services/aigc/text2image/image-synthesis，
# compatible-mode 端点会 404。这与 config.py 里 DASHSCOPE_SEARCH_URL 同款约束。


class ImageProvider(ABC):
    """文生图 provider 抽象（async）。"""

    @abstractmethod
    async def generate(self, prompt: str, asset_type: str = "background", **kwargs) -> dict:
        """生成图片，返回 {url, asset_type, prompt, meta}。"""


class MockImageProvider(ImageProvider):
    """占位 provider：返回占位图（供草稿态先审后生成、以及 provider 不可用时的回退）。"""

    async def generate(self, prompt: str, asset_type: str = "background", **kwargs) -> dict:
        return {
            "url": f"https://placeholder.local/{asset_type}?q={len(prompt)}",
            "asset_type": asset_type,
            "prompt": prompt,
            "meta": {"provider": "mock"},
        }


class WanxImageProvider(ImageProvider):
    """通义万相（DashScope wanx-v1）provider：异步提交 + 轮询。

    调用链：
    1. POST /api/v1/services/aigc/text2image/image-synthesis 提交任务，拿 task_id
    2. 每 3 秒 GET /api/v1/tasks/{task_id} 轮询，SUCCEEDED 取 results[0].url，FAILED 抛错
    3. 最多轮询 60 次（180 秒）后超时
    """

    def __init__(self):
        self.api_key = os.getenv("LLM_API_KEY_DASHSCOPE", os.getenv("LLM_API_KEY", ""))
        self.base_url = DASHSCOPE_BASE_URL

    async def generate(self, prompt: str, asset_type: str = "background", **kwargs) -> dict:
        if not self.api_key:
            raise RuntimeError("DASHSCOPE_API_KEY 未配置，无法调用通义万相")
        headers = {"Authorization": f"Bearer {self.api_key}"}
        async with httpx.AsyncClient(timeout=180.0) as client:
            # 1. 提交任务
            submit = await client.post(
                f"{self.base_url}/api/v1/services/aigc/text2image/image-synthesis",
                headers=headers,
                json={
                    "model": "wanx-v1",
                    "input": {"prompt": prompt},
                    "parameters": {"n": 1, "size": "1024*1024"},
                },
            )
            submit.raise_for_status()
            submit_data = submit.json()
            output = submit_data.get("output", {})
            task_id = output.get("task_id")
            if not task_id:
                raise RuntimeError(f"wanx 提交任务失败：响应无 task_id，output={output}")
            # 2. 轮询（最多 60 次 × 3 秒 = 180 秒）
            for _ in range(60):
                await asyncio.sleep(3)
                poll = await client.get(
                    f"{self.base_url}/api/v1/tasks/{task_id}",
                    headers=headers,
                )
                poll.raise_for_status()
                data = poll.json()
                status = data.get("output", {}).get("task_status")
                if status == "SUCCEEDED":
                    results = data["output"].get("results", [])
                    if not results:
                        raise RuntimeError(f"wanx 任务成功但无 results: {data}")
                    return {
                        "url": results[0]["url"],
                        "asset_type": asset_type,
                        "prompt": prompt,
                        "meta": {"provider": "wanx", "task_id": task_id, "raw": data["output"]},
                    }
                if status == "FAILED":
                    raise RuntimeError(f"wanx 任务失败: {data}")
            raise RuntimeError("wanx 任务超时（180 秒内未完成）")


class JimengImageProvider(ImageProvider):
    """即梦 provider 占位：未实现，抛 NotImplementedError。

    即梦 API 未开放或 key 未配置时，由 get_image_provider 路由回退到 Mock。
    """

    async def generate(self, prompt: str, asset_type: str = "background", **kwargs) -> dict:
        raise NotImplementedError("即梦 provider 待 API 开放后接入")


def get_image_provider() -> ImageProvider:
    """按 env 选择 provider；默认 mock（未配置真实 provider 时占位）。

    WENLV_IMAGE_PROVIDER:
    - "mock"（默认）：占位图
    - "wanx"：通义万相（需配 DASHSCOPE_API_KEY）
    - "jimeng"：即梦（未实现，调用即抛 NotImplementedError）
    """
    name = os.getenv("WENLV_IMAGE_PROVIDER", "mock")
    if name == "wanx":
        return WanxImageProvider()
    if name == "jimeng":
        return JimengImageProvider()
    return MockImageProvider()
