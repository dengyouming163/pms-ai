"""C端管家工具——排房推荐 + 民宿信息查询"""
from crewai.tools import BaseTool
from src.tools.mini.room_matcher import match_rooms
from src.tools.registry import ToolRegistry
from src.tools.base import HttpTool
import httpx


class GetPropertyInfo(HttpTool):
    name: str = "get_property_info"
    description: str = "获取民宿基本信息：名称、地址、电话、设施、取消政策、周边推荐"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/mini/property-info"

    def _run(self) -> dict:
        return self._request("GET")


class SmartRoomMatch(BaseTool):
    name: str = "smart_room_match"
    description: str = (
        "智能排房推荐：根据入住日期、天数、人数给出最优排房方案。"
        "输入: check_in(YYYY-MM-DD), nights(整数), guests(整数,可选), preferences(字符串,可选)。"
        "返回: 排房方案列表，含每段房型/日期/价格/换房次数。"
    )

    def _run(self, check_in: str, nights: int, guests: int = 2, preferences: str = "") -> dict:
        try:
            with httpx.Client(timeout=10) as client:
                resp = client.get(
                    "http://pms-server:9090/api/internal/ai-tools/mini/room-availability",
                    params={"check_in": check_in, "nights": str(nights)},
                    headers={"X-Internal-Service-Token": "dev-internal-token"},
                )
                data = resp.json() if resp.status_code == 200 else {}
        except Exception as e:
            return {"plans": [], "error": f"房态数据获取失败: {str(e)}"}

        if not data.get("availabilities"):
            return {"plans": [], "message": f"{check_in} 起 {nights} 晚暂无可订房型"}

        plans = match_rooms(
            availabilities=data["availabilities"],
            room_info=data.get("room_info", {}),
            check_in=check_in, nights=nights,
        )

        return {
            "check_in": check_in, "nights": nights,
            "plans": [{
                "segments": [{"room_type_name": s.room_type_name, "check_in": s.check_in,
                              "check_out": s.check_out, "nights": s.nights,
                              "price_per_night": s.price_per_night, "total": s.total_price}
                             for s in p.segments],
                "total_price": p.total_price, "swap_count": p.swap_count,
            } for p in plans],
        }


ToolRegistry.register(GetPropertyInfo())
ToolRegistry.register(SmartRoomMatch())
