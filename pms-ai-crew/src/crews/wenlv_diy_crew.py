# src/crews/wenlv_diy_crew.py
"""0079 剧本房 AI 协作 DIY 编排器：六 Agent × 七步状态机，校验重试熔断。

与 wenlv_creation（一键草稿、无人工断点）的根本区别（spec FR-10）：
  · 每步只产**草案**（schema 校验通过即返回给 API 层），由 API 层经
    WenlvDiySessionClient.save_draft 存 ai_sessions.draftSnapshots；
  · 用户确认后 API 层才调 adopt 落四表 —— 本编排器不直接落库；
  · 中断恢复读 ai_sessions（权威 stage），Redis 仅存运行态（SSE 心跳/进度）。

职责唯一（FR-9 / TR-12.1），由「stage→(agent, schema) 唯一映射」+ schema 形状隔离保证：
  编剧总监只产 intent（不产世界观/NPC/章节/场景/谜题）；
  世界观构建师产 worldview 与 skeleton（不写场景成稿/谜题）；
  角色设计师产 NPC 人格卡/关系（不写场景/谜题）；
  剧情编排师产 scenes + auto/choice flows（schema 里没有 puzzle/atoms 字段）；
  谜题设计师只按 scene_id 回填 puzzle/atoms/grants/成败边（schema 里没有剧情字段）；
  质检师只产 QaReport（findings + verdict），不改任何内容。

稳定产出闭环：JSON 截断/校验不过 → 带错误清单重跑（默认 2 次）→ 仍失败抛
StageFailedError 熔断（API 层据此置 FAILED，绝不静默入库）。
"""
import json
import logging
from typing import Dict, Optional

from crewai import Crew, Process, Task

from src.agents.wenlv_diy import (
    director_agent, world_builder_agent, character_designer_agent,
    story_planner_agent, puzzle_designer_agent, qa_inspector_agent,
)
from src.schemas.common import looks_truncated_json
from src.schemas.wenlv_diy import (
    DiyIntent, DiyWorldview, DiyCharacters, DiySkeleton, DiyScenes, DiyPuzzles, QaReport,
)
from src.services.wenlv_diy_session import WenlvDiySessionClient

logger = logging.getLogger(__name__)

# 七步顺序（与 ai_sessions.stage 枚举逐字一致）
STAGE_ORDER = ["intent", "worldview", "characters", "skeleton", "scenes", "puzzles", "publish"]
NEXT_STAGE: Dict[str, Optional[str]] = {
    "intent": "worldview", "worldview": "characters", "characters": "skeleton",
    "skeleton": "scenes", "scenes": "puzzles", "puzzles": "publish", "publish": None,
}

# stage → (agent, schema, 产物名)。唯一映射：删错/串线由结构测试钉死。
STAGE_SPECS = {
    "intent": (director_agent, DiyIntent, "intent"),
    "worldview": (world_builder_agent, DiyWorldview, "worldview"),
    "characters": (character_designer_agent, DiyCharacters, "characters"),
    "skeleton": (world_builder_agent, DiySkeleton, "skeleton"),
    "scenes": (story_planner_agent, DiyScenes, "scenes"),
    "puzzles": (puzzle_designer_agent, DiyPuzzles, "puzzles"),
    "publish": (qa_inspector_agent, QaReport, "qa_report"),
}


class StageFailedError(Exception):
    """阶段生成失败：JSON 解析/Pydantic 校验经重试后仍不合格（熔断，需人工或换版）。"""


def _parse_json(raw: str) -> dict:
    """剥 markdown 围栏 + 词法修复，复用 wenlv_creation 同款逻辑并区分截断。"""
    from src.crews.video_script_crew import _parse_json as _pj, _fix_json_string_newlines
    try:
        return _pj(raw)
    except Exception as first_err:
        try:
            return _pj(_fix_json_string_newlines(raw))
        except Exception as e:
            if looks_truncated_json(raw):
                raise ValueError(
                    f"输出被截断（撞 LLM max_tokens 上限），JSON 未闭合，原文 {len(raw)} 字符：{e}"
                ) from e
            raise first_err


