#!/usr/bin/env bash
# backfill-node-image.sql 的自测：造夹具 → 跑真 SQL → 断言终态 → 清理。
# 夹具 id 一律 bf-fix- 前缀，本地专用。只在本地 aipms 上跑，绝不指向生产。
set -euo pipefail

SQL="$(dirname "$0")/backfill-node-image.sql"
# 本地专用容器名硬编码在此（**好护栏，别改成变量**）：确保这条自测永远打不到生产。
# 容器不存在 / 未启动时会以 docker 的报错形式**失败**（不是静默跳过）——若报
# "No such container"，先 `docker ps` 确认 pms-pg-sop 在跑。
# `-v ON_ERROR_STOP=1` 与 backfill-node-image.sql 头部给运维的生产姿势**必须一致**：
# 不带它时 psql 遇 ERROR 仍 EXIT=0（实测），自测就会「红灯当绿灯」。
PSQL=(docker exec -i pms-pg-sop psql -U gate -d aipms -v ON_ERROR_STOP=1)
q() { "${PSQL[@]}" -tAc "$1"; }

# 断言强度说明（**如实标注，别让后人以为是独立信号**）：
#   · "C 无 job 的存量图不入候选" —— **没有任何单行变异能让它红**：删 UPDATE 的 image IS NULL
#     守卫、删状态过滤、倒排序，C 都绿，因为 C 根本没有 job、根本不进 `latest`。
#     它的价值是**重写护栏**：若将来有人把 UPDATE 改成「给所有节点兜底填图」这类形态，它会红。
#     它**不**在验 `AND n.image IS NULL`（那是 D 的职责）。
#   · "幂等后 A 不变" —— **被上一条 `第二次 UPDATE 0` 逻辑蕴含**（第二次若改了 A，那条就红）。
#     保留仅出于可读性，是**复述**，不是独立信号。
#   · "E 资产 url 为空不入候选" —— 同上，**不是** `a.url IS NOT NULL` 的独立信号（详见夹具注释）。
#     D-2 的检测器是 `复核 still_empty = 0` 与两条 `第二次 … = 0`。
#   · "F 悬空 asset_id 不入候选" —— **同样不是 `a.url IS NOT NULL` 的独立信号**（实测：把 ② 的
#     资产 JOIN 改成 LEFT JOIN 再去掉 url 守卫，F 行仍绿 —— 写进去的是 NULL，`image IS NULL` 恒真）。
#     F 的真实职责是**钉住 ③ 与 ① 同源**：③ 若退回「只查 succeeded」，F 会让
#     `复核 still_empty = 0` 变 1。它绿只是「F 这一行没被写脏」，不等于 url 守卫生效。
#   · "G 空串 url 不入候选" —— **是** `a.url <> ''` 的独立信号（实测：三段一起去掉 `<> ''`
#     后 G 行红 f vs t）。G 与 E 的区别正在于此：NULL 写成 NULL 看不见，`''` 写成 `''` 看得见。
#
# 清理用 trap，且必须在**第一次写库之前**装好：否则 SQL 那步硬失败时 set -e 直接退出，
# 清理段不执行、留残留污染后续所有结论。
cleanup() {
  "${PSQL[@]}" <<'CLEAN' >/dev/null 2>&1 || true
DELETE FROM pms_bui_wenlv_asset_jobs    WHERE id LIKE 'bf-fix-%';
DELETE FROM pms_bui_wenlv_design_assets WHERE id LIKE 'bf-fix-%';
DELETE FROM pms_bui_wenlv_nodes         WHERE id LIKE 'bf-fix-%';
CLEAN
}
trap cleanup EXIT

echo "== 0) 清残留并播种夹具 =="
# 夹具语义（C / D / E / F / G 各钉一条**不同**的性质，缺一条就有一部分不可观测）：
#   · bf-fix-C（**没有 job**）        → 证明 UPDATE 的**候选集**被 JOIN 收窄（`latest` 里根本没有它）。
#                                      它绿是 JOIN 的功劳，**不是** image IS NULL 守卫的。
#   · bf-fix-D（**有成功 job 且已有图**）→ 证明 `AND n.image IS NULL` **守卫本身**生效。
#                                      它是唯一「删掉守卫就会红」的节点。
#   · bf-fix-E（成功 job，但资产 url 为 NULL）→ 让 ③ 能看见「url 为空因而填不上」这类节点。
#                                      ⚠️ **它自己那行断言不是 `a.url IS NOT NULL` 的独立信号**：
#                                      不挡时 ② 是把 NULL 写成 NULL，终值不变，E 行照样绿
#                                      （实测：三段一起去掉该条件后 E 绿，红的是
#                                      `复核 still_empty = 0` 与 `第二次 UPDATE 0 / still_empty 0`
#                                      —— 抓 D-2 的是那三行，不是 E）。E 留着是重写护栏。
#   · bf-fix-F（成功 job，但 asset_id 悬空、无资产行）→ 证明 ③ 与 ① 同源：
#                                      ③ 若只查 succeeded，这里会报 still_empty=1，与「回填没跑干净」不可分。
#   · bf-fix-G（成功 job，但资产 url = **空串**）→ 证明 `a.url <> ''` 生效（它是 G 的**独立**信号，
#                                      与 E 不同：NULL→NULL 不可见，''→'' 可见）。
#                                      同时也钉「三段同源」：③ 同样排除 `''`，故复核仍为 0 —— 若哪一段
#                                      漏了 `<> ''`，G 会被写进 image（G 行红）或把 still_empty 抬起来。
cleanup
"${PSQL[@]}" <<'SEED' >/dev/null
INSERT INTO pms_bui_wenlv_design_assets (id, type, name, url) VALUES
  ('bf-fix-a-old',    'background', '旧图',     'https://oss/bf-fix-old.png'),
  ('bf-fix-a-new',    'background', '新图',     'https://oss/bf-fix-new.png'),
  ('bf-fix-b',        'background', '失败资产', 'https://oss/bf-fix-b.png'),
  ('bf-fix-e-nullurl','background', '空 url 资产', NULL),
  ('bf-fix-g-emptyurl','background', '空串 url 资产', '');

