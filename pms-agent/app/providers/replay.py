"""回放 Provider：从 jsonl 夹具按 (model, sha256(prompt)) 查找固定响应。

夹具格式（全项目统一）：每行一个 JSON
  {"prompt_hash": "<sha256_hex of prompt>", "model": "<str>",
   "content": "<str>", "usage": {"prompt_tokens": int, "completion_tokens": int, "total_tokens": int}}

未命中即抛 FixtureMissingError —— 绝不回落真实模型（规格 §10 硬性要求）。
"""
from __future__ import annotations

import hashlib
import json
from pathlib import Path

from app.config import settings


def prompt_hash(prompt: str) -> str:
    """计算 prompt 的 sha256（utf-8），作为夹具查找键。"""
    return hashlib.sha256(prompt.encode("utf-8")).hexdigest()


class FixtureMissingError(Exception):
    """回放夹具未命中。携带 model / prompt_hash / fixtures_dir 便于排查。"""

    def __init__(self, model: str, prompt_hash_value: str, fixtures_dir: Path | str):
        self.model = model
        self.prompt_hash = prompt_hash_value
        self.fixtures_dir = str(fixtures_dir)
        super().__init__(
            f"回放夹具未命中：model={model} prompt_hash={prompt_hash_value} "
            f"fixtures_dir={self.fixtures_dir}（禁止回落真实模型）"
        )


class ReplayProvider:
    """只读回放：命中返回固定 content+usage，未命中抛 FixtureMissingError。"""

    def __init__(self, fixtures_dir: str | Path | None = None):
        # 测试可注入临时夹具目录；缺省取配置（相对仓库根 eval/fixtures）
        self.fixtures_dir = Path(fixtures_dir) if fixtures_dir else Path(settings.fixtures_dir)
        # 构造时一次性加载索引（测试需在构造 provider 前写好夹具文件）
        self._index: dict[tuple[str, str], dict] = self._load_index()

    def _load_index(self) -> dict[tuple[str, str], dict]:
        index: dict[tuple[str, str], dict] = {}
        if not self.fixtures_dir.exists():
            return index
        # 按文件名排序，保证加载顺序确定（同名键后者覆盖，但正常不应重复）
        for path in sorted(self.fixtures_dir.glob("*.jsonl")):
            with path.open("r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    rec = json.loads(line)
                    key = (str(rec["model"]), str(rec["prompt_hash"]))
                    index[key] = {
                        "content": rec["content"],
                        "usage": rec["usage"],
                    }
        return index

    async def complete(self, model: str, prompt: str) -> dict:
        key = (model, prompt_hash(prompt))
        if key not in self._index:
            raise FixtureMissingError(model, key[1], self.fixtures_dir)
        # 返回副本，避免外部修改污染缓存
        hit = self._index[key]
        return {"content": hit["content"], "usage": dict(hit["usage"])}
