"""文旅剧本房 AI 协作 DIY（0079 统一模型）7 步向导输出契约。

六 Agent / 七步对应（spec FR-9/FR-10）：
  intent     编剧总监      DiyIntent       意图归一（存 ai_sessions.intent，**不写四表**）
  worldview  世界观构建师  DiyWorldview    → script_rooms.config.worldview
  characters 角色设计师    DiyCharacters   → npcs（6 字段人格卡 + 关系网）
  skeleton   世界观构建师  DiySkeleton     章节骨架初稿（节拍 beats，无场景）
  scenes     剧情编排师    DiyScenes       骨架细化为 scenes + flows（puzzle/atoms 一律留空）
  puzzles    谜题设计师    DiyPuzzles      只填 puzzle/atoms 与 puzzle_pass/fail 边、grants
  publish    质检师        QaReport        只报告待办（AI 可修/人工），**不产出内容**

职责唯一靠 schema 形状隔离：
  · DiySceneDraft 没有 puzzle/atoms 字段 —— 剧情编排师即使输出也会被 LenientModel 丢弃；
  · DiyStoryFlow.type 只许 auto/choice —— 谜题成败边只在 DiyPuzzles.flows 出现；
  · DiyPuzzleFill 只按 scene_id 回填既有场景，不携带 title/content —— 谜题设计师改不了剧情。
所有模型继承 LenientModel（dict→list / str→dict / 忽略未声明字段）。
"""
from typing import Any, Literal, Optional, Union

from pydantic import Field, model_validator

from src.schemas.common import LenientModel

SCHEMA_VERSION = "diy1.0"

# 七步状态机（与 pms-server wenlv_ai_stage 枚举逐字一致）
DiyStage = Literal["intent", "worldview", "characters", "skeleton", "scenes", "puzzles", "publish"]

# 统一模型枚举（与 pms-server schema/wenlv.ts 对齐）
DiySceneType = Literal["narrative", "puzzle", "atom", "npc", "ending"]
DiyStoryEdgeType = Literal["auto", "choice"]            # 剧情编排师只产出这两种
DiyPuzzleEdgeType = Literal["puzzle_pass", "puzzle_fail"]
DiyPuzzleInteractionType = Literal["single", "multiple", "input", "judge", "photo", "meditate"]


# ===== 结构化条件（镜像 pms-server WenlvCondition：ref/role/all/any/nofM）=====

class DiyCondRef(LenientModel):
    kind: Literal["visited", "collected", "completed", "skill"] = Field(description="引用语义")
    id: str = Field(description="被引用的场景/证物/技能 id（必须已存在，不得虚构）")


class DiyCondition(LenientModel):
    """声明式解锁条件。LLM 只需产 all(and)/ref 两种即可覆盖大多数剧本；
    role 用于视角角色门，any/nofM 供复杂分支。嵌套 conditions/of 递归校验。"""

    type: Literal["ref", "role", "all", "any", "nofM"] = Field(description="条件类型")
    ref: Optional[DiyCondRef] = Field(default=None, description="type=ref 时的引用")
    character_id: Optional[str] = Field(default=None, description="type=role 时的视角角色/NPC id")
    conditions: list["DiyCondition"] = Field(default_factory=list, description="type=all/any 的子条件")
    n: Optional[int] = Field(default=None, ge=0, description="type=nofM 时需满足的个数")
    of: list["DiyCondition"] = Field(default_factory=list, description="type=nofM 的候选条件")


DiyCondition.model_rebuild()


# ===== 步① intent：编剧总监（意图归一 + 反问；不写四表）=====

class DiyIntent(LenientModel):
    schema_version: str = Field(default=SCHEMA_VERSION)
    summary: str = Field(description="老板原话归一后的一句话创作意图")
    theme: str = Field(description="题材主题（如：民国悬疑/国风志怪/非遗寻踪）")
    tone: Optional[str] = Field(default=None, description="情绪基调（如：紧张推理/轻松治愈）")
    duration_min: Optional[int] = Field(default=None, ge=10, le=600, description="期望时长（分钟）")
    player_count: Optional[int] = Field(default=None, ge=1, le=20, description="建议人数")
    experience_goals: list[str] = Field(
        default_factory=list, description="体验目标（沉浸演绎/推理解谜/实景打卡/集章探索 等）")
    must_haves: list[str] = Field(
        default_factory=list, description="老板点名必须包含的要素（某种道具/某个商户/某种结局）")
    anchor_usage: list[str] = Field(
        default_factory=list, description="拟使用的场地能力/商户/点位（来自步①锚定上下文，不得虚构）")
    questions_for_user: list[str] = Field(
        default_factory=list, description="关键信息缺失时给老板的反问（最多 3 条；信息齐全留空）")


