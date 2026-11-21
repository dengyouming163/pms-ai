-- 游客端现场问题上报（块 E）。
-- 一条 = 一个游客在一个剧本上遇到的一类问题（60s 内同类合并，见服务端去重）。
-- 表名沿用本域的 pms_bui_wenlv_ 前缀；id 是 varchar(50) 应用侧生成（本仓无 uuid 列类型）。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_client_reports (
  id              varchar(50)  PRIMARY KEY,
  product_id      varchar(50)  NOT NULL,
  mini_user_id    varchar(50)  NOT NULL,
  node_id         varchar(50),
  -- audio / image / cert / other —— 固定枚举才能聚合出「哪类最多」，别用自由文本
  category        varchar(20)  NOT NULL,
  -- 触发来源：manual（游客主动点）/ auto（埋点自动报）。手动永远可用，自动可能不触发。
  source          varchar(20)  NOT NULL DEFAULT 'manual',
  platform        varchar(20),
  -- 自由补充（可选），与 category 分离
  note            varchar(500),
  -- 现场证据：页面上下文等，形状自由
  detail          jsonb        NOT NULL DEFAULT '{}'::jsonb,
  created_at      timestamptz  NOT NULL DEFAULT now()
);

-- 后台按「剧本 × 类别」聚合 + 按时间倒序列表，两条都吃这个索引
CREATE INDEX IF NOT EXISTS idx_wenlv_client_reports_product_created
  ON pms_bui_wenlv_client_reports (product_id, created_at DESC);

-- 去重查询（同游客×同剧本×同类别，最近 60s）走这条
CREATE INDEX IF NOT EXISTS idx_wenlv_client_reports_dedupe
  ON pms_bui_wenlv_client_reports (mini_user_id, product_id, category, created_at DESC);
