import os
import logging
from dotenv import load_dotenv

load_dotenv()

logger = logging.getLogger(__name__)

# ====== 基础配置 ======

PMS_SERVER_URL = os.getenv("PMS_SERVER_URL", "http://localhost:9090")
INTERNAL_SERVICE_TOKEN = os.getenv("INTERNAL_SERVICE_TOKEN", "dev-internal-token")
REDIS_URL = os.getenv("REDIS_URL", "redis://localhost:6379")

AI_MAX_DAILY_TOKENS = int(os.getenv("AI_MAX_DAILY_TOKENS", "500000"))
AI_MONTHLY_BUDGET = int(os.getenv("AI_MONTHLY_BUDGET", "500"))

# ====== 旧版兼容（当 Redis 不可用时 fallback） ======

LLM_API_KEY = os.getenv("LLM_API_KEY", "")
LLM_BASE_URL = os.getenv("LLM_BASE_URL", "https://api.deepseek.com/v1")
LLM_MODEL = os.getenv("LLM_MODEL", "deepseek-v4-flash")
LLM_FALLBACK_MODEL = os.getenv("LLM_FALLBACK_MODEL", "qwen-max")

# ====== Redis 客户端（用于热切换模型） ======

_redis = None

def _get_redis():
    """懒加载 Redis 连接，失败时静默降级"""
    global _redis
    if _redis is not None:
        return _redis
    try:
        import redis as _r
        _redis = _r.from_url(REDIS_URL, socket_connect_timeout=2, socket_timeout=2)
        _redis.ping()
        logger.info("Redis 已连接，模型热切换可用")
    except Exception as e:
        logger.warning(f"Redis 不可用 ({e})，模型切换降级为 env fallback")
        _redis = None
    return _redis

# ====== 模型预设 ======
# 每个预设包含完整的 LLM 连接信息
# API Key 优先从专属环境变量读取，fallback 到通用 LLM_API_KEY

MODEL_PRESETS = {
    "deepseek": {
        "label": "DeepSeek V4",
        "api_key": os.getenv("LLM_API_KEY_DEEPSEEK", os.getenv("LLM_API_KEY", "")),
        "base_url": os.getenv("LLM_BASE_URL_DEEPSEEK", "https://api.deepseek.com/v1"),
        "model": os.getenv("LLM_MODEL_DEEPSEEK", os.getenv("LLM_MODEL", "deepseek-v4-flash")),
        "provider": "deepseek",  # CrewAI native provider
    },
    "qwen": {
        "label": "通义千问 Max",
        "api_key": os.getenv("LLM_API_KEY_DASHSCOPE", os.getenv("LLM_API_KEY", "")),
        "base_url": os.getenv("LLM_BASE_URL_DASHSCOPE", "https://dashscope.aliyuncs.com/compatible-mode/v1"),
        "model": os.getenv("LLM_MODEL_DASHSCOPE", "qwen-max"),
        "provider": "dashscope",
    },
}

# ====== 动态模型配置 ======

def _infer_preset_from_env() -> str:
    """根据当前 LLM_BASE_URL 推断使用哪个预设"""
    url = LLM_BASE_URL.lower()
    if "dashscope" in url or "aliyun" in url:
        return "qwen"
    return "deepseek"

def get_active_preset() -> str:
    """从 Redis 读取当前激活的预设名，fallback 到 env 推断"""
    r = _get_redis()
    if r:
        try:
            preset = r.get("ai:model:active")
            preset_str = preset.decode() if isinstance(preset, bytes) else preset
            if preset_str and preset_str in MODEL_PRESETS:
                return preset_str
        except Exception as e:
            logger.warning(f"Redis 读取 ai:model:active 失败: {e}")
    return _infer_preset_from_env()

def set_active_preset(preset: str) -> bool:
    """写入 Redis 切换当前模型预设，返回是否成功"""
    if preset not in MODEL_PRESETS:
        logger.error(f"无效预设: {preset}, 可用: {list(MODEL_PRESETS.keys())}")
        return False
    r = _get_redis()
    if not r:
        logger.warning("Redis 不可用，无法持久化模型切换")
        return False
    try:
        r.set("ai:model:active", preset)
        logger.info(f"模型已切换至: {MODEL_PRESETS[preset]['label']} ({preset})")
        return True
    except Exception as e:
        logger.error(f"写入 Redis 失败: {e}")
        return False

