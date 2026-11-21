-- 0047：文旅「节点场地地图坐标」—— 在 pms_bui_wenlv_nodes 上加 map_x / map_y
--
-- 用途：SimplifiedMap 组件按真实场地布局渲染节点（归一化 0-1000）。
--   与 geo（GPS 经纬度，用于 uni.openLocation 系统导航）正交：
--     · geo  = 地球坐标，导航到现场用
--     · mapX/mapY = 场地示意图上的相对位置，画地图用
--   老剧本这两列为 NULL，端面 fallback 到网格布局（兼容、不报错）。
--
-- 为什么用 integer 而非 numeric：0-1000 归一化坐标是离散刻度，integer 足够
-- 且比对/排序更快；不需要小数精度（地图画布再做缩放）。
--
-- 幂等性：两条 ALTER 都带 IF NOT EXISTS，重跑零效果零报错。
-- ⚠️ 不在迁移里回填：存量节点保持 NULL（端面 fallback 网格），回填会改变它们的地图布局。
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS map_x integer;
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS map_y integer;
