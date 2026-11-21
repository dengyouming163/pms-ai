from crewai import Crew, Process, Task
from src.agents.ops_manager import ops_manager_agent


def create_ota_check_crew(merchant_id: str, store_id: str):
    task = Task(
        description=(
            "请执行OTA渠道巡检:\n"
            "1. 拉取渠道表现数据 (get_channel_performance)\n"
            "2. 拉取最近订单，筛选 status='pending_confirm' (get_order_list)\n"
            "3. 检查是否有超时未确认的OTA订单（超过15分钟未处理）\n"
            "4. 如有超时订单，发送紧急预警 (send_notification, priority=5)\n"
            "5. 汇总各渠道评价状态\n\n"
            "输出: OTA巡检报告——各渠道订单数、超时预警数、评价待处理数"
        ),
        expected_output="OTA巡检报告：渠道订单统计、超时预警列表、评价待处理数量",
        agent=ops_manager_agent,
    )
    return Crew(agents=[ops_manager_agent], tasks=[task], process=Process.sequential, verbose=True)


def create_review_reply_crew(merchant_id: str, store_id: str, review_content: str, guest_name: str):
    task = Task(
        description=(
            f"请为以下客人评价生成3套回复草稿:\n\n"
            f"客人: {guest_name}\n评价内容: {review_content}\n\n"
            "请生成3种风格的回复:\n"
            "a. 诚恳道歉+解释原因+补偿方案（适用于差评）\n"
            "b. 简洁正式版（适用于中性评价）\n"
            "c. 温馨人情版（适用于好评，邀请再次入住）\n\n"
            "输出: 3套回复草稿，供老板选择发送"
        ),
        expected_output="3套不同风格的回复草稿",
        agent=ops_manager_agent,
    )
    return Crew(agents=[ops_manager_agent], tasks=[task], process=Process.sequential, verbose=True)
