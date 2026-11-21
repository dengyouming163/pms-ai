import httpx
from typing import Any, Optional
from crewai.tools import BaseTool
from src.config import PMS_SERVER_URL, INTERNAL_SERVICE_TOKEN


class HttpTool(BaseTool):
    http_method: str = "GET"
    tool_path: str = ""
    timeout: float = 10.0
    max_retries: int = 2
    merchant_id: str = ""
    store_id: str = ""

    def _get_client(self) -> httpx.Client:
        return httpx.Client(
            base_url=PMS_SERVER_URL,
            headers={
                "X-Internal-Service-Token": INTERNAL_SERVICE_TOKEN,
                "X-Merchant-Id": self.merchant_id,
                "X-Store-Id": self.store_id,
                "Content-Type": "application/json",
            },
            timeout=self.timeout,
        )

    def _request(self, method: str, params: Optional[dict] = None, json_body: Optional[dict] = None) -> dict:
        for attempt in range(self.max_retries + 1):
            try:
                with self._get_client() as client:
                    if method == "GET":
                        resp = client.get(self.tool_path, params=params or {})
                    else:
                        resp = client.request(method, self.tool_path, params=params or {}, json=json_body or {})
                    resp.raise_for_status()
                    return resp.json()
            except httpx.HTTPError as e:
                if attempt >= self.max_retries:
                    return {"error": f"Tool 调用失败: {str(e)}"}
        return {"error": "Tool 调用失败"}
