from crewai import Crew, Process, Task
from src.agents.content_planner import content_planner_agent
from datetime import datetime, timedelta

def create_content_planning_crew(merchant_id: str, store_id: str, week_start: str):
    """创建内容策划 Crew — 输入一周起始日期，输出7天小红书内容日历"""
    start_date = datetime.strptime(week_start, "%Y-%m-%d")
    dates = [(start_date + timedelta(days=i)).strftime("%Y-%m-%d") for i in range(7)]
    week_label = f"{dates[0]} ~ {dates[6]}"

    task = Task(
        description=(
            f"请为民宿制定从 {week_start}（周一）开始的一周小红书内容日历，共 7 天。\n\n"
            f"步骤：\n"
            f"1. 先用 get_weather_forecast 查询未来7天天气（城市：杭州）\n"
            f"2. 用 get_local_events 查询本周节假日和本地活动\n"
            f"3. 用 get_room_status 查当前房态和入住率\n"
            f"4. 用 get_dashboard_kpi 看营收概况\n"
            f"5. 综合以上数据，为每天推荐一个话题方向\n\n"
            f"输出格式（每行一条，共7行）：\n"
            f"日期 | 话题方向 | 标题建议 | 推荐理由\n"
            f"例如：\n"
            f"{dates[0]} | 治愈系文案 | 藏在山里的这家民宿，下雨天也好美 | 明天有雨，适合推室内氛围感\n"
            f"{dates[5]} | 周末特价 | 周末不涨价！人均200住进风景里 | 周六入住率偏低，促销引流\n"
        ),
        expected_output=f"7天小红书内容日历（{week_label}），每天一行：日期|话题|标题|理由",
        agent=content_planner_agent,
    )

    crew = Crew(
        agents=[content_planner_agent],
        tasks=[task],
        process=Process.sequential,
    )
    return crew
