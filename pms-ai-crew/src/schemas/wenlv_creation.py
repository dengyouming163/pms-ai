"""文旅 AI 创作平台 wenlv_creation 模块输出契约（spec §5 AI agent 流水线）。

定义一键草稿 5 阶段（项目定位 → 剧本 6 步 → 关卡设计 → 视觉设计 → 完整性校验）
的产出 Pydantic 模型，用于对 LLM 输出做结构化校验。所有模型继承 LenientModel
（LLM 输出容错：dict→list / str→dict / 忽略额外字段）。
"""

from typing import Literal, Optional

from pydantic import BaseModel, Field

from src.schemas.common import LenientModel


# ===== ① 项目定位 =====

class ProjectPositioning(LenientModel):
    """项目定位：模式 / 世界观基调 / 风格标签（一键草稿第 1 阶段）。"""

    schema_version: str = Field(default="w1.0", description="schema 版本号")
    mode: Literal["narrative", "rally"] = Field(description="玩法模式：narrative 剧情 / rally 集章")
    world_tone: str = Field(description="世界观基调一句话：时代/地域/主题/情绪")
    style_tag: str = Field(description="风格标签（对应 design_templates.styleTag，如 guochao/shuimo/cyber）")


# ===== ② 剧本编剧 6 步子流水线 =====

class WorldSetting(LenientModel):
    """世界观构建（剧本第 1 步）。"""

    schema_version: str = Field(default="w2.1", description="schema 版本号")
    era: str = Field(description="时代背景")
    region: str = Field(description="地域/场景")
    theme: str = Field(description="主题")
    tone: str = Field(description="情绪基调")
    background: str = Field(description="世界观背景概述（200-400 字）")


class Storyline(LenientModel):
    """主线剧情（剧本第 2 步）。"""

    schema_version: str = Field(default="w2.2", description="schema 版本号")
    title: str = Field(description="主线标题")
    synopsis: str = Field(description="起承转合剧情梗概（300-500 字）")
    core_conflict: str = Field(description="核心冲突")
    emotional_arc: str = Field(description="情感弧线（如何铺垫→高潮→释放）")


class CharacterSkill(LenientModel):
    """角色技能（`skills` 的一项）。

    `id` 取代 pms-nimi 原硬编码数据的 `key`：既是端面 v-for 的 key，也是「专属选项」门控的引用键
    ⇒ 必须在产品内稳定且唯一。**空 id 会被写入口丢弃**（服务端与创作台两侧同款归一）。
    """

    id: str = Field(description="技能 id（英文小写短词，如 track/sutra，产品内唯一，供选项门控引用）")
    label: str = Field(description="技能名（2–4 字，如「追踪」「诵经」）")
    description: str = Field(description="技能说明（一句话，端面 chip 上显示）")


class HiddenQuest(LenientModel):
    """隐秘任务（角色专属隐藏目标）。

    ⚠️ **不含 progress**：进度由端面从游客的收集状态实时算（`collectible_ids` 中已收集的数量），
    不落库 —— 落库就会有两个真相。
    """

    title: str = Field(description="任务标题（4–8 字）")
    description: str = Field(description="任务描述（一句话）")
    collectible_ids: list[str] = Field(
        default_factory=list,
        description="绑定的线索 id（必须是本剧本 collectibles 里真实存在、且**有节点会发放**的 id；"
                    "留空表示暂不绑定，重跑时可补绑）",
    )


