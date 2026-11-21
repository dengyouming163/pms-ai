from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class GetOrderList(HttpTool):
    name: str = "get_order_list"
    description: str = "获取订单列表，支持按状态、日期范围筛选和分页"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/orders"

    def _run(self, status: str = "", date_from: str = "", date_to: str = "", page: int = 1, limit: int = 20) -> dict:
        params = {"page": str(page), "limit": str(limit)}
        if status: params["status"] = status
        if date_from: params["date_from"] = date_from
        if date_to: params["date_to"] = date_to
        return self._request("GET", params=params)


class GetOrderDetail(HttpTool):
    name: str = "get_order_detail"
    description: str = "获取单个订单详细信息"
    http_method: str = "GET"

    def _run(self, order_id: str) -> dict:
        saved_path = self.tool_path
        self.tool_path = f"/api/internal/ai-tools/orders/{order_id}"
        result = self._request("GET")
        self.tool_path = saved_path
        return result


ToolRegistry.register(GetOrderList())
ToolRegistry.register(GetOrderDetail())
