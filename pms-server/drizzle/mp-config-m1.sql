-- 公众号运营配置表 M1 建表脚本（菜单/自动回复后台可配置，生产环境手动执行）
CREATE TABLE IF NOT EXISTS pms_bui_mp_config (
  id integer PRIMARY KEY,
  menu jsonb,
  welcome text,
  keyword_replies jsonb DEFAULT '[]',
  default_reply text,
  updated_at timestamptz DEFAULT now()
);