class Character(LenientModel):
    """角色/IP（剧本第 3 步的单元）。

    字段与端面显示结构**逐一对齐**（spec §4.1）——端面要的字段一个不能少：
    卡面的 name/faction/faction_color/identity/三维，身份卡的 identity_desc/skills/hidden_quest，
    头像的 avatar 由 ip_prompt 生成后回写。
    """

    id: str = Field(description="角色 id（CHAR_ 前缀，稳定命名供视觉 agent 文生图引用与选项门控引用）")
    name: str = Field(description="角色名（2–4 字）")
    faction: str = Field(description="所属阵营/门派（如「孤山书社」「六扇门」）")
    faction_color: str = Field(description="阵营主题色（十六进制，如 #3A7D5C；按阵营气质自由推荐）")
    identity: str = Field(description="社会身份（2–4 字，如「隐士」「捕快」——身份卡上显示，与 role 不同）")
    identity_desc: str = Field(description="身份描述（一句话，交代来历与处境）")
    role: str = Field(description="叙事定位：主角/NPC/伙伴")
    vitality: int = Field(description="体力 0–100（纯展示，不参与任何判定）")
    wisdom: int = Field(description="智识 0–100（纯展示）")
    insight: int = Field(description="洞察 0–100（纯展示）")
    skills: list[CharacterSkill] = Field(description="专属技能 2–3 个（id 供选项门控引用）")
    hidden_quest: Optional[HiddenQuest] = Field(
        default=None, description="隐秘任务（可选：没有合适的隐藏目标时给 null，不要编一个勉强的）",
    )
    ip_prompt: str = Field(description="IP 形象描述（外貌/服装/特征，供文生图 prompt）")


class Characters(LenientModel):
    """角色/IP 集合（剧本第 3 步）。"""

    schema_version: str = Field(default="w2.3", description="schema 版本号")
    characters: list[Character] = Field(description="角色列表")


class WenlvNpcLine(LenientModel):
    """NPC 台词（`lines` 的一项）。

    id 供节点 `npc_line_ids` 引用子集；voiceUrl/duration 由 S3 TTS 后填，LLM 不产。
    """

    id: str = Field(description="台词 id（NPC 内唯一，供节点 npc_line_ids 引用）")
    text: str = Field(description="台词文本（必填非空，端上气泡显示）")


class WenlvNpcPersona(LenientModel):
    """NPC 人格卡（AI 对话核心设定）。"""

    personality: list[str] = Field(default_factory=list, description="性格标签，如 ['寡言', '多疑']")
    tone: str = Field(default="", description="语气风格，如 '短句、低沉'")
    catchphrases: list[str] = Field(default_factory=list, description="口头禅")
    backstory: str = Field(default="", description="背景故事（NPC 的秘密和动机）")
    clues: list[str] = Field(default_factory=list, description="已知线索（NPC 知道但不主动说）")
    taboos: list[str] = Field(default_factory=list, description="禁忌话题（NPC 拒绝谈论）")


class WenlvNpcRelationship(LenientModel):
    """NPC 与剧本内其他 NPC 的关系。"""

    target_npc_id: str = Field(description="目标 NPC id（必须引用同批 NPC）")
    relation_type: str = Field(description="关系类型：朋友/宿敌/师徒/亲属/同事")
    description: str = Field(description="关系描述")


class WenlvNpc(LenientModel):
    """NPC 设定（剧本第 3.5 步的单元，与 Character 平级互补）。

    Character 是玩家可选角色（选角卡），Npc 是剧情说话人（出场对话）。
    立绘由 portrait_prompt 经 S2 文生图后回写 portrait_url，LLM 只产 prompt。
    台词 voiceUrl/duration 由 S3 TTS 后填，LLM 只产 text。
    """

    id: str = Field(description="NPC id（NPC_ 前缀，稳定命名供节点 npc_id 引用）")
    name: str = Field(description="NPC 名称（2–4 字）")
    role: Literal["protagonist", "npc", "antagonist", "bystander"] = Field(
        description="叙事定位：主角/NPC/反派/路人",
    )
    description: str = Field(description="NPC 简介（一句话，交代身份与剧情作用，PC 创作台展示）")
    portrait_prompt: str = Field(description="半身立绘文生图 prompt（单一形象，非多形态）")
    voice_id: str = Field(description="TTS 音色 ID（6 种预定义：male_young/male_middle/male_elder/female_young/female_middle/female_elder）")
    character_id: Optional[str] = Field(default=None, description="可选关联 character id（同一角色在不同剧本/场次作为多个 NPC 出现时引）")
    lines: list[WenlvNpcLine] = Field(description="台词列表（至少 1 条，挂在 NPC 身上供节点引用子集）")
    persona: WenlvNpcPersona = Field(default_factory=WenlvNpcPersona, description="人格卡（AI 对话核心设定）")
    relationships: list[WenlvNpcRelationship] = Field(default_factory=list, description="与剧本内其他 NPC 的关系")