# ===== 步② worldview：世界观构建师 → config.worldview =====

class DiyWorldview(LenientModel):
    schema_version: str = Field(default=SCHEMA_VERSION)
    era: str = Field(description="时代背景")
    region: str = Field(description="地域/场景（与真实场地吻合，不得虚构地点）")
    theme: str = Field(description="主题")
    tone: str = Field(description="情绪基调（全剧调性锚点，后续各 agent 不得偏离）")
    background: str = Field(description="世界观背景概述（200-400 字，含玩家身份与核心任务由头）")
    key_rules: list[str] = Field(
        default_factory=list, description="世界规则（如 SAN 值/证物机制/时辰限制；没有可空数组）")


# ===== 步③ characters：角色设计师 → npcs =====

class DiySecretLayer(LenientModel):
    knows: list[str] = Field(default_factory=list, description="NPC 可谈事实白名单")
    never: list[str] = Field(default_factory=list, description="绝不可主动说的禁区")
    loosens_when: Optional[str] = Field(default=None, description="在什么条件下口风松动")


class DiyPersonaCard(LenientModel):
    """NPC 6 字段人格卡（与 pms-server WenlvNpcPersona 六键逐一对齐；secretLayer 可选第 7 层）。"""

    personality: list[str] = Field(description="性格标签 2-4 个，如 ['寡言','多疑']")
    tone: str = Field(description="语气风格一句话，如 '短句、低沉、不正面回答'")
    catchphrases: list[str] = Field(default_factory=list, description="口头禅 0-3 句")
    backstory: str = Field(description="背景故事：NPC 的秘密与动机（100-300 字）")
    clues: list[str] = Field(default_factory=list, description="知道但不主动说的线索")
    taboos: list[str] = Field(default_factory=list, description="拒绝谈论的禁忌话题")
    secret_layer: Optional[DiySecretLayer] = Field(default=None, description="可选秘密层（演员升级）")


class DiyNpcRelationship(LenientModel):
    target_npc_id: str = Field(description="目标 NPC id（必须引用本批已存在的 NPC）")
    relation_type: str = Field(description="关系类型：朋友/宿敌/师徒/亲属/同事/债主 等")
    description: str = Field(description="关系描述一句话（含张力与秘密，供互相提及）")


class DiyNpcCard(LenientModel):
    id: str = Field(description="NPC id（产品内稳定唯一，供 scenes.npc_id 引用，不得虚构其它 id）")
    name: str = Field(description="NPC 名称（2-4 字）")
    role: str = Field(default="npc", description="叙事定位：npc/关键人物/反派/路人")
    description: str = Field(description="NPC 简介一句话（身份 + 剧情作用）")
    persona: DiyPersonaCard = Field(description="6 字段人格卡")
    relationships: list[DiyNpcRelationship] = Field(default_factory=list, description="关系网")


class DiyCharacters(LenientModel):
    schema_version: str = Field(default=SCHEMA_VERSION)
    npcs: list[DiyNpcCard] = Field(description="本剧本房的 NPC 列表")


# ===== 步④ skeleton：世界观构建师 → chapters 骨架（只有章与节拍）=====

class DiySkeletonChapter(LenientModel):
    id: str = Field(description="章节 id（稳定命名，供步⑤ scenes.chapter_id 引用）")
    title: str = Field(description="章节标题")
    time_label: Optional[str] = Field(default=None, description="时辰/时间标签（如 '入夜·二更'）")
    goal: str = Field(description="本章玩家目标一句话")
    order: int = Field(ge=0, description="章节顺序（从 0 递增）")
    beats: list[str] = Field(
        description="剧情节拍 3-6 条（每条一句话；步⑤剧情编排师据此展开场景，本步不产场景）")


class DiySkeleton(LenientModel):
    schema_version: str = Field(default=SCHEMA_VERSION)
    chapters: list[DiySkeletonChapter] = Field(description="章节骨架（顺序即叙事顺序，至少含一个结局导向的末章）")


