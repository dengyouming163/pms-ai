"""视频脚本输出契约（对齐 plan 简化字段集，impl 标识 pms-ai-crew）。

本模块定义 pms-ai-crew 引擎 8 个 agent 的产出 Pydantic 模型，
用于对 wwwskill 高转化视频生产 Agent 包的输出做结构化校验。

注：这是对 wwwskill 输出 schema 的「方法论移植」——字段结构经 CrewAI
场景重设计（简化），与 wwwskill 原始 output-schema.json 非逐字段一致；
字段以本模块与 8 个 agent backstory 自洽为准。
"""

from pydantic import BaseModel, Field

from src.schemas.common import LenientModel


class ProductInsight(LenientModel):
    """产品洞察（对应 wwwskill 01_product_insight，简化字段）。"""

    schema_version: str = Field(default="v2.01", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    product_name: str = Field(description="产品名称")
    category: str = Field(description="产品品类")
    problem_solved: dict = Field(
        description="产品解决的问题：user_problem/user_value/consequences_if_not_solved"
    )
    target_market: str = Field(description="目标市场")
    core_selling_points: list[dict] = Field(description="核心卖点列表")
    competition_diff: str = Field(description="竞争差异化")


class UserPersona(LenientModel):
    """用户画像（对应 wwwskill 02_user_persona，简化字段）。"""

    schema_version: str = Field(default="v2.02", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    five_user_layers: list[dict] = Field(description="五层用户画像")
    main_target_user: str = Field(description="主要目标用户")


class DecisionMap(LenientModel):
    """决策地图（对应 wwwskill 03_decision_map，简化字段）。"""

    schema_version: str = Field(default="v2.03", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    decision_triggers: list[dict] = Field(description="决策触发点列表")
    purchase_timing: dict = Field(
        description="购买时机：best_window/reason/trigger_moment/avoid_timing"
    )


class VisualPlan(LenientModel):
    """视觉方案（对应 wwwskill 04_visual_plan，简化字段）。"""

    schema_version: str = Field(default="v2.04", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    visual_hammer: str = Field(description="视觉锤")
    text_hook: str = Field(description="文字钩子")
    selling_point_visuals: list[dict] = Field(description="卖点视觉化列表")
    visual_story_path: list[dict] = Field(description="视觉叙事路径")


class MarketingScript(LenientModel):
    """营销脚本（对应 wwwskill 05_marketing_script，简化字段）。"""

    schema_version: str = Field(default="v2.05", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    hook_candidates_0_5s: list[dict] = Field(description="0-5 秒钩子候选")
    need_hook_candidates_5_15s: list[dict] = Field(description="5-15 秒需求钩子候选")
    three_layer_solution: list[dict] = Field(description="三层解决方案")
    video_requirements: dict = Field(description="视频制作要求")


class ComplianceReport(LenientModel):
    """合规报告（对应 wwwskill 06_compliance_report，简化字段）。"""

    schema_version: str = Field(default="v2.06", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    risk_items: list[dict] = Field(
        description=(
            "风险项列表：type ∈ extreme_word/effect_claim/medical/income_promise/"
            "fear_induction/visual_risk/platform_risk/text_risk/disclosure_missing"
        )
    )
    score: int = Field(description="合规评分 0-100", ge=0, le=100)
    approved_script: dict = Field(
        description="锁定版脚本：title/script/selling_points/text_hook"
    )


class AssetPackage(LenientModel):
    """资产包（对应 wwwskill 07_asset_package，简化字段）。"""

    schema_version: str = Field(default="v2.07", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    character_assets: list[dict] = Field(description="角色资产列表")
    scene_assets: list[dict] = Field(description="场景资产列表")


class StoryboardPrompts(LenientModel):
    """分镜提示词（对应 wwwskill 08_storyboard_prompts，简化字段）。"""

    schema_version: str = Field(default="v2.08", description="schema 版本号")
    impl: str = Field(default="pms-ai-crew", description="实现标识")
    video_style: dict = Field(description="视频风格")
    character_reference: dict = Field(description="角色参考")
    scene_reference: dict = Field(description="场景参考")
    storyboard: list[dict] = Field(
        description=(
            "分镜脚本：每镜 11 字段 shot_id/duration/purpose/character_id/scene_id/"
            "visual_description/action/camera/dialogue/prompt/negative_prompt"
        )
    )
    generation_report: dict = Field(description="生成报告")


class FinalPackage(LenientModel):
    """最终打包（汇总 8 个 agent 产出）。"""

    project_info: dict = Field(description="项目信息")
    product_insight: ProductInsight = Field(description="产品洞察")
    user_persona: UserPersona = Field(description="用户画像")
    decision_map: DecisionMap = Field(description="决策地图")
    visual_plan: VisualPlan = Field(description="视觉方案")
    approved_script: dict = Field(description="锁定版脚本")
    character_assets: list[dict] = Field(description="角色资产列表")
    scene_assets: list[dict] = Field(description="场景资产列表")
    storyboard_prompts: StoryboardPrompts = Field(description="分镜提示词")
    generation_params: dict = Field(description="生成参数")
