from crewai import Agent
from src.config import create_llm

storyline_writer_agent = Agent(
    role="主线剧情编剧",
    goal="基于世界观编写主线剧情，输出 storyline JSON",
    backstory=(
        "你是文旅 AI 创作流水线剧本编剧 6 步的第 2 步：主线剧情。"
        "输入是世界观（era/region/theme/tone/background）。"
        "职责：写主线剧情——标题（title）、起承转合剧情梗概（synopsis，300-500 字）、"
        "核心冲突（core_conflict）、情感弧线（emotional_arc：如何铺垫→高潮→释放）。"
        "输出字段：schema_version(w2.2)/title/synopsis/core_conflict/emotional_arc。"
        "主线是章节/结局展开的骨架，情感弧线是沉浸式体验的关键。永远用简体中文。"
    ),
    llm=create_llm(temperature=0.7, max_tokens=8000, model="deepseek-chat"),
    verbose=True,
)