# ===== 步⑤ scenes：剧情编排师 → scenes + flows（puzzle/atoms 刻意缺席）=====

class DiySceneDraft(LenientModel):
    id: str = Field(description="场景 id（nodeId 即 scene.id；稳定命名，flows 只许引用这些 id）")
    chapter_id: str = Field(description="所属章节 id（必须引用步④已存在的章节，不得开新章）")
    title: str = Field(description="场景标题")
    type: Literal["narrative", "npc", "ending"] = Field(
        description="场景类型：narrative 旁白/npc 对话/ending 结局（puzzle/atom 由谜题师在步⑥添加）")
    content: str = Field(default="", description="叙事正文（ending 时投影为结局文案 text）")
    order: int = Field(default=0, ge=0, description="章内顺序")
    venue_point_id: Optional[str] = Field(
        default=None, description="绑定的真实点位 id（只许取锚定清单里的 id；无需到场留空）")
    npc_id: Optional[str] = Field(default=None, description="type=npc 时的说话人（引用步③ NPC id）")
    opening_line: Optional[str] = Field(default=None, description="type=npc 时的开场台词")
    requires: Optional[DiyCondition] = Field(default=None, description="进入条件（结构化；无条件留 null）")
    grants: list[str] = Field(
        default_factory=list, description="本场景到访即发放的证物/印记 id（线索发放的途径之一）")
    san_delta: Optional[int] = Field(default=None, description="SAN 值增减（整数，可正可负）")
    # 结局专属（type=ending 时给）
    trigger_condition: Optional[DiyCondition] = Field(
        default=None, description="结局达成条件（结构化；null=抵达即结局）")
    priority: Optional[int] = Field(default=0, ge=0, description="多结局裁决优先级（大者胜）")
    reward_id: Optional[str] = Field(default=None, description="结局绑定奖励 id（可空）")
    # ⚠️ 无 puzzle / atoms / interactions 字段：职责隔离，谜题师在步⑥按 scene_id 回填。


class DiyStoryFlow(LenientModel):
    id: Optional[str] = Field(default=None, description="流转 id（可空，落盘端生成）")
    from_scene_id: str = Field(description="起点场景 id")
    to_scene_id: str = Field(description="终点场景 id")
    type: DiyStoryEdgeType = Field(description="auto 自动/choice 玩家选择（谜题成败边归步⑥）")
    choice_text: Optional[str] = Field(default=None, description="type=choice 时的选项文案")
    condition: Optional[DiyCondition] = Field(default=None, description="该边可见/可选条件")
    san_delta: Optional[int] = Field(default=None)
    sort_order: Optional[int] = Field(default=0, ge=0)


class DiyScenes(LenientModel):
    schema_version: str = Field(default=SCHEMA_VERSION)
    scenes: list[DiySceneDraft] = Field(description="本批展开的场景（至少一个 type=ending 才能收尾）")
    flows: list[DiyStoryFlow] = Field(
        default_factory=list, description="场景间流转（只许 auto/choice；从/到只许引用 scenes 内 id）")


# ===== 步⑥ puzzles：谜题设计师 → 回填 puzzle/atoms + 成败边 + grants =====

class DiyPuzzleSpec(LenientModel):
    """单题谜题（= pms-server scenes.puzzle，WenlvInteraction 六型）。"""

    type: DiyPuzzleInteractionType = Field(description="题型")
    question: str = Field(description="题干")
    options: list[str] = Field(default_factory=list, description="single/multiple 的选项（其余题型留空）")
    answer: Optional[Union[str, list[str]]] = Field(
        default=None, description="答案：single/input 为字符串，multiple 为字符串数组，"
                                  "judge 只能是 \"true\"/\"false\"，photo/meditate 留空")
    hint: Optional[str] = Field(default=None, description="提示文案")
    seconds: Optional[int] = Field(default=None, ge=1, le=1800, description="meditate 静坐秒数（1-1800）")

    @model_validator(mode="after")
    def _check_answer_shape(self):
        """题型规则（与发布闸一致，违规直接校验失败触发带错误清单重跑）：
        single/input 答案为非空字符串；multiple 为非空字符串数组且选项非空；
        judge 答案只能是字符串 "true"/"false"（严禁「对/正确」中文）；
        meditate 必须给 1-1800 秒；photo 只需 question。"""
        t = self.type
        if t in ("single", "input"):
            if not isinstance(self.answer, str) or not self.answer.strip():
                raise ValueError(f"{t} 题型的 answer 必须是非空字符串")
        elif t == "multiple":
            if not isinstance(self.answer, list) or not self.answer or \
                    not all(isinstance(a, str) and a.strip() for a in self.answer):
                raise ValueError("multiple 题型的 answer 必须是非空字符串数组")
            if not self.options:
                raise ValueError("multiple 题型的 options 不能为空")
        elif t == "judge":
            if self.answer not in ("true", "false"):
                raise ValueError('judge 题型的 answer 只能是 "true" 或 "false"')
        elif t == "meditate":
            if self.seconds is None:
                raise ValueError("meditate 题型必须给整数 seconds（1-1800）")
        return self


