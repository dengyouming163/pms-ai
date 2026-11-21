#!/usr/bin/env bash
# 本地一键启动健康检查：依次等待 pms-server / pms-agent / pms-web。
# 每个服务最多轮询 60 秒（间隔 2 秒）；任一失败则打印该容器最近 50 行日志并退出 1。
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "${ROOT_DIR}"

check() {
  local service="$1"
  local url="$2"
  local i
  for i in $(seq 1 30); do
    if curl -fsS -o /dev/null --max-time 5 "${url}"; then
      echo "[ok] ${service} -> ${url}"
      return 0
    fi
    sleep 2
  done
  echo "[fail] ${service} -> ${url}" >&2
  docker compose logs --tail=50 "${service}" >&2 || true
  return 1
}

check pms-server http://localhost:9090/health || exit 1
# Task 7 之前 pms-agent 尚未实现，此处失败属预期
check pms-agent http://localhost:8000/health || exit 1
check pms-web http://localhost:3000 || exit 1

echo "all services healthy"
