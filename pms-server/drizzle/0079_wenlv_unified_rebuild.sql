-- 0079: 剧本房中心模型「全量对等」扩表（2026-10-09 统一重建）
--
-- 背景：生产 wenlv 旧模型（nodes/node_edges/endings…）数据已永久清空（Task 1），
--   0078 建立的 script_rooms/chapters/scenes/flows 成为唯一数据源。本迁移把旧
--   nodes/node_edges/endings 的**全部玩法字段对等补入** scenes/flows，并：
--     · chapters 补 ai_generated；
--     · script_rooms.content_id 加唯一约束；
--     · triggers 新增 scene_id（改绑场景，node_id 列保留待旧表退役）；
--     · merchant_partners 新增 script_room_id；
--     · 新建 pms_bui_wenlv_ai_sessions（P4 AI 协作 DIY 会话状态，ai-crew 经 HTTP 读写）。
--
-- 结局承载定稿：**scenes 可空列**（type='ending' 时使用 trigger_condition/priority/reward_id；
--   结局文案复用 content、结局图复用 image）。理由：引擎内核 selectEnding 只吃
--   {id, triggerCondition, priority} 列表，ending 场景行投影即可直接喂入，无需第二张表/二次 join，
--   也不与 flows 主路径重复表达；priority 最大者胜、同值按 id 次序的裁决语义不变。
--
-- 🔴 可重入：全部 ADD COLUMN / CREATE TABLE / CREATE INDEX 带 IF NOT EXISTS；
--    flows.condition 的 text→jsonb 转换用 DO 块按 information_schema.data_type 守护
--   （第二次跑时列已是 jsonb ⇒ 整块跳过；否则裸 ALTER 在 jsonb 列上重跑会因 `cond = ''` 报错）；
--    唯一约束用 DO 块吞 duplicate_object（Postgres 的 ADD CONSTRAINT 无 IF NOT EXISTS）。
-- 🔴 零回填、零 DROP、零 UPDATE/INSERT ⇒ 纯幂等，登记进 Dockerfile CMD 启动清单。

-- ============ scenes：旧 nodes 对等玩法列 ============
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS venue_point_id varchar(50);
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS requires jsonb;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS geo jsonb;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS map_x integer;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS map_y integer;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS image varchar(500);
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS narration_url varchar(500);
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS npc_line_ids jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS opening_line text;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS chapter_goal jsonb;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS perspective_character_id varchar(50);
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS san_delta integer NOT NULL DEFAULT 0;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ar_asset_url varchar(500);
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ar_asset_urls jsonb NOT NULL DEFAULT '{}'::jsonb;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ar_dialogue text;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false;
-- 结局承载列（仅 type='ending' 使用，其余场景恒 NULL）
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS trigger_condition jsonb;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;
ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS reward_id varchar(50);
CREATE INDEX IF NOT EXISTS idx_wenlv_scenes_venue_point ON pms_bui_wenlv_scenes(venue_point_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_scenes_npc_id ON pms_bui_wenlv_scenes(npc_id);

-- ============ flows：condition text→jsonb + 补旧 node_edges 对等列 ============
DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'pms_bui_wenlv_flows'
      AND column_name = 'condition'
      AND data_type <> 'jsonb'
  ) THEN
    ALTER TABLE pms_bui_wenlv_flows
      ALTER COLUMN condition TYPE jsonb
      USING CASE WHEN condition IS NULL OR btrim(condition) = '' THEN NULL ELSE condition::jsonb END;
  END IF;
END $$;
ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '[]'::jsonb;
ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS san_delta integer NOT NULL DEFAULT 0;
ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;
ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- ============ chapters：AI 产出标记（time_label/status/goal 已在 0078 建立） ============
ALTER TABLE pms_bui_wenlv_chapters ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false;

-- ============ script_rooms.content_id 唯一约束 ============
-- ADD CONSTRAINT 无 IF NOT EXISTS 语法 ⇒ DO 块做到幂等。
-- ⚠️ 必须同时捕获两个错误码：UNIQUE 约束会自动建同名索引，首次创建后再次 ADD 时，PG 按
--    "relation already exists" 报 42P07 duplicate_table（不是 CHECK 约束场景的 42710 duplicate_object）。
--    只写 duplicate_object（照抄 m7 的 CHECK 范式）在第二次启动时仍会 ERROR（生产空库两次连跑实测）。
DO $$
BEGIN
  ALTER TABLE pms_bui_wenlv_script_rooms
    ADD CONSTRAINT uq_wenlv_script_rooms_content UNIQUE (content_id);
EXCEPTION
  WHEN duplicate_object OR duplicate_table THEN NULL;
END $$;

-- ============ triggers：到场触发器改绑场景 ============
ALTER TABLE pms_bui_wenlv_triggers ADD COLUMN IF NOT EXISTS scene_id varchar(50);
CREATE INDEX IF NOT EXISTS idx_wenlv_triggers_scene ON pms_bui_wenlv_triggers(scene_id);

-- ============ merchant_partners：反向关联剧本房 ============
ALTER TABLE pms_bui_wenlv_merchant_partners ADD COLUMN IF NOT EXISTS script_room_id varchar(50);
CREATE INDEX IF NOT EXISTS idx_wenlv_merchant_partners_room ON pms_bui_wenlv_merchant_partners(script_room_id);

-- ============ ai_sessions：P4 AI 协作 DIY 会话状态（pms-ai-crew 经 HTTP + 内部 token 读写，不直连库） ============
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_ai_sessions (
  id varchar(50) PRIMARY KEY,
  script_room_id varchar(50) NOT NULL,
  user_id varchar(50) NOT NULL,
  -- 向导七步：意图采集→世界观→角色→章节骨架→逐章充实→谜题线索→发布预检
  stage varchar(20) NOT NULL DEFAULT 'intent',
  intent jsonb,
  transcript jsonb NOT NULL DEFAULT '[]'::jsonb,
  draft_snapshots jsonb NOT NULL DEFAULT '{}'::jsonb,
  status varchar(20) NOT NULL DEFAULT 'active', -- active/paused/completed/abandoned
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_ai_sessions_room ON pms_bui_wenlv_ai_sessions(script_room_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_ai_sessions_user ON pms_bui_wenlv_ai_sessions(user_id);