class DiyAtomSpec(LenientModel):
    """有序交互原子（= pms-server WenlvAtom；谜题师独占）。"""

    id: str = Field(description="原子 id（场景内稳定）")
    type: str = Field(description="原子类型（如 qrcode_scan/observe/input/collect）")
    title: Optional[str] = Field(default=None, description="原子标题")
    config: dict[str, Any] = Field(default_factory=dict, description="原子配置（类型相关）")
    required: bool = Field(default=True, description="是否完成该场景的必需原子")


class DiyPuzzleFill(LenientModel):
    """对步⑤既有场景的谜题回填 —— 只按 scene_id 挂载，不携带任何剧情字段。"""

    scene_id: str = Field(description="要挂谜题的场景 id（必须引用步⑤已存在的 puzzle 位/普通场景）")
    puzzle: DiyPuzzleSpec = Field(description="单题谜题")
    atoms: list[DiyAtomSpec] = Field(default_factory=list, description="有序交互原子（可空数组）")
    grants: list[str] = Field(
        default_factory=list, description="解开后发放的证物/印记 id（结局条件引用的 id 必须在某处被发放）")
    pass_to_scene_id: Optional[str] = Field(
        default=None, description="答对去向场景 id（由编排层生成 puzzle_pass 边；可空表示停留）")
    fail_to_scene_id: Optional[str] = Field(
        default=None, description="答错去向场景 id（puzzle_fail 边；可空表示原地重试）")
    san_delta_pass: Optional[int] = Field(default=None, description="答对 SAN 增减")
    san_delta_fail: Optional[int] = Field(default=None, description="答错 SAN 增减（通常为负）")


class DiyPuzzleFlow(LenientModel):
    """谜题成败边（与 DiyStoryFlow 的 auto/choice 刻意分开）。"""

    id: Optional[str] = None
    from_scene_id: str
    to_scene_id: str
    type: DiyPuzzleEdgeType
    condition: Optional[DiyCondition] = None
    grants: list[str] = Field(default_factory=list, description="走该边时发放的证物/印记")
    san_delta: Optional[int] = None
    sort_order: Optional[int] = Field(default=0, ge=0)


class DiyPuzzles(LenientModel):
    schema_version: str = Field(default=SCHEMA_VERSION)
    fills: list[DiyPuzzleFill] = Field(description="逐场景谜题回填（只碰 puzzle/atoms/grants/成败边）")
    flows: list[DiyPuzzleFlow] = Field(
        default_factory=list, description="新增的 puzzle_pass/puzzle_fail 流转")


# ===== 步⑦ publish：质检师报告（不写内容；确定性发布闸在 Task 14 对接）=====

class QaFinding(LenientModel):
    rule_id: str = Field(description="命中的发布闸规则编号（R1-R10）")
    severity: Literal["blocker", "warning"] = Field(description="blocker 不清零不许 live")
    scene_id: Optional[str] = Field(default=None, description="关联场景/流转 id（全局问题可空）")
    message: str = Field(description="问题描述（给老板看的人话）")
    ai_fixable: bool = Field(description="是否属于 AI 可一键修复项（false=必须人工处理）")
    fix_hint: Optional[str] = Field(default=None, description="AI 可修时的修复提示（给对应 agent 的指令素材）")


class QaReport(LenientModel):
    schema_version: str = Field(default=SCHEMA_VERSION)
    findings: list[QaFinding] = Field(default_factory=list, description="问题清单（空=通过）")
    ai_fixable_count: int = Field(default=0, ge=0)
    manual_count: int = Field(default=0, ge=0)
    ready_to_publish: bool = Field(description="无 blocker 才为 true；true 才允许 status=live")
