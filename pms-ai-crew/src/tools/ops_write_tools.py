from src.tools.base import HttpTool
from src.tools.registry import ToolRegistry


class CheckInGuest(HttpTool):
    name: str = "check_in_guest"
    description: str = "办理入住，自动创建订单和客户档案。参数: room_id(str), guest_name(str), guest_phone(str), check_out_date(str:YYYY-MM-DD), source(str:可选,默认'自来客')"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/check-in"

    def _run(self, room_id: str, guest_name: str, guest_phone: str = "", check_out_date: str = "", source: str = "") -> dict:
        return self._request("POST", json_body={
            "room_id": room_id, "guest_name": guest_name,
            "guest_phone": guest_phone, "check_out_date": check_out_date,
            "source": source,
        })


class CheckOutGuest(HttpTool):
    name: str = "check_out_guest"
    description: str = "办理退房，自动标记脏房并触发清洁任务创建。参数: room_id(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/check-out"

    def _run(self, room_id: str) -> dict:
        return self._request("POST", json_body={"room_id": room_id})


class BookRoom(HttpTool):
    name: str = "book_room"
    description: str = "预订房间。参数: room_id(str), guest_name(str), guest_phone(str), check_in(str:YYYY-MM-DD), check_out(str:YYYY-MM-DD)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/book"

    def _run(self, room_id: str, guest_name: str, guest_phone: str = "", check_in: str = "", check_out: str = "") -> dict:
        return self._request("POST", json_body={
            "room_id": room_id, "guest_name": guest_name,
            "guest_phone": guest_phone, "check_in": check_in, "check_out": check_out,
        })


class ConfirmOrder(HttpTool):
    name: str = "confirm_order"
    description: str = "确认待处理订单。参数: order_id(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/orders/confirm"

    def _run(self, order_id: str) -> dict:
        return self._request("POST", json_body={"order_id": order_id})


class CancelOrder(HttpTool):
    name: str = "cancel_order"
    description: str = "取消订单。参数: order_id(str), reason(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/orders/cancel"

    def _run(self, order_id: str, reason: str = "") -> dict:
        return self._request("POST", json_body={"order_id": order_id, "reason": reason})


class CreateCleaningTask(HttpTool):
    name: str = "create_cleaning_task"
    description: str = "创建清洁任务。参数: room_id(str), task_type(str:退房清洁/日常保洁/维修/深度清洁/定期检修), priority(str:urgent/high/normal/low)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/housekeeping/create"

    def _run(self, room_id: str, task_type: str = "退房清洁", priority: str = "normal") -> dict:
        return self._request("POST", json_body={
            "room_id": room_id, "task_type": task_type, "priority": priority,
        })


class AssignCleaningTask(HttpTool):
    name: str = "assign_cleaning_task"
    description: str = "分配清洁任务给员工。参数: task_id(str), assignee_id(str), assignee_name(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/housekeeping/assign"

    def _run(self, task_id: str, assignee_id: str, assignee_name: str = "") -> dict:
        return self._request("POST", json_body={
            "task_id": task_id, "assignee_id": assignee_id, "assignee_name": assignee_name,
        })


class CompleteCleaningTask(HttpTool):
    name: str = "complete_cleaning_task"
    description: str = "标记清洁完成，自动恢复房间为可用状态。参数: task_id(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/housekeeping/complete"

    def _run(self, task_id: str) -> dict:
        return self._request("POST", json_body={"task_id": task_id})


class CreateMaintenanceTask(HttpTool):
    name: str = "create_maintenance_task"
    description: str = "标记房间为维修状态。参数: room_id(str), reason(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/maintenance"

    def _run(self, room_id: str, reason: str = "") -> dict:
        return self._request("POST", json_body={"room_id": room_id, "reason": reason})


class ChangeRoom(HttpTool):
    name: str = "change_room"
    description: str = "换房：把客人从A房间换到B房间。参数: room_id(str:源房间ID), to_room_id(str:目标房间ID), reason(str:可选)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/change-room"

    def _run(self, room_id: str, to_room_id: str, reason: str = "") -> dict:
        return self._request("POST", json_body={
            "room_id": room_id, "to_room_id": to_room_id, "reason": reason,
        })


class LockRoom(HttpTool):
    name: str = "lock_room"
    description: str = "锁房：暂停房间售卖。参数: room_id(str), reason(str:可选)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/lock"

    def _run(self, room_id: str, reason: str = "") -> dict:
        return self._request("POST", json_body={"room_id": room_id, "reason": reason})


class UnlockRoom(HttpTool):
    name: str = "unlock_room"
    description: str = "开房/解锁：恢复房间为可用状态。参数: room_id(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/unlock"

    def _run(self, room_id: str) -> dict:
        return self._request("POST", json_body={"room_id": room_id})


class ExtendStay(HttpTool):
    name: str = "extend_stay"
    description: str = "续住：延长住客离店日期。参数: room_id(str), new_check_out_date(str:YYYY-MM-DD)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/extend-stay"

    def _run(self, room_id: str, new_check_out_date: str) -> dict:
        return self._request("POST", json_body={
            "room_id": room_id, "new_check_out_date": new_check_out_date,
        })


class MarkRoomClean(HttpTool):
    name: str = "mark_room_clean"
    description: str = "标记房间为干净（打扫完毕可入住）。参数: room_id(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/mark-clean"

    def _run(self, room_id: str) -> dict:
        return self._request("POST", json_body={"room_id": room_id})


class CancelBook(HttpTool):
    name: str = "cancel_book"
    description: str = "取消预订：取消已预订房间的预订并恢复为可售。参数: room_id(str), reason(str:可选)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/cancel-book"

    def _run(self, room_id: str, reason: str = "") -> dict:
        return self._request("POST", json_body={"room_id": room_id, "reason": reason})


class ModifyBook(HttpTool):
    name: str = "modify_book"
    description: str = "修改预订信息：更新已预订房间的客人、日期等信息。参数: room_id(str), guest_name(str:可选), guest_phone(str:可选), check_in(str:可选YYYY-MM-DD), check_out(str:可选YYYY-MM-DD)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/modify-book"

    def _run(self, room_id: str, guest_name: str = "", guest_phone: str = "", check_in: str = "", check_out: str = "") -> dict:
        body: dict = {"room_id": room_id}
        if guest_name: body["guest_name"] = guest_name
        if guest_phone: body["guest_phone"] = guest_phone
        if check_in: body["check_in"] = check_in
        if check_out: body["check_out"] = check_out
        return self._request("POST", json_body=body)


class MarkRoomDirty(HttpTool):
    name: str = "mark_room_dirty"
    description: str = "标记房间为脏房（退房后需打扫）。参数: room_id(str)"
    http_method: str = "POST"
    tool_path: str = "/api/internal/ai-tools/rooms/mark-dirty"

    def _run(self, room_id: str) -> dict:
        return self._request("POST", json_body={"room_id": room_id})


# Register all tools
for cls in [CheckInGuest, CheckOutGuest, BookRoom, CancelBook, ModifyBook,
            ChangeRoom, LockRoom, UnlockRoom, ExtendStay,
            MarkRoomClean, MarkRoomDirty,
            ConfirmOrder, CancelOrder,
            CreateCleaningTask, AssignCleaningTask, CompleteCleaningTask, CreateMaintenanceTask]:
    ToolRegistry.register(cls())