INSERT INTO pms_bui_wenlv_nodes (id, product_id, title, image) VALUES
  ('bf-fix-A', 'bf-fix-prod', 'A 两条成功图，应取最新', NULL),
  ('bf-fix-B', 'bf-fix-prod', 'B 只有失败任务，应仍为空', NULL),
  ('bf-fix-C', 'bf-fix-prod', 'C 无 job 的存量图，不入候选', 'https://oss/bf-fix-keep.png'),
  ('bf-fix-D', 'bf-fix-prod', 'D 有成功 job 的人工图，不许被覆盖', 'https://oss/bf-fix-human.png'),
  ('bf-fix-E', 'bf-fix-prod', 'E 成功 job 但资产 url 为空，不入候选', NULL),
  ('bf-fix-F', 'bf-fix-prod', 'F 成功 job 但资产行悬空，不入候选', NULL),
  ('bf-fix-G', 'bf-fix-prod', 'G 成功 job 但资产 url 是空串，不入候选', NULL);

INSERT INTO pms_bui_wenlv_asset_jobs
  (id, batch_id, asset_type, name, node_id, status, asset_id, finished_at) VALUES
  ('bf-fix-j1', 'bf-fix-b1', 'background', '背景', 'bf-fix-A', 'succeeded', 'bf-fix-a-old',     '2026-01-01 00:00:00+00'),
  ('bf-fix-j2', 'bf-fix-b2', 'background', '背景', 'bf-fix-A', 'succeeded', 'bf-fix-a-new',     '2026-06-01 00:00:00+00'),
  ('bf-fix-j3', 'bf-fix-b3', 'background', '背景', 'bf-fix-B', 'failed',    'bf-fix-b',         '2026-06-01 00:00:00+00'),
  ('bf-fix-j4', 'bf-fix-b4', 'background', '背景', 'bf-fix-D', 'succeeded', 'bf-fix-a-new',     '2026-07-01 00:00:00+00'),
  ('bf-fix-j5', 'bf-fix-b5', 'background', '背景', 'bf-fix-E', 'succeeded', 'bf-fix-e-nullurl', '2026-07-01 00:00:00+00'),
  ('bf-fix-j6', 'bf-fix-b6', 'background', '背景', 'bf-fix-F', 'succeeded', 'bf-fix-missing',   '2026-07-01 00:00:00+00'),
  ('bf-fix-j7', 'bf-fix-b7', 'background', '背景', 'bf-fix-G', 'succeeded', 'bf-fix-g-emptyurl','2026-07-01 00:00:00+00');
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
check "A 取最新成功图"  "$(q "SELECT image FROM pms_bui_wenlv_nodes WHERE id='bf-fix-A'")" 'https://oss/bf-fix-new.png'
check "B 失败任务不填"  "$(q "SELECT image IS NULL FROM pms_bui_wenlv_nodes WHERE id='bf-fix-B'")" 't'
# ↓ 重写护栏，非独立信号，详见文件头注释
check "C 无 job 的存量图不入候选" "$(q "SELECT image FROM pms_bui_wenlv_nodes WHERE id='bf-fix-C'")" 'https://oss/bf-fix-keep.png'
check "D 有 job 的人工图也不覆盖" "$(q "SELECT image FROM pms_bui_wenlv_nodes WHERE id='bf-fix-D'")" 'https://oss/bf-fix-human.png'
check "E 资产 url 为空不入候选"   "$(q "SELECT image IS NULL FROM pms_bui_wenlv_nodes WHERE id='bf-fix-E'")" 't'
check "F 悬空 asset_id 不入候选"  "$(q "SELECT image IS NULL FROM pms_bui_wenlv_nodes WHERE id='bf-fix-F'")" 't'
# G 是 `a.url <> ''` 的独立信号（'' 写进去看得见）；E 不是，见文件头
check "G 空串 url 不入候选"       "$(q "SELECT image IS NULL FROM pms_bui_wenlv_nodes WHERE id='bf-fix-G'")" 't'
# 口径断言（D-3）：dry-run 的口径必须等于实际 UPDATE 的行数 —— 这正是「同为节点粒度」的直接表述
check "dry-run 口径与 UPDATE 一致" "$wf" "$upd"
check "复核 still_empty = 0"       "$se" '0'

echo "== 2b) 幂等（第二次跑）=="
before=$(q "SELECT image FROM pms_bui_wenlv_nodes WHERE id='bf-fix-A'")
raw2=$("${PSQL[@]}" -tA -f - < "$SQL")
printf '%s\n' "$raw2" | sed 's/^/    /'
n2=$(printf '%s\n' "$raw2" | sed -n 's/^UPDATE \([0-9][0-9]*\)$/\1/p')
only2=$(printf '%s\n' "$raw2" | grep -E '^[0-9]+$' | sed -n '2p' || true)
check "第二次 UPDATE 0" "$n2" '0'
check "第二次 still_empty 0" "$only2" '0'
# ↓ 被上一条逻辑蕴含，仅复述，详见文件头注释
check "幂等后 A 不变"   "$(q "SELECT image FROM pms_bui_wenlv_nodes WHERE id='bf-fix-A'")" "$before"

[ "$fail" = 0 ] && echo "SELFTEST PASS" || { echo "SELFTEST FAIL"; exit 1; }
