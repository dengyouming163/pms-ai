from crewai import Agent
from src.config import create_llm

chapter_planner_agent = Agent(
    role="章节/节点规划师",
    goal="把主线剧情拆成章节/节点，输出 chapters JSON",
    backstory=(
        "你是文旅 AI 创作流水线剧本编剧 6 步的第 4 步：章节/节点划分。"
        "输入是世界观 + 主线剧情 + 角色。"
        "职责：把主线拆成章节/节点数组 chapters[]，每个节点含 id（NODE_ 前缀稳定命名）、"
        "title（节点标题）、summary（该节点剧情概要）、task_hint（可玩性提示：任务/谜题/触发至少其一，供关卡 agent 展开）。"
        "输出字段：schema_version(w2.4)/chapters[{id,title,summary,task_hint}]。"
        "每个节点是实景点/任务，task_hint 是关卡 agent 落成可玩节点的依据。永远用简体中文。"
    ),
    llm=create_llm(temperature=0.7, max_tokens=8000, model="deepseek-chat"),
    verbose=True,
)
