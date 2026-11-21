# src/crews/video_script_crew.py
"""视频脚本生产 Crew 编排器：4 阶段 × 3 确认断点，Redis 状态机 + Pydantic 校验 + 重试熔断"""
import json
from typing import Dict, Optional
from crewai import Crew, Process, Task
from src.agents.video_script import (
    product_insight_agent, consumer_portrait_agent, decision_engine_agent,
    visual_architect_agent, video_director_agent, compliance_auditor_agent,
    asset_package_agent, director_translator_agent,
)
from src.schemas.video_script import (
    ProductInsight, UserPersona, DecisionMap, VisualPlan,
    MarketingScript, ComplianceReport, AssetPackage, StoryboardPrompts,
    FinalPackage,
)

# 阶段状态
STATES = [
    "CREATED", "STAGE1_DONE", "CONFIRM1_WAIT", "STAGE2_DONE", "CONFIRM2_WAIT",
    "STAGE3_DONE", "STAGE4_DONE", "CONFIRM3_WAIT", "COMPLETED", "FAILED",
]

# 确认节点定义（人性化收敛版，3 个）
CONFIRM_NODES = {
    "confirm_1": {
        "label": "脚本风格",
        "options": [
            {"id": "healing", "label": "治愈系", "desc": "雨天氛围感、慢生活、心灵治愈"},
            {"id": "promo", "label": "促销引流", "desc": "特价、限时、性价比"},
            {"id": "boss", "label": "老板人设", "desc": "老板出镜、真人背书、信任感"},
            {"id": "family", "label": "亲子度假", "desc": "亲子互动、遛娃、全家出游"},
        ],
        "default": "healing",
    },
    "confirm_2": {
        "label": "开头钩子",
        "options": [],  # 运行时由阶段②产出 3 候选填充
        "default": "1",
    },
    "confirm_3": {
        "label": "成片版本",
        "options": [
            {"id": "15s", "label": "15s 投流", "desc": "信息流冷启动"},
            {"id": "60s", "label": "60s 种草", "desc": "投流主力"},
            {"id": "90s", "label": "90s 深度", "desc": "内容种草"},
            {"id": "all", "label": "全部导出", "desc": "完整生产包"},
        ],
        "default": "all",
    },
}


class StageFailedError(Exception):
    """阶段生成失败：Pydantic 校验重试后仍不合格，触发错误熔断。"""