class WenlvNpcs(LenientModel):
    """NPC 集合（剧本第 3.5 步，与 Characters 平级互补）。"""

    schema_version: str = Field(default="w2.3.6", description="schema 版本号")
    npcs: list[WenlvNpc] = Field(description="NPC 列表")


class Chapter(LenientModel):
    """章节/节点划分（剧本第 4 步的单元，供关卡设计 agent 落成可玩关卡）。"""

    id: str = Field(description="章节/节点 id（NODE_ 前缀，稳定命名供引用闭环）")
    title: str = Field(description="节点标题")
    summary: str = Field(description="该节点剧情概要")
    task_hint: str = Field(description="可玩性提示：任务/谜题/触发至少其一，供关卡 agent 展开")


class Chapters(LenientModel):
    """章节/节点划分集合（剧本第 4 步）。"""

    schema_version: str = Field(default="w2.4", description="schema 版本号")
    chapters: list[Chapter] = Field(description="章节/节点列表")


class Ending(LenientModel):
    """多结局（剧本第 5 步的单元）。"""

    id: str = Field(description="结局 id（END_ 前缀）")
    title: str = Field(description="结局标题")
    condition_hint: str = Field(description="达成条件语义描述（供关卡 agent 转 WenlvCondition）")
    emotional_climax: str = Field(description="情感高潮设计")
    priority: int = Field(default=0, description="解析优先级（大者胜；同产品内须互不相同）")


class Endings(LenientModel):
    """多结局集合（剧本第 5 步）。"""

    schema_version: str = Field(default="w2.5", description="schema 版本号")
    endings: list[Ending] = Field(description="结局列表")


class LocationMapping(LenientModel):
    """虚实映射（剧本第 6 步：每个节点绑定线下地点/商户）。"""

    schema_version: str = Field(default="w2.6", description="schema 版本号")
    mappings: list[dict] = Field(description="[{chapter_id, location, store_hint}] 节点→线下地点映射")


# ===== ③ 关卡设计 =====

class LevelNode(LenientModel):
    """关卡节点：剧本 chapter 落成可玩节点（narrative/rally 通用）。"""

    id: str = Field(description="节点 id（对齐 chapter.id）")
    node_type: Literal["scene", "puzzle"] = Field(description="节点类型")
    title: str = Field(description="节点标题")
    story_text: str = Field(description="剧情文本（旁白/对话）")
    trigger_type: Literal["manual", "qrcode", "beacon"] = Field(default="manual", description="触发方式")
    trigger_credential: str = Field(default="", description="触发凭证（二维码 token / 信标 ID）")
    location: str = Field(default="", description="线下地点/商户标识（虚实映射）")
    venue_point_id: str = Field(default="", description="绑定的线下点位 id（取自提示词方括号里的 id）；纯剧情节点留空")
    unlock_collected: list[str] = Field(default_factory=list, description="解锁需已收集的线索 id 列表")
    unlock_completed: list[str] = Field(default_factory=list, description="解锁需已完成的节点 id 列表")
    grant_collectibles: list[str] = Field(default_factory=list, description="完成后发放的线索 id 列表")
    complete_nodes: list[str] = Field(default_factory=list, description="完成后置为已完成的节点 id 列表")
    interactions: list[dict] = Field(default_factory=list, description="节点交互列表（puzzle 放可判定题型；scene 放剧情回味题或现场动作 photo/meditate）；judge 的 answer 只能是字符串 \"true\" 或 \"false\"（对＝true、错＝false），不要写「对」「正确」这类中文")
    # NPC 引用（spec §4.3）：纯剧情节点不绑 NPC 留空。R-N1/R-N2 完整性校验用。
    # ⚠️ 必须显式声明 —— LenientModel 是 extra=ignore，未声明字段会被 model_dump() 静默丢弃，
    # 下游 validate_wenlv_integrity 拿不到 npc_id ⇒ R-N1/R-N2 全部跳过（与 venue_point_id 同款约束）。
    npc_id: Optional[str] = Field(default=None, description="该节点触发的 NPC id（spec §4.3，对齐 WenlvNpc.id）；为空表示该节点不绑 NPC")
    npc_line_ids: list[str] = Field(default_factory=list, description="该节点引用的 NPC 台词 id 子集（spec §4.3，对齐 WenlvNpcLine.id）；R-N2 校验时需在所属 NPC.lines 内查台词是否存在")


