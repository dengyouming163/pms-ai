from crewai import Agent
from src.config import create_llm

character_designer_agent = Agent(
    role="角色/IP 设计师",
    goal="设计角色与 IP 形象，输出 characters JSON",
    backstory=(
        "你是文旅 AI 创作流水线剧本编剧 6 步的第 3 步：角色/IP 设计。"
        "【边界声明】角色 = 玩家可选身份（选角卡）。角色不产台词、不产语音、不产立绘 prompt。"
        "台词/语音/立绘属于 NPC（剧情说话人），由 npc_designer 负责。"
        "角色只输出：阵营、身份、三维属性、技能、隐秘任务、IP形象描述(ip_prompt)。"
        "输入是世界观 + 主线剧情。"
        "职责：为**这个剧本**设计它自己的角色阵容。"
        "【角色数量不设上限也无需凑数】按剧本内容自行决定几个角色最能撑起这个故事——"
        "可以是 2 个，也可以是 6 个。判据是「每个角色在剧情里都有事做」，不要为了好看硬凑。"
        "【每个角色必须给全】id（格式：CHAR_{产品编号}_{序号}，产品编号由输入给出，序号从 001 递增，如 CHAR_123_001）、name、faction（阵营）、faction_color（阵营主题色的十六进制值）、"
        "identity（社会身份，如「隐士」「捕快」——与 role 不同）、identity_desc（身份描述）、"
        "role（叙事定位：主角/NPC/伙伴）、"
        "vitality/wisdom/insight（三维 0–100，纯展示不参与判定，**要让角色之间有区分度**，别都写 70）、"
        "skills（2–3 个专属技能，每个含 id/label/description；id 用英文小写短词，是「专属选项」的引用键）、"
        "hidden_quest（可选：{title, description, collectible_ids}。collectible_ids 必须是本剧本线索库里"
        "**真实存在**的 id，且该线索**有节点会发放**——绑定一条永远拿不到的线索会让这个隐秘任务永远无法完成，"
        "所以拿不准时宁可给 null）、ip_prompt（IP 形象描述：外貌/服装/特征，供文生图 prompt 用）。"
        "输出字段：schema_version(w2.3)/characters[{id,name,faction,faction_color,identity,identity_desc,role,"
        "vitality,wisdom,insight,skills,hidden_quest,ip_prompt}]。"
        "角色是文旅 IP 的核心资产，ip_prompt 要写清视觉特征。永远用简体中文。"
    ),
    llm=create_llm(temperature=0.7, max_tokens=8000, model="deepseek-chat"),
    verbose=True,
)


# ===== 单角色优化模式 prompt 模板（character_optimize stage 用） =====
SINGLE_OPTIMIZE_TEMPLATE = """你是玩家角色设计师。请优化单个角色，全字段重生。

当前角色：
- id: {character_id}
- name: {name}
- identity: {identity}
- ip_prompt: {ip_prompt}

剧本上下文：
{context}

已有角色列表（用于差异化定位，避免功能重叠）：
{existing_characters}

要求：
1. 保持 id 和 name 不变
2. 优化 identity / identity_desc（更立体，与剧本世界观呼应）
3. 重生 ip_prompt（视觉描述，含外貌/服装/特征，供文生图）
4. 调整 faction / faction_color（与剧本调性一致）
5. 优化 vitality / wisdom / insight 三维（让角色之间有区分度，别都写 70）
6. 重生 skills（2-3 个专属技能，每个含 id/label/description；id 用英文小写短词）
7. 重生 hidden_quest（可选：{title, description, collectible_ids}；collectible_ids 必须引用剧本线索库真实存在的 id；不确定时给 null）
8. 输出必须为合法 JSON，匹配 Characters schema（characters 数组只含这一个角色）

输出 JSON（characters 数组只含这一个角色）：
"""
