"""联网检索所需的配置常量与密钥链。

🔴 本文件的存在前提（别删）：`config.py:15-16` 的 `AI_MAX_DAILY_TOKENS` /
`AI_MONTHLY_BUDGET` **全仓没有任何读取点** —— 它们看着像既有预算闸，实际是死常量。
所以「给付费按钮配上限」是新建，不是复用。后者见下面 `test_daily_limit_default`。
"""
import pytest

from src import config


def test_search_endpoint_is_native_not_compatible_mode():
    """检索走 **原生** 端点：compatible-mode 那条拿不到来源列表（实测四种组合，见
    docs/superpowers/specs/2026-09-23-wenlv-material-collect-assist-design.md §3（外层仓库））。"""
    assert config.DASHSCOPE_SEARCH_URL == (
        "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation"
    )
    assert "compatible-mode" not in config.DASHSCOPE_SEARCH_URL


def test_search_model_default_is_qwen3_max():
    """qwen-max 拿不到 search_info；可用的是 qwen3-max（实测）。"""
    import os
    if "LLM_MODEL_DASHSCOPE_SEARCH" not in os.environ:
        assert config.DASHSCOPE_SEARCH_MODEL == "qwen3-max"
    else:
        pytest.skip("env 里已设该变量，本机无法验证默认值")


def test_daily_limit_default():
    """每人每日上限。这是**新建**的闸（见模块 docstring）。"""
    import os
    if "AI_MATERIAL_OPTIMIZE_DAILY_LIMIT" not in os.environ:
        assert config.AI_MATERIAL_OPTIMIZE_DAILY_LIMIT == 50
        assert isinstance(config.AI_MATERIAL_OPTIMIZE_DAILY_LIMIT, int)
    else:
        pytest.skip("env 里已设该变量，本机无法验证默认值")


def test_search_key_prefers_dashscope_specific(monkeypatch):
    """密钥链第一档：LLM_API_KEY_DASHSCOPE。"""
    monkeypatch.setenv("LLM_API_KEY_DASHSCOPE", "sk-specific")
    monkeypatch.setenv("LLM_API_KEY", "sk-generic")
    assert config.get_search_api_key() == "sk-specific"


def test_search_key_falls_back_to_generic(monkeypatch):
    """密钥链第二档：LLM_API_KEY。"""
    monkeypatch.delenv("LLM_API_KEY_DASHSCOPE", raising=False)
    monkeypatch.setenv("LLM_API_KEY", "sk-generic")
    assert config.get_search_api_key() == "sk-generic"


def test_search_key_treats_empty_as_unset(monkeypatch):
    """第一档被设成**空串**时视同未设，继续落到 LLM_API_KEY。

    空串的 key 没有任何用处，取到它会比取通用的那个更糟。⚠️ 这一点与
    `src/config.py` 里 MODEL_PRESETS 的写法**不同**：那儿是
    os.getenv(X, os.getenv(Y, ""))，空串会**停在空串**上
    （getenv 的 default 只在 X 缺失时生效）。
    """
    monkeypatch.setenv("LLM_API_KEY_DASHSCOPE", "")
    monkeypatch.setenv("LLM_API_KEY", "sk-generic")
    assert config.get_search_api_key() == "sk-generic"


def test_search_key_empty_when_unset(monkeypatch):
    monkeypatch.delenv("LLM_API_KEY_DASHSCOPE", raising=False)
    monkeypatch.delenv("LLM_API_KEY", raising=False)
    assert config.get_search_api_key() == ""