class LevelCollectible(LenientModel):
    """可收集物（线索/印章）。"""

    id: str = Field(description="线索 id（CLUE_ 前缀）")
    name: str = Field(description="线索名")
    type: Literal["clue", "item", "achievement", "stamp"] = Field(default="clue", description="类型")
    rarity: str = Field(default="common", description="稀有度 common/rare/epic/legendary")
    description: str = Field(default="", description="描述")


class LevelTier(LenientModel):
    """集章档位（仅 rally 模式）。"""

    id: str = Field(description="档位 id（TIER_ 前缀）")
    name: str = Field(description="档位名")
    description: str = Field(default="", description="描述")
    collected_ids: list[str] = Field(default_factory=list, description="达成需收集的印章 id 列表")
    reward_id: str = Field(default="", description="奖励 id（REWARD_ 前缀）")


class LevelReward(LenientModel):
    """奖励/权益。"""

    id: str = Field(description="奖励 id（REWARD_ 前缀）")
    name: str = Field(description="奖励名")
    type: str = Field(default="coupon", description="coupon/merchant_rights/digital")
    value: str = Field(default="", description="价值描述")


class LevelDesign(LenientModel):
    """关卡设计产出（一键草稿第 3 阶段）。"""

    schema_version: str = Field(default="w3.0", description="schema 版本号")
    nodes: list[LevelNode] = Field(description="可玩节点列表")
    collectibles: list[LevelCollectible] = Field(default_factory=list, description="可收集物列表")
    endings: list[dict] = Field(default_factory=list, description="结局落库项[{id,title,text,collected_ids,reward_id,priority}]")
    tiers: list[LevelTier] = Field(default_factory=list, description="集章档位（rally）")
    rewards: list[LevelReward] = Field(default_factory=list, description="奖励列表")


# ===== ④ 视觉设计 =====

class VisualDesign(LenientModel):
    """视觉设计产出（一键草稿第 4 阶段）。"""

    schema_version: str = Field(default="w4.0", description="schema 版本号")
    colors: dict = Field(
        default_factory=dict,
        description=(
            "配色槽位 {primary,primarySoft,accent,accentText,background,surface,text}（共 7 槽位）；"
            "实际落库时仅 primary 会写入 theme.primaryColor，其余槽位由 template_id 引用的内置模板提供"
        ),
    )
    template_id: str = Field(default="", description="引用的设计模板 id（可选，如 tpl-guochao）")
    icons: list[dict] = Field(default_factory=list, description="图标 [{name,description,prompt}]")
    stamps: list[dict] = Field(default_factory=list, description="印章 [{name,shape,pattern,prompt}]")
    image_prompts: list[dict] = Field(default_factory=list, description="文生图 prompt [{asset_type,name,prompt,reference_hint}]")


# ===== ⑤ 完整性校验结果 =====

class IntegrityReport(BaseModel):
    """完整性校验结果（确定性规则产出，非 LLM）。"""

    valid: bool = Field(description="是否通过")
    errors: list[str] = Field(default_factory=list, description="错误文案列表（空=通过）")


# ===== ⑥ Refine 阶段补充 schema（collectible_image / reward_designer） =====

class WenlvNodeQuestion(LenientModel):
    """单题结构（与 TS WenlvInteraction 单对象对齐）。

    字段命名采用 camelCase，与前端 TS WenlvInteraction 单对象对齐，
    让 BFF 层无需字段名转换即可直接消费。
    """
    type: str = Field(description="题型：single/multiple/judge/input/photo/meditate")
    question: str = Field(description="题干")
    options: list[str] | None = Field(default=None, description="选项数组（single/multiple 必填，其他题型可空）")
    answer: str | list[str] | None = Field(default=None, description="答案：single 用 str，multiple 用 list[str]，judge 只能是字符串 'true' 或 'false'，其他题型可空")
    hint: str | None = Field(default=None, description="提示文本")
    collaborative: bool | None = Field(default=None, description="是否团队协作题")

