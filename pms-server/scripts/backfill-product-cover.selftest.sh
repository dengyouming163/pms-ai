#!/usr/bin/env bash
# backfill-product-cover.sql 的自测：造夹具 → 跑真 SQL → 断言终态 → 清理。
# 夹具 id 一律 bf-cov- 前缀（与 Task 3 的 bf-fix- 区分，便于并行排查），本地专用。
# 只在本地 aipms 上跑，绝不指向生产。
set -euo pipefail

SQL="$(dirname "$0")/backfill-product-cover.sql"
# 本地专用容器名硬编码在此（**好护栏，别改成变量**）：确保这条自测永远打不到生产。
# 容器不存在 / 未启动时会以 docker 的报错形式**失败**（不是静默跳过）——若报
# "No such container"，先 `docker ps` 确认 pms-pg-sop 在跑。
# `-v ON_ERROR_STOP=1` 与 backfill-product-cover.sql 头部给运维的生产姿势**必须一致**：
# 不带它时 psql 遇 ERROR 仍 EXIT=0（实测），自测就会「红灯当绿灯」。
PSQL=(docker exec -i pms-pg-sop psql -U gate -d aipms -v ON_ERROR_STOP=1)
q() { "${PSQL[@]}" -tAc "$1"; }

# 断言强度说明（**如实标注，别让后人以为是独立信号**）：
#   · "C 无 job 的存量封面不入候选" —— **没有任何单行变异能让它红**：删 UPDATE 的 cover_image
#     IS NULL 守卫、删状态过滤、倒排序，C 都绿，因为 C 根本没有 job、根本不进 `latest`。
#     它的价值是**重写护栏**：若将来有人把 UPDATE 改成「给所有产品兜底填图」这类形态，它会红。
#     它**不**在验 `AND p.cover_image IS NULL`（那是 D 的职责）。
#   · "幂等后 A 不变" —— **被上一条 `第二次 UPDATE 0` 逻辑蕴含**（第二次若改了 A，那条就红）。
#     保留仅出于可读性，是**复述**，不是独立信号。
#   · "E 资产 url 为空不入候选" —— **不是** url 守卫的独立信号：不挡时 ② 是把 NULL 写成 NULL，
#     终值不变，E 行照样绿。URL 守卫的检测器是 `复核 still_empty = 0` 与两条 `第二次 … = 0`。
#   · "F 悬空 asset_id 不入候选" —— **同样不是** url 守卫的独立信号（写进去的是 NULL，
#     `cover_image IS NULL` 恒真）。F 的真实职责是**钉住 ③ 与 ① 同源**：③ 若退回「只查 succeeded」，
#     F 会让 `复核 still_empty = 0` 变 1。
#   · "G 空串 url 不入候选" —— **是** `a.url <> ''` 的独立信号（'' 写进去看得见，与 E 的 NULL 不同）。
#   · "H 带 node_id 的历史 cover job 也要回填" —— **是**「CTE 不得加 node 约束」的**唯一**独立信号。
#     本 Task 的核心风险就是「照抄 Task 3 的 node_id 约束」，只有 H 能抓住它（变异 ⑦）。
#
# 清理用 trap，且必须在**第一次写库之前**装好：否则 SQL 那步硬失败时 set -e 直接退出，
# 清理段不执行、留残留污染后续所有结论。
cleanup() {
  "${PSQL[@]}" <<'CLEAN' >/dev/null 2>&1 || true
DELETE FROM pms_bui_wenlv_asset_jobs    WHERE id LIKE 'bf-cov-%';
DELETE FROM pms_bui_wenlv_design_assets WHERE id LIKE 'bf-cov-%';
DELETE FROM pms_bui_wenlv_nodes         WHERE id LIKE 'bf-cov-%';
DELETE FROM pms_bui_wenlv_products      WHERE id LIKE 'bf-cov-%';
CLEAN
}
trap cleanup EXIT

