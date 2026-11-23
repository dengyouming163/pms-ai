"""LangSmith 双写开关测试：只有开关为真且 key 非空才启用，关闭时零副作用。"""
import os

import pytest

from app.config import Settings
from app.runtime.trace import configure_langsmith

_ENV_KEYS = ("LANGCHAIN_TRACING_V2", "LANGCHAIN_API_KEY", "LANGCHAIN_PROJECT")


@pytest.fixture(autouse=True)
def _clean_langchain_env(monkeypatch):
    """每个用例前后都清掉 LANGCHAIN_*，避免宿主机环境影响断言。"""
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)
    yield
    for key in _ENV_KEYS:
        monkeypatch.delenv(key, raising=False)


def test_disabled_by_default_has_no_side_effects():
    cfg = Settings(langchain_tracing_v2=False, langchain_api_key="")
    assert configure_langsmith(cfg) is False
    assert os.environ.get("LANGCHAIN_TRACING_V2") is None
    assert os.environ.get("LANGCHAIN_API_KEY") is None


def test_tracing_without_key_is_not_enabled():
    cfg = Settings(langchain_tracing_v2=True, langchain_api_key="")
    assert configure_langsmith(cfg) is False
    assert os.environ.get("LANGCHAIN_TRACING_V2") is None


def test_tracing_with_key_sets_env():
    cfg = Settings(
        langchain_tracing_v2=True,
        langchain_api_key="lsv2-test-key",
        langchain_project="pms-ai-test",
    )
    assert configure_langsmith(cfg) is True
    assert os.environ["LANGCHAIN_TRACING_V2"] == "true"
    assert os.environ["LANGCHAIN_API_KEY"] == "lsv2-test-key"
    assert os.environ["LANGCHAIN_PROJECT"] == "pms-ai-test"