class WenlvNodeProp(LenientModel):
    """节点剧情涉及的实体道具包建议（AI 履约包第一步）。"""
    name: str = Field(description="道具名")
    kind: Literal["letter", "key", "card", "prop"] = Field(default="letter", description="道具类型：letter 信件 / key 钥匙 / card 身份卡 / prop 其他")
    placeNote: Optional[str] = Field(default=None, description="放置位置（如「前台旧物包内」「客房枕头下」）")


class WenlvNode(LenientModel):
    """单个剧情节点 AI 生成输出 schema。

    字段命名采用 camelCase（storyText / chapterGoal / openingLine 等），与前端
    TS WenlvInteraction 单对象对齐，让 BFF 层无需字段名转换即可直接消费。
    """
    title: str = Field(description="节点标题")
    storyText: str = Field(description="剧情文本/旁白，2-4 段")
    puzzle: WenlvNodeQuestion | None = Field(default=None, description="单题对象（NPC 驱动节点可空）")
    grants: list[str] = Field(default_factory=list, description="证物发放 collectibleId 数组（必须引用剧本线索库真实存在的 id）")
    requires: str | None = Field(default=None, description="前置条件表达式（字符串形式，如 'CLUE_001 && NODE_002'，无前置时为 null）")
    chapterGoal: str | None = Field(default=None, description="NPC 驱动节点的章节目标描述（传统节点为 null）")
    openingLine: str | None = Field(default=None, description="NPC 开场白（无 NPC 时为 null）")
    props: Optional[list[WenlvNodeProp]] = Field(default=None, description="实体道具包建议（无实体道具时为 null）")

class CollectibleImagePrompt(LenientModel):
    """线索图鉴图 AI 生成 prompt 输出。"""
    image_prompt: str = Field(description="通义万相文生图提示词，含画风/元素/色调，长度 50-150 字")

class WenlvRewardItem(LenientModel):
    """单个奖励 AI 生成输出。"""
    name: str = Field(description="奖励名（2-8 字）")
    type: str = Field(description="奖励类型：coupon 券/merchandise 文创商品/digital 数字权益")
    description: str = Field(description="奖励描述（一句话，C 端展示用）")
    value: str | None = Field(default=None, description="价值描述，如「9 折券」「文创明信片一套」")
    image_prompt: str | None = Field(default=None, description="文创商品/数字徽章的文生图 prompt（券类奖励为 null）")

class WenlvRewards(LenientModel):
    """批量奖励 AI 生成输出。"""
    rewards: list[WenlvRewardItem] = Field(description="奖励数组（3-5 个）")


# ===== 剧情骨架（有向图） =====

class SkeletonEdge(LenientModel):
    """剧情骨架的一条边（节点间流转关系）。"""
    from_node_id: str = Field(description="起点节点 id（对齐 SkeletonNode.id）")
    to_node_id: str = Field(description="终点节点 id（对齐 SkeletonNode.id）")
    edge_type: Literal["auto", "choice", "puzzle_pass", "puzzle_fail"] = Field(
        default="auto", description="流转类型：auto 自动 / choice 玩家选择 / puzzle_pass 谜题通过 / puzzle_fail 谜题失败"
    )
    label: str = Field(default="", description="选项文案（仅 choice 类型必填，其余留空）")


class SkeletonNode(LenientModel):
    """剧情骨架的一个节点（轻量，不含完整剧情文本）。"""
    id: str = Field(description="节点 id（如 N001）")
    node_type: Literal["scene", "npc"] = Field(
        description="节点类型：scene 普通剧情（旁白/互动谜题/可选 NPC 出场） / npc NPC 剧情（AI 对话驱动章节）"
    )
    title: str = Field(description="节点标题")
    brief: str = Field(default="", description="节点剧情梗概（1-2 句，供后续逐节点生成时锚定）")


class WenlvPlotSkeleton(LenientModel):
    """剧情骨架：有向图结构（节点 + 边）。"""
    schema_version: str = Field(default="skeleton-v1", description="schema 版本")
    nodes: list[SkeletonNode] = Field(description="剧情节点列表（含入口和结局）")
    edges: list[SkeletonEdge] = Field(description="节点间流转边列表")

