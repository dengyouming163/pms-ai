import json
from typing import Any, Dict, List
import httpx
from src.config import PMS_SERVER_URL, INTERNAL_SERVICE_TOKEN


class PmsMemoryStore:
    """自定义 Memory 存储适配器"""

    def __init__(self, merchant_id: str, user_id: str = ""):
        self.merchant_id = merchant_id
        self.user_id = user_id

    def _client(self) -> httpx.Client:
        return httpx.Client(
            base_url=PMS_SERVER_URL,
            headers={
                "X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN,
                "X-Merchant-Id": self.merchant_id,
                "Content-Type": "application/json",
            },
            timeout=5.0,
        )

    def save(self, memory_type: str, key: str, value: Any, importance: float = 0.5) -> bool:
        try:
            with self._client() as client:
                resp = client.post("/api/internal/ai-tools/memory/sync", json={
                    "merchant_id": self.merchant_id,
                    "user_id": self.user_id,
                    "memory_type": memory_type,
                    "key": key,
                    "value": value if isinstance(value, dict) else {"content": str(value)},
                    "importance": importance,
                })
                return resp.status_code == 200
        except Exception:
            return False

    def load(self, memory_type: str, key: str = "", limit: int = 20) -> List[Dict]:
        try:
            with self._client() as client:
                params = {"merchant_id": self.merchant_id, "memory_type": memory_type, "limit": str(limit)}
                if key: params["key"] = key
                resp = client.get("/api/internal/ai-tools/memory/load", params=params)
                if resp.status_code == 200:
                    return resp.json().get("memories", [])
        except Exception:
            pass
        return []

    def load_user_prefs(self) -> Dict:
        memories = self.load("user_preference", self.user_id, limit=10)
        prefs = {"pricing_style": "balanced", "communication_style": "detailed", "rejected_patterns": []}
        for m in memories:
            val = m.get("value", {})
            if isinstance(val, str): val = json.loads(val)
            prefs.update(val)
        return prefs
