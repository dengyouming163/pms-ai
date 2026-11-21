-- 文旅：点位与文化素材加采集人归属
--
-- 背景：现场采风由采风员（platform 角色 surveyor）在手机上完成，BFF 从已验签的
-- JWT 里取出 userId 放进 X-Platform-User-Id 透传过来。此前这个 id 解析出来就扔了，
-- 采集数据无法追溯到人。
--
-- 可空、无默认、**不回填**：历史行保持 NULL = 「未知采集人」。
-- 回填成某个具体用户是**编造归属**，比留空更糟 —— 留空是一个诚实的未知值。
--
-- 幂等：IF NOT EXISTS，可重复执行。
-- 长度 50 对齐同库的 owner_staff_id（平台用户 id，不加外键）与 platform 侧 pu-* 前缀 id。

ALTER TABLE pms_bui_wenlv_venue_points
  ADD COLUMN IF NOT EXISTS created_by varchar(50);

ALTER TABLE pms_bui_wenlv_culture_materials
  ADD COLUMN IF NOT EXISTS created_by varchar(50);