echo "== 0) 清残留并播种夹具 =="
# 夹具语义（C / D / E / F / G / H 各钉一条**不同**的性质，缺一条就有一部分不可观测）：
#   · bf-cov-C（**没有 job**）        → 证明 UPDATE 的**候选集**被 JOIN 收窄（`latest` 里根本没有它）。
#                                      它绿是 JOIN 的功劳，**不是** cover_image IS NULL 守卫的。
#   · bf-cov-D（**有成功 job 且已有封面**）→ 证明 `AND p.cover_image IS NULL` **守卫本身**生效。
#                                      它是唯一「删掉守卫就会红」的产品。
#   · bf-cov-E（成功 job，但资产 url 为 NULL）→ 让 ③ 能看见「url 为空因而填不上」这类产品。
#                                      ⚠️ **它自己那行断言不是 url 守卫的独立信号**（NULL→NULL 不可见）。
#   · bf-cov-F（成功 job，但 asset_id 悬空、无资产行）→ 证明 ③ 与 ① 同源：
#                                      ③ 若只查 succeeded，这里会报 still_empty=1，与「回填没跑干净」不可分。
#   · bf-cov-G（成功 job，但资产 url = **空串**）→ 证明 `a.url <> ''` 生效（G 的**独立**信号）。
#   · bf-cov-H（成功 cover job **且 node_id 非空**，即历史/迭代行形态）→ 证明 CTE **没有**照抄
#                                      Task 3 的 node 约束。若有人加上 `AND j.node_id IS NULL`，
#                                      H 会被静默漏掉 —— H 是本 Task 唯一的看守。
cleanup
"${PSQL[@]}" <<'SEED' >/dev/null
INSERT INTO pms_bui_wenlv_design_assets (id, type, name, url) VALUES
  ('bf-cov-a-old',     'cover', '旧封面',     'https://oss/bf-cov-old.png'),
  ('bf-cov-a-new',     'cover', '新封面',     'https://oss/bf-cov-new.png'),
  ('bf-cov-b',         'cover', '失败资产',   'https://oss/bf-cov-b.png'),
  ('bf-cov-e-nullurl', 'cover', '空 url 资产', NULL),
  ('bf-cov-g-emptyurl','cover', '空串 url 资产', ''),
  ('bf-cov-h',         'cover', 'H 的封面',   'https://oss/bf-cov-h.png');

INSERT INTO pms_bui_wenlv_products (id, name, cover_image) VALUES
  ('bf-cov-A', 'A 两条成功封面，应取最新', NULL),
  ('bf-cov-B', 'B 只有失败任务，应仍为空', NULL),
  ('bf-cov-C', 'C 无 job 的存量封面，不入候选', 'https://oss/bf-cov-keep.png'),
  ('bf-cov-D', 'D 有成功 job 的人工封面，不许被覆盖', 'https://oss/bf-cov-human.png'),
  ('bf-cov-E', 'E 成功 job 但资产 url 为空，不入候选', NULL),
  ('bf-cov-F', 'F 成功 job 但资产行悬空，不入候选', NULL),
  ('bf-cov-G', 'G 成功 job 但资产 url 是空串，不入候选', NULL),
  ('bf-cov-H', 'H 成功 job 且 node_id 非空，必须被回填', NULL);

-- H 构造时给 nodes 种一条 bf-cov-somenode（避免悬空 node 引用带来的困惑）
INSERT INTO pms_bui_wenlv_nodes (id, product_id, title, image) VALUES
  ('bf-cov-somenode', 'bf-cov-H', 'H 的历史节点引用', NULL);

INSERT INTO pms_bui_wenlv_asset_jobs
  (id, batch_id, asset_type, name, product_id, node_id, status, asset_id, finished_at) VALUES
  ('bf-cov-j1', 'bf-cov-b1', 'cover', '封面', 'bf-cov-A', NULL,             'succeeded', 'bf-cov-a-old',      '2026-01-01 00:00:00+00'),
  ('bf-cov-j2', 'bf-cov-b2', 'cover', '封面', 'bf-cov-A', NULL,             'succeeded', 'bf-cov-a-new',      '2026-06-01 00:00:00+00'),
  ('bf-cov-j3', 'bf-cov-b3', 'cover', '封面', 'bf-cov-B', NULL,             'failed',    'bf-cov-b',          '2026-06-01 00:00:00+00'),
  ('bf-cov-j4', 'bf-cov-b4', 'cover', '封面', 'bf-cov-D', NULL,             'succeeded', 'bf-cov-a-new',      '2026-07-01 00:00:00+00'),
  ('bf-cov-j5', 'bf-cov-b5', 'cover', '封面', 'bf-cov-E', NULL,             'succeeded', 'bf-cov-e-nullurl',  '2026-07-01 00:00:00+00'),
  ('bf-cov-j6', 'bf-cov-b6', 'cover', '封面', 'bf-cov-F', NULL,             'succeeded', 'bf-cov-missing',    '2026-07-01 00:00:00+00'),
  ('bf-cov-j7', 'bf-cov-b7', 'cover', '封面', 'bf-cov-G', NULL,             'succeeded', 'bf-cov-g-emptyurl', '2026-07-01 00:00:00+00'),
  -- j8 = H：历史/迭代形态 —— node_id 非空，但 cover 的键是 product_id
  ('bf-cov-j8', 'bf-cov-b8', 'cover', '封面', 'bf-cov-H', 'bf-cov-somenode', 'succeeded', 'bf-cov-h',          '2026-07-01 00:00:00+00');
