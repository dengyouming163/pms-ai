#!/bin/sh
# pms-nimi 数据库迁移脚本
# 用法: PG_HOST=postgres PG_DATABASE=aipms PG_USER=gate PG_PASSWORD=xxx ./scripts/run-mini-migration.sh

set -e

echo "[mini-migration] 开始执行 pms-nimi 建表脚本..."
PGPASSWORD="${PG_PASSWORD}" psql -h "${PG_HOST:-127.0.0.1}" -p "${PG_PORT:-5432}" -U "${PG_USER:-gate}" -d "${PG_DATABASE:-aipms}" -f drizzle/mini-m1.sql
echo "[mini-migration] 迁移完成！已创建 pms-nimi 相关表"

# 验证关键表是否存在
echo "[mini-migration] 验证表..."
PGPASSWORD="${PG_PASSWORD}" psql -h "${PG_HOST:-127.0.0.1}" -p "${PG_PORT:-5432}" -U "${PG_USER:-gate}" -d "${PG_DATABASE:-aipms}" -c "
  SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename IN (
    'pms_bui_mini_users','pms_bui_mini_store_config','pms_bui_coupons','pms_bui_coupon_records',
    'pms_bui_packages','pms_bui_promoters','pms_bui_referral_bindings','pms_bui_commission_records',
    'pms_bui_withdrawals','pms_bui_mini_payments','pms_bui_profit_sharings'
  ) ORDER BY tablename;
"
echo "[mini-migration] 完成"
