-- 0044：文旅「节点 NPC 出场」—— 在 pms_bui_wenlv_nodes 上加 npc_id / npc_line_ids
--
-- 为什么加在 nodes 而不是单独建关联表：
--   ① 一个节点出场一个 NPC（spec §4.3 扁平字段，不是 N:M 关系）—— 单字段 npc_id 即可，
--      关联表会引入毫无业务意义的 cardinality（一个节点挂多 NPC 是「节点群像场景」，
--      目前 spec 不支持，且即便支持也是「按节点顺序播多 NPC」=节点的子结构而非关联）；
--   ② npc_line_ids 是「过滤子集」而非「引用独立实体」（line 没有自己的 id 表，
--      它是 NPC.lines jsonb 数组里的一项）—— jsonb 数组天然适合存这种引用列表，
--      与 nodes.effects.grant（grant 是 collectible_id 数组）同口径；
--   ③ 软引用不加外键：与本域 venue_point_id / collectible_id 同口径，
--      NPC 删除由 T33 在 admin DELETE /npcs/:id 路由里反向清空引用（不是 DB ON DELETE CASCADE）。
--
-- 幂等性：两条 ALTER 都带 IF NOT EXISTS，重跑零效果零报错。
-- ⚠️ **不在迁移里回填**：存量节点的 npc_id 应保持 NULL（默认值），npc_line_ids 用 jsonb DEFAULT '[]'。
--    回填老节点会改变它们的行为（从「无 NPC 出场」变成「播 NPC 全部 lines」），属于业务变更。
--
-- ⚠️ 与 0043（npcs 表）的索引差异：本表 npc_id 是可空列 + 普通非唯一索引（用于反查「谁引用了此 NPC」），
--    0043 的 (product_id, id) 是唯一索引（计划要求）。两者口径不同，别对齐。
-- ⚠️ 登记进 Dockerfile CMD 清单**不等于**会自动跑：该清单烘焙在镜像里，
--    而 pms-server 走覆盖式部署（不重建镜像）⇒ 生产必须**手工 psql -f**（与 0043 同待遇）。
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS npc_id varchar(50);
ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS npc_line_ids jsonb NOT NULL DEFAULT '[]'::jsonb;

-- 反查「引用此 NPC 的所有节点」：T33 删 NPC 前用它找出所有引用节点并清空 npc_id / npc_line_ids。
-- 列可空 ⇒ 索引也包含 NULL 行（PG 默认行为），但本查询只 WHERE npc_id = $1（非空），NULL 行不命中。
CREATE INDEX IF NOT EXISTS idx_wenlv_nodes_npc_id ON pms_bui_wenlv_nodes (npc_id);
