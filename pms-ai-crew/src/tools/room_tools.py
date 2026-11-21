from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class GetRoomStatus(HttpTool):
    name: str = "get_room_status"
    description: str = "获取当前房态数据，包括房间状态、住客信息、入住率等"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/rooms/status"

    def _run(self, date: str = "") -> dict:
        params = {"date": date} if date else {}
        return self._request("GET", params=params)


class GetHousekeepingQueue(HttpTool):
    name: str = "get_housekeeping_queue"
    description: str = "获取待清洁房间队列"
    http_method: str = "GET"
    tool_path: str = "/api/internal/ai-tools/rooms/housekeeping-queue"

    def _run(self) -> dict:
        return self._request("GET")


ToolRegistry.register(GetRoomStatus())
ToolRegistry.register(GetHousekeepingQueue())
