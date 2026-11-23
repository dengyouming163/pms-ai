"""集中配置：所有环境变量在此读取，避免散落在各模块。

生产 / 测试共用同一份配置；测试通过覆盖环境变量或直接传入 fixtures_dir 来隔离。
"""
from pathlib import Path
from typing import Any

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# 仓库根目录：pms-agent/app/config.py 向上两级 = pms-ai 仓库根
REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """pms-agent 运行时配置。环境变量名与字段名大小写不敏感地对应。"""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # pms-server 内部地址（agent 调工具的 base URL）。
    # 同时接受 PMS_SERVER_INTERNAL_URL 与 PMS_SERVER_URL 两个名字：
    # 前者是本服务的规范名，后者是 docker-compose 历史上给 agent 传的变量名；
    # 优先 PMS_SERVER_INTERNAL_URL，缺省回退 PMS_SERVER_URL，避免容器内取默认 localhost 连不通。
    pms_server_internal_url: str = Field(
        default="http://localhost:9090",
        validation_alias=AliasChoices("PMS_SERVER_INTERNAL_URL", "PMS_SERVER_URL"),
    )
    # 内部服务鉴权 token，须与 pms-server 的 INTERNAL_SERVICE_TOKEN 一致
    internal_service_token: str = "local-dev-internal-token"
    # LLM provider：replay（回放夹具，默认）或 live（真实模型，M1 暂不启用）
    llm_provider: str = "replay"
    llm_model: str = "deepseek-chat"
    # 回放夹具目录，默认相对仓库根 eval/fixtures；测试可覆盖为临时目录
    fixtures_dir: Path = REPO_ROOT / "eval" / "fixtures"
    # Agent 检查点/事件库（Task 8 起使用；M1 测试不连库）。默认指向宿主端口 15433，
    # 容器内由 compose 覆盖为 postgres:5432（见 docker-compose.yml）。
    agent_database_url: str = (
        "postgresql://pms:pms_local_dev@localhost:15433/pms_ai"
        "?options=-c%20search_path%3Dagent"
    )
    # CORS 允许来源，逗号分隔；默认本地 web (pms-web :3000)。
    # 声明为 Any 而非 list[str]：pydantic-settings 会把 list 字段的 env 值当作复杂类型
    # 先做 json.loads 解码，逗号串 "http://a,http://b" 不是合法 JSON 会抛 SettingsError
    # （连单值也会失败）。用 Any 让原始字符串到达下方 before-validator，再拆成 list[str]。
    cors_origins: Any = Field(default_factory=lambda: ["http://localhost:3000"])
    # 允许创建运行的商户白名单（逗号分隔）。空字符串表示不额外限制（仅本地单测/离线）。
    # 本地演示在 compose 中固定为 demo-yunqi，阻断任意 merchant_id 的跨商户读写。
    allowed_merchants: str = ""

    # LangSmith 双写（可选）：只有 tracing_v2 为真且 api_key 非空才启用；否则零副作用。
    # 关闭时不会发起任何外部请求，评测与离线演示不受影响。
    langchain_tracing_v2: bool = False
    langchain_api_key: str = ""
    langchain_project: str = "pms-ai"

    @property
    def allowed_merchant_list(self) -> list[str]:
        """把 AGENT_ALLOWED_MERCHANTS 拆成去空白后的列表。"""
        return [item.strip() for item in self.allowed_merchants.split(",") if item.strip()]

    @field_validator("cors_origins", mode="before")
    @classmethod
    def _split_cors_origins(cls, value):
        """把 CORS_ORIGINS 环境变量（逗号分隔字符串）拆成列表；空值回落默认。"""
        if value is None or value == "":
            return ["http://localhost:3000"]
        if isinstance(value, str):
            parts = [origin.strip() for origin in value.split(",")]
            return [origin for origin in parts if origin]
        return value

    @property
    def agent_tools_base(self) -> str:
        """pms-server 内部 agent-tools 端点前缀（不含尾斜杠）。"""
        return f"{self.pms_server_internal_url.rstrip('/')}/api/internal/agent-tools"


# 进程级单例；测试如需隔离可构造 Settings(...) 单独实例
settings = Settings()
