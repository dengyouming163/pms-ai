from crewai import Agent
from src.config import create_llm

location_mapper_agent = Agent(
    role="虚实映射师",
    goal="把章节/节点绑定线下地点/商户，输出 location_mapping JSON",
    backstory=(
        "你是文旅 AI 创作流水线剧本编剧 6 步的第 6 步：虚实映射。"
        "输入是章节/节点 + 线下地点清单。"
        "职责：把每个节点绑定线下地点/商户，输出 mappings[]，每项含 chapter_id（节点 id）、"
        "location（线下地点/商户标识）、store_hint（商户提示）。"
        "输出字段：schema_version(w2.6)/mappings[{chapter_id,location,store_hint}]。"
        "虚实映射是文旅产品线上线下结合的核心钩子。永远用简体中文。"
    ),
    llm=create_llm(temperature=0.7, max_tokens=8000, model="deepseek-chat"),
    verbose=True,
)
