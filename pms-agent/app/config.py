"""集中配置：所有环境变量在此读取，避免散落在各模块。

生产 / 测试共用同一份配置；测试通过覆盖环境变量或直接传入 fixtures_dir 来隔离。
"""
from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

# 仓库根目录：pms-agent/app/config.py 向上两级 = pms-ai 仓库根
REPO_ROOT = Path(__file__).resolve().parents[2]


class Settings(BaseSettings):
    """pms-agent 运行时配置。环境变量名与字段名大小写不敏感地对应。"""

    model_config = SettingsConfigDict(env_file=".env", extra="ignore")

    # pms-server 内部地址（agent 调工具的 base URL）
    pms_server_internal_url: str = "http://localhost:9090"
    # 内部服务鉴权 token，须与 pms-server 的 INTERNAL_SERVICE_TOKEN 一致
    internal_service_token: str = "local-dev-internal-token"
    # LLM provider：replay（回放夹具，默认）或 live（真实模型，M1 暂不启用）
    llm_provider: str = "replay"
    llm_model: str = "deepseek-chat"
    # 回放夹具目录，默认相对仓库根 eval/fixtures；测试可覆盖为临时目录
    fixtures_dir: Path = REPO_ROOT / "eval" / "fixtures"
    # Agent 检查点/事件库（Task 8 起使用；M1 测试不连库）
    agent_database_url: str = (
        "postgresql://pms:pms_local_dev@localhost:15433/pms_ai"
        "?options=-c%20search_path%3Dagent"
    )

    @property
    def agent_tools_base(self) -> str:
        """pms-server 内部 agent-tools 端点前缀（不含尾斜杠）。"""
        return f"{self.pms_server_internal_url.rstrip('/')}/api/internal/agent-tools"


# 进程级单例；测试如需隔离可构造 Settings(...) 单独实例
settings = Settings()
