#!/bin/sh
# pms-server 容器启动入口：先建表/迁移，成功后再启动服务。
# - 空库：按 src/db/schema 执行 drizzle-kit push（与 docs/baseline 的本地建库方式一致）
# - 非空库 / push 之后：重放幂等 SQL 清单（与生产一致），失败即非 0 退出
# 迁移清单顺序取自原 Dockerfile CMD，请勿重排。
set -eu

if [ -z "${PG_HOST:-}" ] || [ -z "${PG_USER:-}" ] || [ -z "${PG_PASSWORD:-}" ] || [ -z "${PG_DATABASE:-}" ]; then
  echo "[entrypoint] PG_HOST / PG_USER / PG_PASSWORD / PG_DATABASE 必须全部设置" >&2
  exit 1
fi

psql_cmd() {
  PGPASSWORD="${PG_PASSWORD}" psql \
    -v ON_ERROR_STOP=1 \
    -h "${PG_HOST}" \
    -p "${PG_PORT:-5432}" \
    -U "${PG_USER}" \
    -d "${PG_DATABASE}" \
    "$@"
}

run_sql() {
  f="$1"
  echo "[entrypoint] applying drizzle/$f"
  if ! psql_cmd -f "drizzle/$f"; then
    echo "[entrypoint] migration failed: drizzle/$f" >&2
    exit 1
  fi
}

# ---- 空库引导：用 drizzle schema 一次建全表 ----
baseline="$(psql_cmd -tAc "SELECT to_regclass('public.pms_bui_brands') IS NOT NULL")"
if [ "${baseline}" != "t" ]; then
  echo "[entrypoint] empty database detected, running drizzle-kit push"
  if ! DATABASE_URL="postgresql://${PG_USER}:${PG_PASSWORD}@${PG_HOST}:${PG_PORT:-5432}/${PG_DATABASE}?sslmode=disable" \
    pnpm exec drizzle-kit push --config drizzle.config.ts --force; then
    echo "[entrypoint] drizzle-kit push failed" >&2
    exit 1
  fi
fi

# ---- 幂等 SQL 清单（生产同款）----
for f in mini-m1.sql mini-m2-douyin-platform.sql inbox-m1.sql inbox-m2-order-id-not-null.sql subscribe-auths-m1.sql satisfaction-surveys-m1.sql satisfaction-surveys-m2.sql stores-platformization-m1.sql mp-config-m1.sql 0002_add_ota_store_key.sql 0003_price-robot.sql 0007_price_robot_phase2.sql 0004_add_asset_tables.sql 0005_add_asset_value_column.sql 0006_add_asset_task_rules.sql 0008_add_task_rule_id.sql 0009_add_asset_room_type_ids.sql 0010_asset_task_rule_unique.sql 0011_grant_assets_manage.sql 0012_add_asset_name.sql 0013_add_price_robot_settings.sql 0014_widen_pricing_rules_ids.sql 0015_add_asset_sop_fields.sql 0016_add_pricing_center.sql 0017_add_platform_order_fields.sql 0018_add_checkin_orders.sql 0019_add_checkin_order_amount.sql 0020_wenlv_content.sql 0021_wenlv_rally.sql 0022_wenlv_claims_redeem_store.sql 0023_wenlv_design_system.sql 0024_wenlv_venue_point.sql 0025_wenlv_survey.sql 0026_wenlv_survey_attribution.sql 0027_wenlv_asset_gen.sql 0028_wenlv_placement_state.sql 0029_wenlv_client_reports.sql 0030_wenlv_judge_answer_normalize.sql 0032_wenlv_asset_jobs_collectible.sql 0034_wenlv_products_venue_idx.sql 0035_wenlv_human_review.sql 0036_wenlv_design_assets_product.sql 0037_wenlv_beacons.sql 0038_wenlv_design_assets_target.sql 0039_wenlv_venue_research.sql 0040_wenlv_play_mode.sql 0041_wenlv_free_script.sql 0042_wenlv_characters.sql 0043_wenlv_npcs.sql 0044_wenlv_nodes_npc.sql 0045_wenlv_progress_character_id.sql wenlv-team-m1.sql 0047_wenlv_nodes_map_coords.sql 0048_wenlv_teams.sql 0049_wenlv_teams_progress.sql 0050_wenlv_venue_cover_image.sql 0051_wenlv_teams_completed_at.sql 0046_wenlv_product_snapshots.sql 0052_wenlv_npc_persona.sql 0053_wenlv_nodes_npc_driver.sql 0054_wenlv_dialogues.sql 0056_wenlv_dialogues_team.sql 0055_wenlv_npc_relationships.sql 0057_wenlv_npc_jobs.sql 0058_wenlv_npc_jobs_node_id.sql 0059_wenlv_dialogues_visual_anchors.sql 0060_wenlv_triggers.sql 0061_wenlv_player_progress.sql 0062_wenlv_nodes_ar_san.sql 0063_wenlv_collectibles_qr.sql 0064_wenlv_nodes_ar_asset_urls.sql 0068_wenlv_npc_jobs_general_fields.sql 0069_wenlv_rewards_merchandise_type.sql 0070_wenlv_merch_redeems.sql 0071_wenlv_rewards_stock_sku.sql 0072_wenlv_claims_qrcode.sql 0073_wenlv_node_edges.sql 0075_wenlv_immersive_atoms.sql 0076_wenlv_director.sql 0077_wenlv_merchant_platform_link.sql 0078_wenlv_script_rooms.sql 0079_wenlv_unified_rebuild.sql 0080_wenlv_drop_old_tables.sql 0081_wenlv_merchant_master.sql 0082_director_alert_handles.sql 0083_checkin_order_entry_backfill.sql; do
  run_sql "$f"
done

echo "[entrypoint] migrations done; starting: $*"
exec "$@"
