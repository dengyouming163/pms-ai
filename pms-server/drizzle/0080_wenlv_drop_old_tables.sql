-- 0080_wenlv_drop_old_tables.sql
-- 0079 统一模型：旧 nodes / node_edges / endings 三表退役。
-- 生产数据已永久清空，四表（script_rooms/chapters/scenes/flows）+ ai_sessions 为唯一权威。
-- 幂等：DROP TABLE IF EXISTS；顺序按外键依赖（edges 依赖 nodes，故先删 edges 再删 nodes）。
-- endings 无外键依赖，任意位置可删。
DROP TABLE IF EXISTS pms_bui_wenlv_node_edges;
DROP TABLE IF EXISTS pms_bui_wenlv_endings;
DROP TABLE IF EXISTS pms_bui_wenlv_nodes;
