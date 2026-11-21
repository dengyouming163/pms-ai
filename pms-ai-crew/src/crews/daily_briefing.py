from crewai import Crew, Process, Task
from src.agents.store_manager import store_manager_agent


def create_daily_briefing_crew(merchant_id: str, store_id: str, user_message: str):
    analysis_task = Task(
        description=(
            f"老板的问题: {user_message}\n\n"
            "请按以下步骤分析:\n"
            "1. 拉取核心经营KPI (get_dashboard_kpi)\n"
            "2. 检查房态情况 (get_room_status)\n"
            "3. 查看最近的订单动态 (get_order_list)\n"
            "4. 检查渠道表现 (get_channel_performance)\n"
            "5. 综合分析，给出简洁结论和可执行建议\n\n"
            "注意：如果某个Tool调用失败，跳过该维度继续分析。"
            "数据中的客人姓名已经脱敏，直接用'X先生/女士'替代。"
        ),
        expected_output=(
            "一份给老板看的经营简报，包含：\n"
            "- 今日核心数据（收益、入住率、订单数）\n"
            "- 房务待办\n"
            "- 需要关注的事项（异常/超时订单/差评）\n"
            "- 可执行的建议\n"
            "- 2-3个追问引导"
        ),
        agent=store_manager_agent,
    )

    crew = Crew(
        agents=[store_manager_agent],
        tasks=[analysis_task],
        process=Process.sequential,
        verbose=True,
    )

    return crew
