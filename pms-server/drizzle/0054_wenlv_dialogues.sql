-- 0054：文旅 NPC 对话记录表
--
-- 一次章节对话 = 一行。messages 存完整对话历史（role/content/ts）。
-- status: active（进行中）/ completed（章节完成）/ abandoned（玩家放弃）。
--
-- 幂等：CREATE TABLE IF NOT EXISTS + CREATE INDEX IF NOT EXISTS。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_dialogues (
  id            varchar(50)  PRIMARY KEY,
  product_id    varchar(50)  NOT NULL,
  node_id       varchar(50)  NOT NULL,
  npc_id        varchar(50)  NOT NULL,
  mini_user_id  varchar(50)  NOT NULL,
  character_id  varchar(50),
  messages      jsonb        NOT NULL DEFAULT '[]'::jsonb,
  status        varchar(20)  NOT NULL DEFAULT 'active',
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wenlv_dialogues_node ON pms_bui_wenlv_dialogues (node_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_dialogues_user ON pms_bui_wenlv_dialogues (mini_user_id);