def get_active_config() -> dict:
    """获取当前激活的模型完整配置（每次调用都从 Redis 读取，实现热切换）"""
    preset = get_active_preset()
    cfg = MODEL_PRESETS.get(preset, MODEL_PRESETS["deepseek"])
    # 如果预设的 api_key 为空，fallback 到通用 LLM_API_KEY
    if not cfg["api_key"]:
        cfg = dict(cfg)
        cfg["api_key"] = LLM_API_KEY
    return cfg

# ====== CrewAI LLM 实例 ======

from crewai import LLM

def create_llm(temperature: float = 0.3, max_tokens: int = 4000, preset: str = None, model: str = None) -> LLM:
    """创建 CrewAI LLM 实例。
    preset 显式指定模型预设（"deepseek"/"qwen"）；None 时使用当前激活的模型配置。
    model 显式覆盖模型名（如 "deepseek-chat"）。用于规避 deepseek-v4-flash 的
    reasoning 突发推理把 max_tokens 预算吃光、导致 content 为空（finish=length）
    的问题——结构化 JSON 生成类 agent 应显式用 model="deepseek-chat"（非 reasoning，稳定输出）。"""
    if preset and preset in MODEL_PRESETS:
        cfg = MODEL_PRESETS[preset]
        if not cfg["api_key"]:
            cfg = dict(cfg)
            cfg["api_key"] = LLM_API_KEY
    else:
        cfg = get_active_config()
    model_name = model or cfg["model"]
    llm_model = f"{cfg['provider']}/{model_name}"
    return LLM(
        model=llm_model,
        base_url=cfg["base_url"],
        api_key=cfg["api_key"],
        temperature=temperature,
        max_tokens=max_tokens,
    )

# ====== 联网检索（文化素材 AI 补充）======

# DashScope **原生** 端点。
# 🔴 与 qwen 预设的 compatible-mode 端点（MODEL_PRESETS["qwen"]["base_url"]）**不是同一个**：
# 实测只有「原生端点 + 流式 + search_strategy=turbo」这一组会返回 search_info 来源列表，
# compatible-mode 与 qwen-max 都拿不到；agent/agent_max 策略直接 400。
# 四种参数组合的实测记录见
# docs/superpowers/specs/2026-09-23-wenlv-material-collect-assist-design.md §3（外层仓库）。
DASHSCOPE_SEARCH_URL = (
    "https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation"
)
DASHSCOPE_SEARCH_MODEL = os.getenv("LLM_MODEL_DASHSCOPE_SEARCH", "qwen3-max")

# 文化素材 AI 补充：每人每日次数上限。
# 🔴 **这是新建的闸**：本文件 :15-16 的 AI_MAX_DAILY_TOKENS / AI_MONTHLY_BUDGET
#    全仓没有任何读取点（只有定义），不是可复用的既有防线，别拿它们当挡箭牌。
AI_MATERIAL_OPTIMIZE_DAILY_LIMIT = int(os.getenv("AI_MATERIAL_OPTIMIZE_DAILY_LIMIT", "50"))


def get_search_api_key() -> str:
    """联网检索用的 DashScope key。来源链：LLM_API_KEY_DASHSCOPE → LLM_API_KEY。

    **调用时读 env**，而不是从 MODEL_PRESETS["qwen"]["api_key"] 取：后者在**导入期**
    求值，测试要覆盖这条链就得 reload 本模块，而 reload 会重跑 load_dotenv() 把
    .env 灌回环境、破坏用例隔离。取值域与 preset 基本一致，只在「第一档被设成空串」这一点上不同（此处继续往下取通用 key，
    那里会停在空串）—— 净效果由 preset 侧的 `if not cfg["api_key"]` 补偿拉回一致。
    """
    return os.getenv("LLM_API_KEY_DASHSCOPE") or os.getenv("LLM_API_KEY") or ""
