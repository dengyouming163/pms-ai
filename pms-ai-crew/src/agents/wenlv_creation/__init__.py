from .project_positioning import project_positioning_agent
from .world_builder import world_builder_agent
from .storyline_writer import storyline_writer_agent
from .character_designer import character_designer_agent
from .chapter_planner import chapter_planner_agent
from .ending_designer import ending_designer_agent
from .location_mapper import location_mapper_agent
from .level_designer import level_designer_agent
from .visual_designer import visual_designer_agent
from .material_assist import material_assist_agent
from .npc_designer import npc_designer_agent
from .collectible_image import collectible_image_agent
from .reward_designer import reward_designer_agent
from .skeleton_designer import skeleton_designer_agent

# 剧本编剧 6 步子流水线（按顺序）
SCRIPT_AGENTS = [
    world_builder_agent, storyline_writer_agent, character_designer_agent,
    chapter_planner_agent, ending_designer_agent, location_mapper_agent,
]

# 一键草稿 5 阶段（⑤ 完整性校验为确定性函数，非 agent）
PIPELINE_AGENTS = [
    project_positioning_agent, level_designer_agent, visual_designer_agent,
]

ALL_AGENTS = [
    project_positioning_agent, *SCRIPT_AGENTS, level_designer_agent,
    visual_designer_agent, material_assist_agent, npc_designer_agent,
    collectible_image_agent, reward_designer_agent,
    skeleton_designer_agent,
]
