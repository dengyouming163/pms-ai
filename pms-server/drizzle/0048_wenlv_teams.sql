-- 0048：文旅团队剧本「队伍表」—— pms_bui_wenlv_teams
--
-- 用途：剧本杀组局模式的玩家自组队（建队 / 邀请码拉人 / 选角 / 开局）。
--   与 pms_bui_wenlv_sessions（P2 票随人走的场次分队）不互替：sessions 由交易层驱动，
--   本表由玩家自发建队，无订单/场次依赖。
--
-- 成员存 jsonb `members` 数组（不拆子表）：队伍生命周期短、成员数小，整体读写更简单。
-- `invite_code` 全局唯一，join 时按它查队；`product_id` 上建普通索引便于按剧本筛队。
--
-- 幂等：CREATE TABLE / CREATE INDEX 均带 IF NOT EXISTS，重跑零效果。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_teams (
  id varchar(64) PRIMARY KEY,
  product_id varchar(64) NOT NULL,
  leader_id varchar(64) NOT NULL,
  invite_code varchar(8) NOT NULL,
  members jsonb NOT NULL DEFAULT '[]',
  squads jsonb,
  status varchar(20) NOT NULL DEFAULT 'forming',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_teams_invite_code ON pms_bui_wenlv_teams (invite_code);
CREATE INDEX IF NOT EXISTS idx_wenlv_teams_product_id ON pms_bui_wenlv_teams (product_id);
