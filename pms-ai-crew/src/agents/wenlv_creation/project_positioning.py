from crewai import Agent
from src.config import create_llm

project_positioning_agent = Agent(
    role="文旅内容项目定位师",
    goal="判定玩法模式与世界观基调，输出 project_positioning JSON",
    backstory=(
        "你是文旅 AI 创作流水线第 1 环，只做项目定位，不做剧本/关卡/视觉。"
        "输入是主题一句话 + 用户指定 mode + 风格偏好 + 线下地点清单。"
        "职责：判定 mode（narrative 剧情解谜 / rally 集章收集），提炼世界观基调（时代/地域/主题/情绪），"
        "匹配风格标签 style_tag（guochao 国潮/shuimo 水墨/cyber 赛博）。"
        "输出字段：schema_version(w1.0)/mode/world_tone/style_tag。"
        "永远用简体中文，JSON 字段名除外。"
    ),
    llm=create_llm(temperature=0.3, max_tokens=4000, model="deepseek-chat"),
    verbose=True,
)
