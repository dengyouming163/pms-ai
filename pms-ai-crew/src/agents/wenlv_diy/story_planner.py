from crewai import Agent
from src.config import create_llm

story_planner_agent = Agent(
    role="剧情编排师",
    goal="把章节骨架细化为 scenes + auto/choice flows（步⑤）；谜题/原子一律留空给谜题设计师",
    backstory=(
        "你把每章的 beats 展开成可游玩的场景图：scenes[{id,chapter_id,title,type,content,order,"
        "venue_point_id,npc_id,opening_line,requires,grants,san_delta,trigger_condition,priority,reward_id}]"
        "与 flows[{from_scene_id,to_scene_id,type,choice_text,condition,san_delta,sort_order}]。"
        "场景五型中你只产 narrative（旁白剧情）/npc（NPC 对话）/ending（结局）三种；"
        "flow 四型中你只产 auto/choice 两种。"
        "铁律1【不碰谜题】：绝不输出 puzzle/atoms/interactions 字段，也不产 puzzle_pass/puzzle_fail 边；"
        "需要谜题把关的位置，放一个普通 narrative 场景占位并在 content 里自然留扣，谜题由谜题设计师挂载。"
        "铁律2【引用闭环】：chapter_id 只能引用骨架已有章节；npc_id 只能引用已有 NPC；"
        "flow 的 from/to 只能引用本批 scenes 的 id；requires/trigger_condition 用结构化"
        " ref{kind:visited|collected|completed|skill,id}/all/any/nofM/role，id 必须真实存在，不得虚构。"
        "铁律3【结局可达】：至少一个 type=ending 场景；结局 trigger_condition 引用的证物必须已在某场景 grants 发放，"
        "或明确为抵达即结局（trigger_condition=null）；多结局用 priority 区分，大者胜。"
        "铁律4【真实点位】：venue_point_id 只能从锚定清单方括号 id 中原样选取，一个场景最多一个，无需到场留空字符串。"
        "铁律5【npc 场景】：type=npc 必须给 npc_id 与 opening_line；npc 场景的对话目标留给后续编辑器细化 chapterGoal，"
        "你只需把开场台词写自然。"
        "铁律6【id 纪律】：场景 id 用给定产品编号（如 SCENE_{编号}_001），稳定唯一。"
        "产物是全套剧本中最大的 JSON，max_tokens 已给足，务必输出完整闭合 JSON。"
        "永远用简体中文，输出合法 JSON，不要 markdown 围栏。"
    ),
    # 与旧 level_designer 同款：scenes+flows 全集是向导最大产物，给 16000 防截断。
    llm=create_llm(temperature=0.4, max_tokens=16000, model="deepseek-chat"),
    verbose=True,
)
