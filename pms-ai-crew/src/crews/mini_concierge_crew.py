from crewai import Crew, Process, Task


def create_mini_concierge_crew(user_message: str):
    from src.agents.mini_concierge import mini_concierge_agent
    task = Task(
        description=(
            f"客人说：{user_message}\n"
            "请根据客人需求提供帮助。如果是咨询排房/订房/选房，务必调用 smart_room_match 工具获取排房方案并友好呈现。"
            "如果是问民宿信息，调用 get_property_info。如果是闲聊，请自然亲切回应。"
            "回复使用中文，简洁友好，像在和邻居聊天。"
        ),
        expected_output="一段自然友好的中文回复。如有排房方案请清晰列出各选项。",
        agent=mini_concierge_agent,
    )
    return Crew(
        agents=[mini_concierge_agent],
        tasks=[task],
        process=Process.sequential,
        verbose=True,
    )
