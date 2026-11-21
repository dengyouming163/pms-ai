from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class GetFinanceSummary(HttpTool):
    name: str = "get_finance_summary"
    description: str = "获取收支汇总数据，包括月收入、今日收入、订单统计"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/finance/summary"

    def _run(self, period: str = "this_month") -> dict:
        return self._request("GET", params={"period": period})


class GetChannelStats(HttpTool):
    name: str = "get_channel_performance"
    description: str = "获取各渠道的订单量和收益对比统计"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/channels/stats"

    def _run(self) -> dict:
        return self._request("GET")


class GetDashboardKpi(HttpTool):
    name: str = "get_dashboard_kpi"
    description: str = "获取经营仪表盘核心KPI：今日收益、入住率、订单数等"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/kpi/dashboard"

    def _run(self) -> dict:
        return self._request("GET")


ToolRegistry.register(GetFinanceSummary())
ToolRegistry.register(GetChannelStats())
ToolRegistry.register(GetDashboardKpi())
