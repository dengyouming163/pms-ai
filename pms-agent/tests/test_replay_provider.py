"""ReplayProvider 单元测试：命中返回 content+usage，未命中抛 FixtureMissingError（禁止回落真实模型）。"""
import hashlib
import json

import pytest

from app.providers.replay import FixtureMissingError, ReplayProvider, prompt_hash


def _write_fixture(tmp_path, model: str, prompt_text: str, content: str, usage: dict,
                   filename: str = "fixtures.jsonl") -> str:
    h = prompt_hash(prompt_text)
    rec = {"prompt_hash": h, "model": model, "content": content, "usage": usage}
    (tmp_path / filename).write_text(
        json.dumps(rec, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    return h


async def test_replay_hit_returns_content_and_usage(tmp_path):
    model = "deepseek-chat"
    prompt = "你好，世界"
    content = '{"suggestedPrice": 400}'
    usage = {"prompt_tokens": 10, "completion_tokens": 5, "total_tokens": 15}
    _write_fixture(tmp_path, model, prompt, content, usage)

    provider = ReplayProvider(fixtures_dir=tmp_path)
    result = await provider.complete(model, prompt)

    assert result["content"] == content
    assert result["usage"] == usage


async def test_replay_miss_raises_fixture_missing_error(tmp_path):
    # 目录存在但无匹配夹具 → 必须抛异常，不得回落真实模型
    provider = ReplayProvider(fixtures_dir=tmp_path)
    with pytest.raises(FixtureMissingError):
        await provider.complete("deepseek-chat", "不存在的 prompt")


async def test_replay_miss_when_model_differs(tmp_path):
    # 同 prompt 但 model 不同 → 也视为未命中
    _write_fixture(tmp_path, "deepseek-chat", "p", "c",
                   {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2})
    provider = ReplayProvider(fixtures_dir=tmp_path)
    with pytest.raises(FixtureMissingError):
        await provider.complete("gpt-4", "p")


async def test_replay_loads_multiple_files(tmp_path):
    _write_fixture(tmp_path, "m1", "p1", "c1",
                   {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                   filename="a.jsonl")
    _write_fixture(tmp_path, "m2", "p2", "c2",
                   {"prompt_tokens": 1, "completion_tokens": 1, "total_tokens": 2},
                   filename="b.jsonl")
    provider = ReplayProvider(fixtures_dir=tmp_path)
    assert (await provider.complete("m1", "p1"))["content"] == "c1"
    assert (await provider.complete("m2", "p2"))["content"] == "c2"


def test_prompt_hash_is_sha256_of_utf8_and_deterministic():
    assert prompt_hash("abc") == hashlib.sha256("abc".encode("utf-8")).hexdigest()
    assert prompt_hash("abc") == prompt_hash("abc")
    assert prompt_hash("abc") != prompt_hash("abd")
