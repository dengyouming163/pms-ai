-- 2026-09-25 文旅团队准入（P2 · 票随人走）· 内容层
--
-- 手写、可重入（全部 IF NOT EXISTS / IF EXISTS）⇒ **可**登记进 Dockerfile 启动清单。
-- 🔴 但登记了 ≠ 本次上线会跑：那份清单是**烘焙在镜像里**的，而本次上线走 `docker cp` 覆盖源码 +
--    `restart`（不重建镜像）⇒ **本文件必须手工 `psql -1 -f` 执行一次**（0040 的头注已立此为例）。
--
-- 危害类别含 `DROP`（下面 drop 掉旧的整表唯一索引），这是**有意**的、且必须带 IF EXISTS：
--    uq_wenlv_progress_user_product 是 (mini_user_id, product_id) 全表唯一 —— 它没坏，
--    只是与「团队局」这个新形态不兼容：同一个人**第二场**会被它挡住，而报错指向一个看起来
--    无关的唯一约束。换成两条部分唯一索引后，散客唯一性由 uq_wenlv_progress_solo 逐字等价地承担。

-- ① 进度表加通道列（NULL = 散客；非 NULL = 该队伍的一员）
ALTER TABLE pms_bui_wenlv_progress ADD COLUMN IF NOT EXISTS session_id varchar(50);

-- ② 换索引：先删旧的整表唯一，再建两条部分唯一
--    ⚠️ 真正承重的次序**不在本段内部**，而在 ① 与 ② 之间：`ADD COLUMN`（①）必须排在下面两条
--       `CREATE INDEX` **之前**。两条索引的谓词都引用 `session_id`，而全新库上该列还不存在 ⇒
--       PG 报 42703（undefined_column）；CMD 里那条 `psql` 没带 `-v ON_ERROR_STOP`（同一条注释
--       在 Dockerfile 里 CMD 上方）⇒ 两条 `CREATE INDEX` 被**静默跳过**、整条命令仍 `exit 0`，
--       终态是**旧的整表唯一索引已经 DROP、新的两条一条也没建** = 完全失去唯一性，且无任何报错。
--       （2026-09-25 在 pms-pg-sop 上用 scratch 表实测：两条 CREATE INDEX 各报 42703、终态索引数 0。）
--    ⚠️ 本段内部的「先建后删 / 先删后建」则**两种都安全**：两侧都有 IF [NOT] EXISTS 守卫，不存在
--       「两条索引短暂并存会报错」这回事（实测对调本段次序：exit 0，终态同样是那两条部分唯一索引）。
DROP INDEX IF EXISTS uq_wenlv_progress_user_product;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_solo
  ON pms_bui_wenlv_progress (mini_user_id, product_id) WHERE session_id IS NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_team
  ON pms_bui_wenlv_progress (mini_user_id, product_id, session_id) WHERE session_id IS NOT NULL;

-- ③ 队伍表（一行 = 一支队；建队时一次插 N 行）
--    order_id / slot_id 是**跨服务引用、无外键**（交易侧库在另一个实例上，外键写不出来）。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_sessions (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  order_id uuid NOT NULL,
  slot_id uuid,
  code varchar(16) NOT NULL,
  seq integer NOT NULL DEFAULT 1,
  name varchar(50) NOT NULL,
  status varchar(20) NOT NULL DEFAULT 'forming',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_sessions_code ON pms_bui_wenlv_sessions (code);
