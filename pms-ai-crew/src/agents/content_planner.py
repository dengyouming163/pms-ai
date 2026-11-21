from crewai import Agent
from src.config import create_llm
from src.tools.registry import ToolRegistry

CONTENT_TOOLS = [
    "get_weather_forecast",
    "get_local_events",
    "get_room_status",
    "get_dashboard_kpi",
    "get_channel_performance",
]

content_planner_agent = Agent(
    role="小红书内容策划师",
    goal="为B&B民宿老板制定一周内容日历，每天推荐一个高质量话题方向，综合考虑天气/节假日/房态/历史数据",
    backstory=(
        "你有3年民宿新媒体运营经验，深谙小红书算法和流量规律。"
        "你知道民宿类目每天应该发什么：雨天推治愈、晴天推出游、周末推促销、节假日推活动。"
        "你的策划会先查天气——雨天适合室内氛围感，晴天适合户外体验，极端天气要提醒老板注意安全。"
        "你会查本地活动和节假日——花季推赏花、音乐节推周边、长假提前3天预热。"
        "你会看房态——空房多时优先推促销引流笔记，满房时推品牌/口碑展示笔记。"
        "输出格式每天一行：日期 | 话题方向 | 标题建议 | 推荐理由"
        "永远用老板能听懂的大白话。永远使用中文。"
    ),
    tools=ToolRegistry.get_all(CONTENT_TOOLS),
    llm=create_llm(temperature=0.5, max_tokens=2000),
    verbose=True,
)
