from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class ScanDailyBriefing(HttpTool):
    name: str = "scan_daily_briefing"
    description: str = "获取今日运营全貌：入住列表、退房列表、脏房队列、超时订单、异常房间、统计摘要"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/ops/daily-briefing"

    def _run(self) -> dict:
        return self._request("GET")


class GetCustomerStats(HttpTool):
    name: str = "get_customer_stats"
    description: str = "获取客户总览统计：总数、VIP数、沉睡客户数、本月新增、待关怀数"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/customers/stats"

    def _run(self) -> dict:
        return self._request("GET")


class ListCustomers(HttpTool):
    name: str = "list_customers"
    description: str = "获取客户列表，支持关键词搜索、会员等级筛选、标签筛选、分页。参数: keyword(str), level(str), tag(str), page(int), limit(int)"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/customers"

    def _run(self, keyword: str = "", level: str = "", tag: str = "", page: int = 1, limit: int = 20) -> dict:
        params = {"page": str(page), "limit": str(limit)}
        if keyword: params["keyword"] = keyword
        if level: params["level"] = level
        if tag: params["tag"] = tag
        return self._request("GET", params=params)


ToolRegistry.register(ScanDailyBriefing())
ToolRegistry.register(GetCustomerStats())
ToolRegistry.register(ListCustomers())
