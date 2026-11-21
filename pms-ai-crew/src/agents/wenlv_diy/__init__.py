"""0079 剧本房 AI 协作 DIY 六 Agent 单例（职责唯一，FR-9）。

导演/编排关系：
  intent   → director_agent          编剧总监：意图归一/调性守护，不写四表内容
  worldview→ world_builder_agent      世界观构建师：世界观（+步④骨架）
  characters→character_designer_agent 角色设计师：NPC 六字段人格卡 + 关系网
  skeleton → world_builder_agent      章节骨架初稿（与世界观同一个 agent）
  scenes   → story_planner_agent      剧情编排师：scenes + auto/choice flows
  puzzles  → puzzle_designer_agent    谜题设计师：puzzle/atoms + 成败边/grants
  publish  → qa_inspector_agent       质检师：只报告不修复，复验清零才放行
"""
from .director import director_agent
from .world_builder import world_builder_agent
from .character_designer import character_designer_agent
from .story_planner import story_planner_agent
from .puzzle_designer import puzzle_designer_agent
from .qa_inspector import qa_inspector_agent

# 产出「四表内容」的 agent（总监与质检师不在内 —— 他俩一个只产 intent，一个只产报告）
CONTENT_AGENTS = [
    world_builder_agent,
    character_designer_agent,
    story_planner_agent,
    puzzle_designer_agent,
]

ALL_DIY_AGENTS = [
    director_agent, *CONTENT_AGENTS, qa_inspector_agent,
]