class VideoScriptOrchestrator:
    """分阶段编排器。每个阶段：跑 agent -> Pydantic 校验 -> 重试 1 次 -> 熔断。"""

    def __init__(self, redis):
        self.redis = redis
        self.state_key = "video_script:state"
        self.output_key = "video_script:output"

    # ---------- 状态持久化 ----------
    def _get_state(self, project_id: str) -> Dict:
        raw = self.redis.get(f"{self.state_key}:{project_id}")
        if raw:
            state = json.loads(raw)
            state.setdefault("meta", None)
            return state
        return {"status": "CREATED", "output": {}, "meta": None}

    def _set_state(self, project_id: str, status: str, output: Dict, meta: Optional[Dict] = None):
        """写状态；meta 约定：显式传 dict 覆盖归属，meta=None(=缺省)沿旧值，归属性只增不清。"""
        key = f"{self.state_key}:{project_id}"
        old_meta = None
        cur = self.redis.get(key)
        if cur:
            try:
                old_meta = json.loads(cur).get("meta")
            except Exception:
                old_meta = None
        if meta is None:
            meta = old_meta  # 携带式保留：后续阶段不显式传时沿用归属
        self.redis.set(key, json.dumps({"status": status, "output": output, "meta": meta}, ensure_ascii=False))
        self.redis.expire(key, 30 * 86400)  # state 30 天 TTL，防无限累积

    def _fail(self, project_id: str, err: Exception) -> Dict:
        """错误熔断：置 FAILED 状态 + 返回 Error Report（E002），禁止跳步继续。"""
        state = self._get_state(project_id)
        report = {"error_code": "E002", "error": str(err)}
        self._set_state(project_id, "FAILED", {**state["output"], "error": report})
        return {"status": "FAILED", **report}

    # ---------- 单阶段执行（校验 + 重试 + 熔断） ----------
    def _run_agent(self, agent, task_desc: str, expected: str, schema_cls) -> Dict:
        task = Task(description=task_desc, expected_output=expected, agent=agent)
        crew = Crew(agents=[agent], tasks=[task], process=Process.sequential, verbose=True)
        result = crew.kickoff()
        raw = str(result.raw) if hasattr(result, "raw") else str(result)
        try:
            # 尝试解析 JSON（剥掉可能的前后 markdown 围栏）
            data = _parse_json(raw)
            validated = schema_cls(**data)
            return validated.model_dump()
        except Exception as e:
            # 重试 1 次
            retry_desc = task_desc + f"\n\n上次输出 JSON 校验失败：{e}。请严格按字段输出合法 JSON，不要 markdown 围栏，不要多余文字。"
            task2 = Task(description=retry_desc, expected_output=expected, agent=agent)
            crew2 = Crew(agents=[agent], tasks=[task2], process=Process.sequential, verbose=True)
            result2 = crew2.kickoff()
            raw2 = str(result2.raw) if hasattr(result2, "raw") else str(result2)
            try:
                data2 = _parse_json(raw2)
                validated2 = schema_cls(**data2)
                return validated2.model_dump()
            except Exception as e2:
                raise StageFailedError(f"{expected} 校验重试后仍失败：{e2}") from e2

    # ---------- 阶段① Step01-02 ----------
    def run_stage1(self, project_id: str, brief: Dict, context: Dict) -> Dict:
        try:
            state = self._get_state(project_id)
            if state.get("status") != "CREATED":
                return {"status": "ERROR", "error": f"禁止跳步：当前状态 {state.get('status')}，需 CREATED"}
            insight = self._run_agent(
                product_insight_agent,
                f"产品信息：{json.dumps(brief, ensure_ascii=False)}\n门店上下文：{json.dumps(context, ensure_ascii=False)}\n输出 product_insight JSON。",
                "product_insight JSON", ProductInsight,
            )
            persona = self._run_agent(
                consumer_portrait_agent,
                f"product_insight：{json.dumps(insight, ensure_ascii=False)}\n输出 user_persona JSON（五类用户层+主攻）。",
                "user_persona JSON", UserPersona,
            )
            out = {**state["output"], "product_insight": insight, "user_persona": persona,
                   "industry": context.get("industry", "旅游住宿"),
                   "platform": context.get("platform", "通用")}
            self._set_state(project_id, "CONFIRM1_WAIT", out)
            return {"status": "CONFIRM1_WAIT", "confirm": CONFIRM_NODES["confirm_1"], "output": out}
        except StageFailedError as e:
            return self._fail(project_id, e)

    # ---------- 阶段② Step03-05 ----------
    def run_stage2(self, project_id: str, style: str) -> Dict:
        try:
            state = self._get_state(project_id)
            if state.get("status") != "CONFIRM1_WAIT":
                return {"status": "ERROR", "error": f"禁止跳步：当前状态 {state.get('status')}，需 CONFIRM1_WAIT"}
            out = state["output"]
            decision = self._run_agent(
                decision_engine_agent,
                f"product_insight：{json.dumps(out.get('product_insight', {}), ensure_ascii=False)}\nuser_persona：{json.dumps(out.get('user_persona', {}), ensure_ascii=False)}\n脚本风格：{style}\n输出 decision_map JSON。",
                "decision_map JSON", DecisionMap,
            )
            visual = self._run_agent(
                visual_architect_agent,
                f"product_insight：{json.dumps(out.get('product_insight', {}), ensure_ascii=False)}\ndecision_map：{json.dumps(decision, ensure_ascii=False)}\n脚本风格：{style}\n输出 visual_plan JSON（含文字钉）。",
                "visual_plan JSON", VisualPlan,
            )
            script = self._run_agent(
                video_director_agent,
                f"product_insight：{json.dumps(out.get('product_insight', {}), ensure_ascii=False)}\nuser_persona：{json.dumps(out.get('user_persona', {}), ensure_ascii=False)}\ndecision_map：{json.dumps(decision, ensure_ascii=False)}\nvisual_plan：{json.dumps(visual, ensure_ascii=False)}\n脚本风格：{style}\n输出 marketing_script JSON（0-5s 与 5-15s 各 3 钩子候选 + 三层解决）。",
                "marketing_script JSON", MarketingScript,
            )
            out.update({"decision_map": decision, "visual_plan": visual, "marketing_script": script})
            self._set_state(project_id, "CONFIRM2_WAIT", out)
            # 从钩子候选填充 confirm_2
            hooks = script.get("hook_candidates_0_5s", [])
            confirm2 = {**CONFIRM_NODES["confirm_2"],
                        "options": [{"id": str(i+1), "label": h.get("text", "")} for i, h in enumerate(hooks[:3])]}
            return {"status": "CONFIRM2_WAIT", "confirm": confirm2, "output": out}
        except StageFailedError as e:
            return self._fail(project_id, e)

    # ---------- 阶段③ Step06 合规锁定 ----------
    def run_stage3(self, project_id: str, hook_id: str, industry: str = "旅游住宿", platform: str = "通用") -> Dict:
        try:
            state = self._get_state(project_id)
            if state.get("status") == "STAGE3_DONE":
                # 幂等透传：confirm_2 请求在阶段③（合规锁定）与阶段④之间被中断（超时/重建）后，
                # 状态已持久化为 STAGE3_DONE，重试 confirm_2 时直接放行已锁定结果，让下游阶段④续跑。
                return {"status": "STAGE3_DONE", "output": state["output"]}
            if state.get("status") != "CONFIRM2_WAIT":
                return {"status": "ERROR", "error": f"禁止跳步：当前状态 {state.get('status')}，需 CONFIRM2_WAIT"}
            out = state["output"]
            # 从阶段①持久化的上下文读回行业/平台，确保双轨合规触发条件正确
            industry = out.get("industry", industry)
            platform = out.get("platform", platform)
            script = out.get("marketing_script", {})
            # 选中的钩子注入脚本
            selected_hook = ""
            hooks = script.get("hook_candidates_0_5s", [])
            idx = int(hook_id) - 1 if hook_id.isdigit() else 0
            idx = min(max(idx, 0), len(hooks) - 1)
            if hooks:
                selected_hook = hooks[idx].get("text", "")
            compliance = self._run_agent(
                compliance_auditor_agent,
                f"marketing_script：{json.dumps(script, ensure_ascii=False)}\n选中钩子：{selected_hook}\nproduct_info：{{\"industry\": \"{industry}\", \"platform\": \"{platform}\"}}\n输出 compliance_report JSON + approved_script（锁定）。",
                "compliance_report JSON（含 approved_script）", ComplianceReport,
            )
            out.update({"compliance_report": compliance, "approved_script": compliance.get("approved_script", {})})
            self._set_state(project_id, "STAGE3_DONE", out)
            return {"status": "STAGE3_DONE", "output": out}
        except StageFailedError as e:
            return self._fail(project_id, e)

    # ---------- 阶段④ Step07-08 ----------
    def run_stage4(self, project_id: str) -> Dict:
        try:
            state = self._get_state(project_id)
            if state.get("status") != "STAGE3_DONE":
                return {"status": "ERROR", "error": f"禁止跳步：当前状态 {state.get('status')}，需 STAGE3_DONE"}
            out = state["output"]
            asset = self._run_agent(
                asset_package_agent,
                f"user_persona：{json.dumps(out.get('user_persona', {}), ensure_ascii=False)}\nvideo_requirements：{json.dumps(out.get('marketing_script', {}).get('video_requirements', {}), ensure_ascii=False)}\n输出 asset_package JSON。",
                "asset_package JSON", AssetPackage,
            )
            storyboard = self._run_agent(
                director_translator_agent,
                f"approved_script：{json.dumps(out.get('approved_script', {}), ensure_ascii=False)}\nasset_package：{json.dumps(asset, ensure_ascii=False)}\nproduct_info：{json.dumps(out.get('product_insight', {}), ensure_ascii=False)}\n输出 storyboard_prompts JSON（锁定文字逐字继承）。",
                "storyboard_prompts JSON", StoryboardPrompts,
            )
            out.update({"character_assets": asset.get("character_assets", []),
                        "scene_assets": asset.get("scene_assets", []),
                        "storyboard_prompts": storyboard})
            self._set_state(project_id, "CONFIRM3_WAIT", out)
            return {"status": "CONFIRM3_WAIT", "confirm": CONFIRM_NODES["confirm_3"], "output": out}
        except StageFailedError as e:
            return self._fail(project_id, e)

    def finalize(self, project_id: str, version: str = "all") -> Dict:
        state = self._get_state(project_id)
        if state.get("status") != "CONFIRM3_WAIT":
            return {"status": "ERROR", "error": f"禁止跳步：当前状态 {state.get('status')}，需 CONFIRM3_WAIT"}
        out = state["output"]
        package = {
            "project_info": {"project_id": project_id, "version": version},
            "product_insight": out.get("product_insight"),
            "user_persona": out.get("user_persona"),
            "decision_map": out.get("decision_map"),
            "visual_plan": out.get("visual_plan"),
            "approved_script": out.get("approved_script"),
            "character_assets": out.get("character_assets"),
            "scene_assets": out.get("scene_assets"),
            "storyboard_prompts": out.get("storyboard_prompts"),
            "generation_params": {"version": version},
        }
        package = FinalPackage(**package).model_dump()
        self._set_state(project_id, "COMPLETED", {**out, "final_package": package})
        return {"status": "COMPLETED", "final_package": package}


