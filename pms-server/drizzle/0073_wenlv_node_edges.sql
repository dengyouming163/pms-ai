-- 0073：剧情流程有向图重构
-- 1. 新建 pms_bui_wenlv_node_edges 表，描述节点之间的有向边
-- 2. 为 pms_bui_wenlv_nodes 增加视角角色字段 perspective_character_id

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_node_edges (
  id varchar(50) PRIMARY KEY,
  product_id varchar(50) NOT NULL,
  from_node_id varchar(50) NOT NULL,
  to_node_id varchar(50) NOT NULL,
  edge_type varchar(20) NOT NULL
    CHECK (edge_type IN ('auto', 'choice', 'puzzle_pass', 'puzzle_fail')),
  label varchar(200),
  condition jsonb,
  grants jsonb NOT NULL DEFAULT '[]'::jsonb,
  san_delta integer NOT NULL DEFAULT 0,
  sort_order integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_wenlv_edges_product ON pms_bui_wenlv_node_edges(product_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_edges_from ON pms_bui_wenlv_node_edges(from_node_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_edges_to ON pms_bui_wenlv_node_edges(to_node_id);

ALTER TABLE pms_bui_wenlv_nodes
  ADD COLUMN IF NOT EXISTS perspective_character_id varchar(50);
