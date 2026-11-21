from crewai import Agent
from src.config import create_llm

ending_designer_agent = Agent(
    role="多结局设计师",
    goal="设计多结局，输出 endings JSON",
    backstory=(
        "你是文旅 AI 创作流水线剧本编剧 6 步的第 5 步：多结局设计。"
        "输入是主线剧情 + 章节 + 角色。"
        "职责：设计结局数组 endings[]，每个结局含 id（END_ 前缀稳定命名）、title（结局标题）、"
        "condition_hint（达成条件语义描述，供关卡 agent 转 WenlvCondition）、emotional_climax（情感高潮设计）。"
        "结局必须设计成**由宽到严的阶梯**：条件越苛刻的结局越接近真相，priority 越大。"
        "每个结局必须给一个**互不相同**的 priority（整数，越专属越大）；两个结局不得引用完全相同的线索集合。"
        "输出字段：schema_version(w2.5)/endings[{id,title,condition_hint,emotional_climax,priority}]。"
        "结局带情感高潮设计，是沉浸式体验与复游传播的引擎。永远用简体中文。"
    ),
    llm=create_llm(temperature=0.7, max_tokens=8000, model="deepseek-chat"),
    verbose=True,
)


# ===== 单结局优化模式 prompt 模板（ending_optimize stage 用，对应板块5「AI一键优化结局库」） =====
ENDING_OPTIMIZE_TEMPLATE = """你是多结局设计师。请优化单个结局，全字段重生并补充触发条件与结局图 prompt。

当前结局：
- id: {ending_id}
- title: {title}
- condition_hint: {condition_hint}
- emotional_climax: {emotional_climax}
- priority: {priority}

剧本上下文：
{context}

已有节点/线索库（用于触发条件设计）：
{existing_nodes_and_collectibles}

要求：
1. 保持 id 和 priority 不变（priority 是解析优先级，互不相同）
2. 优化 title（更具情感张力）
3. 重生 condition_hint（达成条件语义描述，引用真实存在的 collectible_id 和 node_id）
4. 优化 emotional_climax（情感高潮设计，呼应主线）
5. 新增 ending_image_prompt（结局图文生图 prompt，含画风/构图/色调/主体，长度 50-150 字）
6. 输出必须为合法 JSON，匹配 Endings schema（endings 数组只含这一个结局，外加 ending_image_prompt 字段）

输出 JSON：
"""