def _parse_json(raw: str) -> Dict:
    """从 LLM 输出中提取 JSON：剥 markdown 围栏与前后杂讯。"""
    s = raw.strip()
    if s.startswith("```"):
        s = s.split("```", 2)[1]
        s = s.strip()
        if s.startswith("json"):
            s = s[4:].strip()
    start = s.find("{")
    end = s.rfind("}")
    if start == -1 or end == -1:
        raise ValueError(f"输出无 JSON 对象：{raw[:200]}")
    s = s[start:end+1]
    try:
        return json.loads(s)
    except json.JSONDecodeError:
        # LLM 生成长 JSON 时常见「字符串值内未转义真实换行」「引用对话误用英文半角
        # 双引号」等问题，做词法修复后重试一次，仍失败则交由上层重试/熔断。
        return json.loads(_fix_json_string_newlines(s))


def _fix_json_string_newlines(s: str) -> str:
    """修复 JSON 字符串值内未转义的真实换行/制表符，以及误用的英文半角双引号（词法级）。

    LLM 生成长 JSON 时常见两类问题：
    1. 字符串值内出现真实换行/制表符（如日期时间水印被输出成多行）；
    2. 字符串值内引用对话时误用英文半角双引号 `"` 而非中文引号 `“”`，导致引号提前闭合。

    本函数按字符流扫描，维护 in_string/escaped 状态；遇到字符串内的 `"` 时，
    用「后一个非空白字符是否为结构符（, : } ] 或 EOF）」判断它是闭合引号还是内容引号。
    """
    out = []
    in_string = False
    escaped = False
    n = len(s)
    i = 0
    while i < n:
        ch = s[i]
        if in_string:
            if escaped:
                out.append(ch)
                escaped = False
            elif ch == "\\":
                out.append(ch)
                escaped = True
            elif ch == '"':
                # 判断是闭合引号还是内容引号：闭合引号后必跟结构符或 EOF。
                j = i + 1
                while j < n and s[j] in " \t\r\n":
                    j += 1
                nxt = s[j] if j < n else ""
                if nxt in ("", ",", ":", "}", "]"):
                    out.append(ch)       # 闭合引号
                    in_string = False
                else:
                    out.append('\\"')    # 内容引号（英文半角误用），转义为字面量
            elif ch == "\n":
                out.append("\\n")
            elif ch == "\r":
                out.append("\\r")
            elif ch == "\t":
                out.append("\\t")
            else:
                out.append(ch)
        else:
            if ch == '"':
                in_string = True
            out.append(ch)
        i += 1
    return "".join(out)
