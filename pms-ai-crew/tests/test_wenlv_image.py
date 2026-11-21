"""文生图 provider 抽象测试：mock 占位 + wanx 路由 + jimeng 占位。"""
import asyncio
import os

import pytest

from src.services.wenlv_image import (
    JimengImageProvider,
    MockImageProvider,
    WanxImageProvider,
    get_image_provider,
)


def test_mock_provider_returns_placeholder():
    p = MockImageProvider()
    r = asyncio.run(p.generate("test prompt", "avatar"))
    assert "placeholder.local" in r["url"]
    assert r["asset_type"] == "avatar"
    assert r["meta"]["provider"] == "mock"


def test_default_provider_is_mock():
    os.environ.pop("WENLV_IMAGE_PROVIDER", None)
    p = get_image_provider()
    assert isinstance(p, MockImageProvider)


def test_wanx_provider_env_routing():
    os.environ["WENLV_IMAGE_PROVIDER"] = "wanx"
    try:
        p = get_image_provider()
        assert isinstance(p, WanxImageProvider)
    finally:
        os.environ.pop("WENLV_IMAGE_PROVIDER", None)


def test_jimeng_provider_env_routing():
    os.environ["WENLV_IMAGE_PROVIDER"] = "jimeng"
    try:
        p = get_image_provider()
        assert isinstance(p, JimengImageProvider)
        with pytest.raises(NotImplementedError):
            asyncio.run(p.generate("test", "avatar"))
    finally:
        os.environ.pop("WENLV_IMAGE_PROVIDER", None)


def test_wanx_provider_no_key_raises():
    # 没配 key 时调用 generate 应抛 RuntimeError
    os.environ.pop("LLM_API_KEY_DASHSCOPE", None)
    os.environ.pop("LLM_API_KEY", None)
    p = WanxImageProvider()
    with pytest.raises(RuntimeError, match="DASHSCOPE_API_KEY"):
        asyncio.run(p.generate("test", "avatar"))
