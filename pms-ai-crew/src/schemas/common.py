from typing import get_origin, get_args

from pydantic import BaseModel, Field, model_validator


def looks_truncated_json(text: str) -> bool:
    """JSON 是否「被截断」（末尾落在未闭合的字符串/结构里），而非模型写错语法。

    触发场景：LLM 输出撞上 max_tokens 上限被硬切。2026-09-11 实测 level_design
    两次产出都精确停在 7996 tokens（= max_tokens 8000），JSON 停在 rewards 数组
    中途，但 json.loads 报的是 `Expecting ',' delimiter`，容易被误判成语法问题。

    按字符流扫描并维护 in_string/escaped 状态，故字符串内的 {} 与转义引号不会误判。
    """
    depth = 0
    in_string = False
    escaped = False
    for ch in text:
        if in_string:
            if escaped:
                escaped = False
            elif ch == "\\":
                escaped = True
            elif ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch in "{[(":
            depth += 1
        elif ch in "}])":
            depth -= 1
    return in_string or escaped or depth > 0


class AgentInsight(BaseModel):
    agent: str = Field(description="产出的 Agent 标识")
    type: str = Field(description="类型: pricing/customer/housekeeping/alert/report")
    title: str = Field(description="简明标题")
    content: str = Field(description="详细内容(Markdown)")
    action_level: str = Field(description="执行级别 L1/L2/L3", pattern=r"^L[123]$")
    confidence: float = Field(description="置信度 0.0-1.0", ge=0, le=1)
    reasons: list[str] = Field(description="决策依据列表")
    priority: int = Field(description="优先级 1-5", ge=1, le=5)
    expires_in_hours: int = Field(description="有效期(小时)", default=24)


class OrchestratorOutput(BaseModel):
    summary: str = Field(description="给老板看的总结文本")
    insights: list[AgentInsight] = Field(default_factory=list, description="产出的洞察列表")
    follow_up_questions: list[str] = Field(default_factory=list, description="建议追问的问题")


class LenientModel(BaseModel):
    """LLM 输出容错基类：单个 dict 自动包成 list[dict]，忽略未声明字段。

    LLM 生成嵌套 JSON 时经常把「应为一个 dict 数组」的字段输出成单个 dict（非确定性），
    或输出 schema 未声明的额外字段。统一在此兜底纠正，避免逐个字段打补丁。
    """

    model_config = {"extra": "ignore"}

    @model_validator(mode="before")
    @classmethod
    def _coerce_llm_types(cls, data):
        if not isinstance(data, dict):
            return data
        # 步骤1 解包：agent 常把字段嵌套在 schema 同名键下，
        # 若某个非预期键的值是 dict 且包含预期字段，则把其中缺失的预期字段提升到顶层。
        expected = set(cls.model_fields.keys())
        for key in list(data.keys()):
            val = data[key]
            if key not in expected and isinstance(val, dict):
                for k, v in val.items():
                    if k in expected and k not in data:
                        data[k] = v
        # 步骤2 类型纠正：单个 dict → list[dict]；str → dict。
        changed = {}
        for name, field in cls.model_fields.items():
            ann = field.annotation
            origin = get_origin(ann)
            val = data.get(name)
            if origin is list and val is not None:
                args = get_args(ann)
                inner = args[0] if args else None
                if isinstance(val, dict) and (inner is dict or (isinstance(inner, type) and issubclass(inner, BaseModel))):
                    changed[name] = [val]           # 单个 dict → list[dict / 嵌套模型]
            elif origin is None and ann is dict and isinstance(val, str):
                changed[name] = {"value": val}      # str → dict
        return {**data, **changed} if changed else data
