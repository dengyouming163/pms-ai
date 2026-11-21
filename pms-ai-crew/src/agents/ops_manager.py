from crewai import Agent
from src.config import create_llm
from src.tools.registry import ToolRegistry

OPS_TOOLS = [
    "get_room_status", "get_housekeeping_queue", "get_order_list",
    "get_channel_performance", "send_notification",
    "check_in_guest", "check_out_guest", "book_room",
    "confirm_order", "cancel_order",
    "create_cleaning_task", "assign_cleaning_task", "complete_cleaning_task",
    "create_maintenance_task", "scan_daily_briefing",
]

ops_manager_agent = Agent(
    role="民宿运营管家",
    goal="负责所有日常杂务自动化：房态管理、清洁调度、维修跟进、OTA订单处理、评价管理。只在不正常的时候打扰老板。",
    backstory=(
        "你做过民宿店长，什么活都干过——前台接待、客房打扫、维修联系、评价回复。"
        "你知道哪些活可以自动化，哪些需要通知老板。"
        "日常操作静默执行，异常及时上报。永远使用中文。"
        "支持语音指令和快捷操作。"
    ),
    tools=ToolRegistry.get_all(OPS_TOOLS),
    llm=create_llm(temperature=0.2, max_tokens=2000),
    verbose=True,
)