def _brief(value, limit: int = 6000) -> str:
    """把上游草案/锚定上下文压成 JSON 注入 prompt（超长截断，防止 prompt 爆炸）。"""
    text = json.dumps(value, ensure_ascii=False)
    if len(text) > limit:
        return text[:limit] + f" …（已截断，共 {len(text)} 字符）"
    return text


def _anchor_brief(anchor: Optional[dict]) -> str:
    """步①锚定上下文渲染：场地能力档案 + 商户 + 真实点位清单（含 id）。"""
    if not anchor:
        return "（无场地锚定：本剧本房尚未绑定场地，不得虚构地点与商户。）"
    lines = []
    venue = anchor.get("venue") or {}
    if venue:
        lines.append(f"场地：{venue.get('name', '')}（id={venue.get('id', '')}）")
    profile = anchor.get("venueProfile") or {}
    if profile:
        lines.append(
            "场地能力档案："
            f"supportActions={_brief(profile.get('supportActions') or {}, 400)}；"
            f"deployableAtoms={_brief(profile.get('deployableAtoms') or [], 400)}；"
            f"routeRadiusM={profile.get('routeRadiusM')}；"
            f"timeWindows={_brief(profile.get('timeWindows') or [], 300)}"
        )
    merchants = anchor.get("merchants") or []
    if merchants:
        lines.append("合作商户（可入戏，不得编造未列出的商户）：")
        for m in merchants:
            lines.append(f"- [{m.get('id')}] {m.get('name', '')}：{m.get('description', '') or m.get('cipherDish', '')}")
    points = anchor.get("venuePoints") or []
    if points:
        lines.append("真实点位清单（venue_point_id 必须从方括号 id 原样选取，不得虚构）：")
        for p in points:
            lines.append(f"- [{p.get('id')}] {p.get('name', '')}；{p.get('address', '') or p.get('remark', '')}")
    return "\n".join(lines)