SEED

echo "== 1) 跑真 SQL（第一次）=="
# -tA：SELECT 只回纯数字行，UPDATE 回 "UPDATE n"，便于机器取值（实测格式，非猜测）
raw=$("${PSQL[@]}" -tA -f - < "$SQL")
printf '%s\n' "$raw" | sed 's/^/    /'

# 取值：纯数字行依次是 would_fill / still_empty；UPDATE 行单独抓
nums=$(printf '%s\n' "$raw" | grep -E '^[0-9]+$' || true)
wf=$(printf '%s\n' "$nums" | sed -n '1p')
se=$(printf '%s\n' "$nums" | sed -n '2p')
upd=$(printf '%s\n' "$raw" | sed -n 's/^UPDATE \([0-9][0-9]*\)$/\1/p')

echo "== 2) 断言 =="
fail=0
check() { # $1=名称 $2=实际 $3=期望
  if [ "$2" = "$3" ]; then echo "  ok   $1 = $2"
  else echo "  FAIL $1: 实际『$2』期望『$3』"; fail=1; fi
}
check "A 取最新成功封面" "$(q "SELECT cover_image FROM pms_bui_wenlv_products WHERE id='bf-cov-A'")" 'https://oss/bf-cov-new.png'
check "B 失败任务不填"   "$(q "SELECT cover_image IS NULL FROM pms_bui_wenlv_products WHERE id='bf-cov-B'")" 't'
# ↓ 重写护栏，非独立信号，详见文件头注释
check "C 无 job 的存量封面不入候选" "$(q "SELECT cover_image FROM pms_bui_wenlv_products WHERE id='bf-cov-C'")" 'https://oss/bf-cov-keep.png'
check "D 有 job 的人工封面也不覆盖" "$(q "SELECT cover_image FROM pms_bui_wenlv_products WHERE id='bf-cov-D'")" 'https://oss/bf-cov-human.png'
check "E 资产 url 为空不入候选"     "$(q "SELECT cover_image IS NULL FROM pms_bui_wenlv_products WHERE id='bf-cov-E'")" 't'
check "F 悬空 asset_id 不入候选"    "$(q "SELECT cover_image IS NULL FROM pms_bui_wenlv_products WHERE id='bf-cov-F'")" 't'
check "G 空串 url 不入候选"         "$(q "SELECT cover_image IS NULL FROM pms_bui_wenlv_products WHERE id='bf-cov-G'")" 't'
# H 是「CTE 不得加 node 约束」的唯一信号：带 node_id 的历史/迭代 cover job 也必须被回填
check "H 带 node_id 的历史 cover job 也要回填" "$(q "SELECT cover_image FROM pms_bui_wenlv_products WHERE id='bf-cov-H'")" 'https://oss/bf-cov-h.png'
# would_fill = 2 是 H 被 ① 算进去的直接证据（A 与 H）
check "would_fill = 2（A 与 H）"  "$wf" '2'
# 口径断言：dry-run 的口径必须等于实际 UPDATE 的行数 —— 这正是「同为产品粒度」的直接表述
check "dry-run 口径与 UPDATE 一致" "$wf" "$upd"
check "复核 still_empty = 0"       "$se" '0'

echo "== 2b) 幂等（第二次跑）=="
before=$(q "SELECT cover_image FROM pms_bui_wenlv_products WHERE id='bf-cov-A'")
raw2=$("${PSQL[@]}" -tA -f - < "$SQL")
printf '%s\n' "$raw2" | sed 's/^/    /'
n2=$(printf '%s\n' "$raw2" | sed -n 's/^UPDATE \([0-9][0-9]*\)$/\1/p')
only2=$(printf '%s\n' "$raw2" | grep -E '^[0-9]+$' | sed -n '2p' || true)
check "第二次 UPDATE 0" "$n2" '0'
check "第二次 still_empty 0" "$only2" '0'
# ↓ 被上一条逻辑蕴含，仅复述，详见文件头注释
check "幂等后 A 不变"   "$(q "SELECT cover_image FROM pms_bui_wenlv_products WHERE id='bf-cov-A'")" "$before"

[ "$fail" = 0 ] && echo "SELFTEST PASS" || { echo "SELFTEST FAIL"; exit 1; }
