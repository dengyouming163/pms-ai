from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class GetCompetitorPrices(HttpTool):
    name: str = "get_competitor_prices"
    description: str = "获取已录入的周边竞品民宿价格列表，用于定价对标分析"
    http_method: str = "GET"
    tool_path: str = "/api/competitor"

    def _run(self) -> dict:
        return self._request("GET")


class AddCompetitorPrice(HttpTool):
    name: str = "add_competitor_price"
    description: str = "手动录入一家竞品民宿的价格信息。参数: name(str:民宿名), platform(str:平台), roomType(str:房型), price(float:价格), notes(str:备注)"
    http_method: str = "POST"
    tool_path: str = "/api/competitor"

    def _run(self, name: str, platform: str = "", roomType: str = "", price: float = 0, notes: str = "") -> dict:
        return self._request("POST", json_body={"name": name, "platform": platform, "roomType": roomType, "price": price, "notes": notes})


ToolRegistry.register(GetCompetitorPrices())
ToolRegistry.register(AddCompetitorPrice())
