from crewai import Crew, Process, Task
from src.agents.ops_manager import ops_manager_agent


def create_housekeeping_check_crew(merchant_id: str, store_id: str):
    task = Task(
        description=(
            "请执行房务巡检:\n"
            "1. 拉取房态数据 (get_room_status)\n"
            "2. 拉取清洁队列 (get_housekeeping_queue)\n"
            "3. 检查: 有无超时未清洁的房间(脏房超过2小时未处理)\n"
            "4. 检查: 有无维修中的房间需要跟进\n"
            "5. 检查: 今日预订房间是否都准备就绪\n"
            "6. 如有异常，生成预警通知 (send_notification, priority=4)\n\n"
            "输出: 房务巡检报告——总数/脏房/清洁中/维修/异常项/建议"
        ),
        expected_output="房务巡检报告：房间总数、各状态数量、异常项列表、处理建议",
        agent=ops_manager_agent,
    )
    return Crew(agents=[ops_manager_agent], tasks=[task], process=Process.sequential, verbose=True)
