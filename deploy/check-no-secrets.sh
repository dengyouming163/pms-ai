#!/usr/bin/env bash
# 发布前密钥扫描：只检查 Git 已跟踪文件，发现疑似真实密钥即退出 1。
# 允许本地演示默认值（pms_local_dev / local-dev-*），它们写在 .env.example 中。
set -u

cd "$(dirname "$0")/.." || exit 1

fail=0

echo "[1/2] 检查是否误提交环境变量文件"
if git ls-files | grep -Eq '(^|/)\.env($|\.local$|\.production$)'; then
  echo "  ✗ 发现被跟踪的 .env 文件："
  git ls-files | grep -E '(^|/)\.env($|\.local$|\.production$)'
  fail=1
else
  echo "  ✓ 未跟踪 .env"
fi

echo "[2/2] 扫描常见密钥模式"
# 私钥块 / AWS key / OpenAI 风格 key / LangSmith key
pattern='BEGIN (RSA|OPENSSH|EC|DSA) PRIVATE KEY|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{24,}|lsv2_[A-Za-z0-9]{16,}'
if git grep -I -n -E "$pattern" -- . >/tmp/pms-secrets-scan.txt 2>/dev/null; then
  echo "  ✗ 命中疑似密钥："
  cat /tmp/pms-secrets-scan.txt
  fail=1
else
  echo "  ✓ 未命中"
fi

if [ "$fail" -ne 0 ]; then
  echo "密钥扫描失败，请移除后重试。"
  exit 1
fi
echo "密钥扫描通过。"
