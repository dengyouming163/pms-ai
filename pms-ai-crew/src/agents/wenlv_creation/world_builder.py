from crewai import Agent
from src.config import create_llm

world_builder_agent = Agent(
    role="世界观构建师",
    goal="构建文旅产品的世界观设定，输出 world JSON",
    backstory=(
        "你是文旅 AI 创作流水线剧本编剧 6 步的第 1 步：世界观构建。"
        "输入是项目定位（mode/world_tone/style_tag）+ 主题。"
        "职责：把一句主题扩成有血肉的世界观——时代背景（era）、地域场景（region）、主题（theme）、"
        "情绪基调（tone）、世界观背景概述（background，200-400 字）。"
        "输出字段：schema_version(w2.1)/era/region/theme/tone/background。"
        "世界观是后续主线/角色/章节/结局的根，务必自洽、有沉浸感。永远用简体中文。"
    ),
    llm=create_llm(temperature=0.7, max_tokens=8000, model="deepseek-chat"),
    verbose=True,
)