class WenlvDiyOrchestrator:
    """七步向导生成编排器（同步 LLM 调用；FastAPI 层用 asyncio.to_thread 包裹）。

    本类只负责「调度 agent → 解析 → schema 校验 → 重试/熔断」。
    会话 HTTP 与 SSE 运行态经注入的 session_client/redis 处理，测试可注入替身。
    """

    def __init__(self, session_client: Optional[WenlvDiySessionClient] = None, redis=None):
        self.client = session_client or WenlvDiySessionClient()
        self.redis = redis
        self.run_key = "wenlv_diy:run"

    # ---------- SSE 运行态（Redis；权威 stage 在 ai_sessions） ----------

    def _set_run(self, session_id: str, status: str, stage: str, extra: Optional[dict] = None):
        if not self.redis:
            return
        payload = json.dumps({"status": status, "stage": stage, **(extra or {})}, ensure_ascii=False)
        self.redis.set(f"{self.run_key}:{session_id}", payload)
        self.redis.expire(f"{self.run_key}:{session_id}", 6 * 3600)

    def _get_run(self, session_id: str) -> dict:
        if not self.redis:
            return {"status": "IDLE", "stage": "intent"}
        raw = self.redis.get(f"{self.run_key}:{session_id}")
        return json.loads(raw) if raw else {"status": "IDLE", "stage": "intent"}

    # ---------- 单 agent 执行：kickoff → JSON → schema 校验 → 重试 → 熔断 ----------

    def _run_agent(self, agent, task_desc: str, expected: str, schema_cls, retries: int = 2) -> Dict:
        """1 次首发 + retries 次带错误清单重跑；仍失败抛 StageFailedError。

        与 wenlv_creation.WenlvCreationOrchestrator._run_agent 同契约（TR-12.2）。
        """
        last_err: Optional[Exception] = None
        for attempt in range(retries + 1):
            desc = task_desc if attempt == 0 else task_desc + (
                f"\n\n上次输出 JSON 校验失败：{last_err}。"
                "请严格按字段输出合法 JSON，不要 markdown 围栏，不要多余文字。"
            )
            task = Task(description=desc, expected_output=expected, agent=agent)
            crew = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=True)
            result = crew.kickoff()
            raw = str(result.raw) if hasattr(result, "raw") else str(result)
            try:
                return schema_cls(**_parse_json(raw)).model_dump()
            except Exception as e:
                last_err = e
        raise StageFailedError(f"{expected} 校验重试后仍失败：{last_err}") from last_err

    # ---------- 七步调度 ----------

    def generate_draft(self, stage: str, context: Optional[dict] = None) -> Dict:
        """按七步状态机生成某一步的**草案**（不落库）。

        context 约定键（各步按需取用，缺省为空）：
          raw_text 用户原话；product_num 产品编号；anchor 锚定上下文；
          intent/worldview/characters/skeleton/scenes/puzzles 为上游已确认草案。
        """
        if stage not in STAGE_SPECS:
            raise ValueError(f"未知向导阶段：{stage}（合法值：{STAGE_ORDER}）")
        agent, schema_cls, label = STAGE_SPECS[stage]
        context = context or {}
        desc = self._build_prompt(stage, context)
        return self._run_agent(agent, desc, f"wenlv_diy {label} JSON", schema_cls)

    # 步①语义糖：总监把老板原话 + 锚定归一成 intent
    def generate_intent(self, raw_text: str, anchor: Optional[dict] = None,
                        product_num: str = "") -> Dict:
        return self.generate_draft("intent", {
            "raw_text": raw_text, "anchor": anchor, "product_num": product_num,
        })

    # 步⑤局部重生成（FR-10：逐场景细调；只走剧情编排师）
    def refine_scene(self, scene_id: str, instruction: str, context: dict) -> Dict:
        desc = self._scenes_prompt(context, focus_scene_id=scene_id, instruction=instruction)
        return self._run_agent(story_planner_agent, desc, "wenlv_diy scenes JSON", DiyScenes)

    # 步⑤全章一键生成（FR-10；只走剧情编排师）
    def generate_chapter_scenes(self, chapter_id: str, context: dict) -> Dict:
        desc = self._scenes_prompt(context, focus_chapter_id=chapter_id)
        return self._run_agent(story_planner_agent, desc, "wenlv_diy scenes JSON", DiyScenes)

    # 步⑦语义糖：质检师只报告
    def qa_review(self, graph_snapshot: dict) -> Dict:
        return self._run_agent(
            qa_inspector_agent, self._qa_prompt(graph_snapshot),
            "wenlv_diy qa_report JSON", QaReport)

    # ---------- 各步 prompt ----------

    def _id_rule(self, context: dict) -> str:
        num = context.get("product_num") or "X"
        return (f"\n\n【id 命名铁律】产品编号 {num}：NPC_{num}_01、CH_{num}_01、SCENE_{num}_001 等"
                "稳定命名；所有跨对象引用只能引用已存在 id，不得虚构。")

    def _build_prompt(self, stage: str, ctx: dict) -> str:
        if stage == "intent":
            return (
                f"老板的原话：{ctx.get('raw_text', '')}\n\n"
                f"场地反向锚定：\n{_anchor_brief(ctx.get('anchor'))}\n"
                "请把原话归一为 intent JSON：补全 theme/tone/duration_min/player_count/"
                "experience_goals/must_haves；anchor_usage 只能取自上面的真实锚定；"
                "关键信息缺失用 questions_for_user 反问（最多 3 条），齐全则留空数组。"
                "你只做意图归一，不写任何剧本内容。"
            )
        if stage == "worldview":
            return (
                f"已确认意图：{_brief(ctx.get('intent'))}\n"
                f"场地锚定：\n{_anchor_brief(ctx.get('anchor'))}\n{self._id_rule(ctx)}"
                "输出 worldview JSON（era/region/theme/tone/background 200-400 字/key_rules）。"
                "tone 必须与 intent 一致；key_rules 只能使用场地真实支持的能力。"
            )
        if stage == "characters":
            return (
                f"已确认意图：{_brief(ctx.get('intent'))}\n世界观：{_brief(ctx.get('worldview'))}\n"
                f"章节骨架（如已先出）：{_brief(ctx.get('skeleton'))}\n"
                f"场地锚定：\n{_anchor_brief(ctx.get('anchor'))}\n{self._id_rule(ctx)}"
                "输出 characters JSON（npcs 含 6 字段 persona 与 relationships）；"
                "relationships 只引用本批 NPC；身份尽量挂靠真实商户/场地角色。"
            )
        if stage == "skeleton":
            return (
                f"已确认意图：{_brief(ctx.get('intent'))}\n世界观：{_brief(ctx.get('worldview'))}\n"
                f"已确认 NPC（供节拍安排说话人）：{_brief(ctx.get('characters'), 3000)}\n"
                f"{self._id_rule(ctx)}"
                "输出 skeleton JSON：chapters[{id,title,time_label,goal,order,beats}]，"
                "每章 3-6 条节拍，末章导向结局收束。只写节拍，不展开场景正文。"
            )
        if stage == "scenes":
            return self._scenes_prompt(ctx)
        if stage == "puzzles":
            return (
                f"已确认世界观/意图：{_brief({'worldview': ctx.get('worldview'), 'intent': ctx.get('intent')})}\n"
                f"场地能力档案（atoms 只能用 deployableAtoms 与 supportActions 支持的动作）：\n"
                f"{_anchor_brief(ctx.get('anchor'))}\n"
                f"已有章节：{_brief(ctx.get('skeleton'), 3000)}\n"
                f"已有场景与流转（谜题只能引用这些 scene id）：{_brief(ctx.get('scenes'), 8000)}\n"
                f"{self._id_rule(ctx)}"
                "输出 puzzles JSON：fills[{scene_id,puzzle,atoms,grants,pass_to_scene_id,"
                "fail_to_scene_id,san_delta_pass,san_delta_fail}] + flows（仅 puzzle_pass/puzzle_fail）。"
                "只回填谜题，不修改任何剧情字段；结局/条件引用的证物必须由 grants 发放。"
            )
        if stage == "publish":
            return self._qa_prompt(ctx.get("graph_snapshot") or ctx)
        raise ValueError(f"未知向导阶段：{stage}")  # pragma: no cover

    def _qa_prompt(self, graph_snapshot: dict) -> str:
        return (
            "以下是待发布剧本房的完整图快照（worldview/npcs/chapters/scenes/flows）：\n"
            f"{_brief(graph_snapshot, 12000)}\n"
            "请逐条按发布闸规则 R1-R10 检查：引用闭环、结局可达、证物有发放出处、"
            "谜题题型/答案合法、点位真实、NPC 与对话引用有效、条件结构合法。"
            "输出 QaReport JSON：findings 给出 rule_id/severity/scene_id/message/ai_fixable/fix_hint，"
            "并汇总 ai_fixable_count/manual_count/ready_to_publish。你只报告，不修改任何内容。"
        )

    def _scenes_prompt(self, ctx: dict, *, focus_scene_id: Optional[str] = None,
                       focus_chapter_id: Optional[str] = None,
                       instruction: str = "") -> str:
        scope = ""
        if focus_scene_id:
            scope = (f"\n【逐场景细调】只重生成场景 {focus_scene_id}，其余场景与流转保持不变；"
                     f"细调指令：{instruction}\n")
        elif focus_chapter_id:
            scope = f"\n【全章一键生成】只展开章节 {focus_chapter_id} 下的全部场景，其它章不动。\n"
        return (
            f"已确认意图：{_brief(ctx.get('intent'))}\n世界观：{_brief(ctx.get('worldview'), 2500)}\n"
            f"NPC 清单（npc_id 只能从此选）：{_brief(ctx.get('characters'), 3000)}\n"
            f"章节骨架（chapter_id 只能从此选）：{_brief(ctx.get('skeleton'), 3000)}\n"
            f"已落盘/已生成的场景（增量重生成时保持引用一致）：{_brief(ctx.get('scenes'), 5000)}\n"
            f"场地锚定：\n{_anchor_brief(ctx.get('anchor'))}\n{self._id_rule(ctx)}{scope}"
            "输出 scenes JSON：scenes（仅 narrative/npc/ending 三型；不要输出 puzzle/atoms 字段）"
            "+ flows（仅 auto/choice；引用必须闭环；至少一个 ending 可达）。"
        )
