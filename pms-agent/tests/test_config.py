"""配置回归测试：环境变量别名、优先级、CORS 解析、DB URL。

容器内 compose 传 PMS_SERVER_URL / CORS_ORIGINS，这些行为直接决定 agent 能否启动与连到 pms-server。
每次构造独立 Settings() 实例读取当前 os.environ，避免污染进程级单例。
"""
from pathlib import Path

from app.config import REPO_ROOT, Settings


def test_pms_server_url_alias(monkeypatch):
    monkeypatch.setenv("PMS_SERVER_URL", "http://x:9090")
    monkeypatch.delenv("PMS_SERVER_INTERNAL_URL", raising=False)
    s = Settings()
    assert s.pms_server_internal_url == "http://x:9090"


def test_pms_server_internal_url_takes_priority(monkeypatch):
    monkeypatch.setenv("PMS_SERVER_URL", "http://fallback:9090")
    monkeypatch.setenv("PMS_SERVER_INTERNAL_URL", "http://preferred:9090")
    s = Settings()
    assert s.pms_server_internal_url == "http://preferred:9090"


def test_default_when_neither_set(monkeypatch):
    monkeypatch.delenv("PMS_SERVER_URL", raising=False)
    monkeypatch.delenv("PMS_SERVER_INTERNAL_URL", raising=False)
    s = Settings()
    assert s.pms_server_internal_url == "http://localhost:9090"


def test_cors_origins_comma_parsed(monkeypatch):
    monkeypatch.setenv("CORS_ORIGINS", "http://a:3000, http://b:3000 ,")
    s = Settings()
    assert s.cors_origins == ["http://a:3000", "http://b:3000"]
    assert isinstance(s.cors_origins, list)


def test_cors_origins_single_value_does_not_crash(monkeypatch):
    # 单值（非 JSON）场景：此前 list[str] 字段会被 env 源 json.loads 解码抛 SettingsError
    monkeypatch.setenv("CORS_ORIGINS", "http://localhost:3000")
    s = Settings()
    assert s.cors_origins == ["http://localhost:3000"]


def test_cors_origins_default(monkeypatch):
    monkeypatch.delenv("CORS_ORIGINS", raising=False)
    s = Settings()
    assert s.cors_origins == ["http://localhost:3000"]


def test_agent_database_url_contains_search_path(monkeypatch):
    monkeypatch.delenv("AGENT_DATABASE_URL", raising=False)
    s = Settings()
    assert "search_path%3Dagent" in s.agent_database_url


def test_agent_tools_base_derived(monkeypatch):
    monkeypatch.setenv("PMS_SERVER_INTERNAL_URL", "http://svc:9090/")
    s = Settings()
    assert s.agent_tools_base == "http://svc:9090/api/internal/agent-tools"


def test_fixtures_dir_default_under_repo_root(monkeypatch):
    """默认夹具目录必须是仓库根 eval/fixtures（计划约定），不是 pms-agent/eval。"""
    monkeypatch.delenv("FIXTURES_DIR", raising=False)
    s = Settings()
    assert s.fixtures_dir == REPO_ROOT / "eval" / "fixtures"
    assert isinstance(s.fixtures_dir, Path)


def test_fixtures_dir_env_override_used_in_container(monkeypatch):
    """P0-2 回归：容器内 config 位于 /app/app，默认会解析到 /eval/fixtures（错误）；
    compose 传 FIXTURES_DIR=/app/eval/fixtures 必须覆盖该默认值，回放才能找到夹具。"""
    monkeypatch.setenv("FIXTURES_DIR", "/app/eval/fixtures")
    s = Settings()
    assert s.fixtures_dir == Path("/app/eval/fixtures")
    assert isinstance(s.fixtures_dir, Path)
