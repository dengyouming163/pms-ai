from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class GetCustomerProfile(HttpTool):
    name: str = "get_customer_profile"
    description: str = "获取客户画像，包含消费记录、订单历史和偏好信息"
    http_method: str = "GET"

    def _run(self, customer_id: str) -> dict:
        saved_path = self.tool_path
        self.tool_path = f"/api/internal/ai-tools/customers/{customer_id}/profile"
        result = self._request("GET")
        self.tool_path = saved_path
        return result


class SearchCustomers(HttpTool):
    name: str = "search_customers"
    description: str = "按姓名或手机号搜索客户"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/customers/search"

    def _run(self, keyword: str) -> dict:
        return self._request("GET", params={"keyword": keyword})


ToolRegistry.register(GetCustomerProfile())
ToolRegistry.register(SearchCustomers())
