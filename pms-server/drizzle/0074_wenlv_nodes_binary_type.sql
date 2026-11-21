-- 0074：剧情节点类型二元化（普通剧情 scene / NPC 剧情 npc）
-- 背景：node_type 曾有 scene/puzzle/choice/npc/ending 五枚举；driver_type 为僵尸维度
--（0065 决定并入 node_type 并 DROP，但生产漏跑 DROP）。
-- 本迁移：① 建 legacy_node_type 影子列并把切换前的历史类型逐行封存（'v1:' 前缀）；
-- ② puzzle/choice/npc/ending 历史行一律落为 scene（puzzle/npc/chapter_goal 等内容列保留）；
-- ③ CHECK 收紧为二元；④ 补 DROP driver_type。
--
-- 为什么要影子列：旧版小程序（<1.1.0，线上在役）按 node_type 字符串渲染
--（扫码文案/完成判定/谜题容器/协作门都判 ==='puzzle'/'scene'），且只认 interactions[]
-- 不认单 puzzle 对象。落平后必须能把历史行的**原线格式类型**逐字回吐给旧版，
-- 否则 8 个 npc+puzzle 行会被投影成 'puzzle'、9 个 scene+puzzle 行也会翻成 'puzzle'，
-- 玩家侧可见行为即变。影子列就是旧版详情投影（routes/mini/wenlv.ts）的唯一保真来源。
-- 新版（1.1.0+）不读影子列，只看真实二元 nodeType + puzzle 对象。
--
-- ⚠️ 执行纪律：本文件已登记 drizzle-migration-registration.test.ts 的 NEVER_AUTO_RUN，手工执行。
-- ③④ 的 DDL（约束重建 / DROP COLUMN IF EXISTS）可重入；①② 用 'v1:' 前缀 + DEFAULT 'scene'
-- 做了重跑隔离：切换后新生行 legacy='scene'（不带前缀），既不会被回填、也不会被落平。
--
-- npc 存量行去向：原 node_type='npc' 的行同样会被落为 scene，但其 npc_id / chapter_goal 等
-- 内容列原样保留；需创作者通过 node_refine（AI 一键完善）或手动重新标记，才恢复 NPC 驱动。

-- 四条 DDL+DML 包成一个事务（41 行小表，无锁顾虑）。
BEGIN;

-- 1. 影子列 + 历史类型封存（仅首次：切换前所有行 legacy 为 NULL）
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS legacy_node_type varchar(20);
UPDATE pms_bui_wenlv_nodes
SET legacy_node_type = 'v1:' || node_type
WHERE legacy_node_type IS NULL
  AND node_type IN ('scene', 'npc', 'puzzle', 'choice', 'ending');
-- 切换后新生行的出生标记：无前缀 = 二元时代出生，投影按真实二元类型派生。
ALTER TABLE pms_bui_wenlv_nodes ALTER COLUMN legacy_node_type SET DEFAULT 'scene';
-- 回填已覆盖全部现存行（node_type CHECK 外的脏值在生产不存在），收紧 NOT NULL 与 ORM 对齐。
ALTER TABLE pms_bui_wenlv_nodes ALTER COLUMN legacy_node_type SET NOT NULL;

-- 2. 历史行类型全部收敛为 scene（仅 v1: 影子行；内容字段保留，玩家侧零变化）
UPDATE pms_bui_wenlv_nodes
SET node_type = 'scene'
WHERE node_type IS DISTINCT FROM 'scene'
  AND legacy_node_type LIKE 'v1:%';

-- 3. CHECK 收紧（先 DROP 旧约束，约束名随 PG 默认命名 <table>_<column>_check）
--    历史环境（0020 建列起 node_type 就是裸 varchar）可能从未存在过该 CHECK，
--    DROP 命中 0 行属预期 no-op。
ALTER TABLE pms_bui_wenlv_nodes
  DROP CONSTRAINT IF EXISTS pms_bui_wenlv_nodes_node_type_check;
ALTER TABLE pms_bui_wenlv_nodes
  ADD CONSTRAINT pms_bui_wenlv_nodes_node_type_check
  CHECK (node_type IN ('scene','npc'));

-- 4. 补跑 0065 漏执行的 driver_type DROP
ALTER TABLE pms_bui_wenlv_nodes DROP COLUMN IF EXISTS driver_type;

COMMIT;
