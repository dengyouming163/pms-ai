from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class GetPricingCalendar(HttpTool):
    name: str = "get_pricing_calendar"
    description: str = "获取价格日历和房型基础价格信息"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/pricing/calendar"

    def _run(self, from_date: str = "", to_date: str = "") -> dict:
        params = {}
        if from_date: params["from"] = from_date
        if to_date: params["to"] = to_date
        return self._request("GET", params=params)


ToolRegistry.register(GetPricingCalendar())
