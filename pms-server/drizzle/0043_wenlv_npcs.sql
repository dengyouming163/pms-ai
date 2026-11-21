-- 0043：文旅「剧本 NPC」—— 点位上的呈现单元表
--
-- 为什么是独立表，而不是塞进 characters 或 nodes：
--   ① characters 是「角色体系」池（人设 + 技能 + 隐秘任务），不含肖像/语音/台词；
--      NPC 是**实例化**到点位的呈现单元 —— 挂 portrait_url / voice_id / lines，与 characters
--      字段正交、不互替。把 NPC 塞进 characters 会让后者多 5 个对角色体系无意义的列。
--   ② nodes.narrationUrl 是「节点级旁白」，与 NPC 的 lines（多台词 + 各自语音）形状不同；
--      一个节点可以有多个 NPC，一个 NPC 可以不挂任何节点（游离 NPC）⇒ 塞不进 nodes 的 1:1 形状。
--   ③ lines 是 jsonb 数组（每条带 voiceUrl），与 nodes.interactions 同口径（jsonb 数组、default []）。
--
-- character_id 是**软引用**（不加外键，同本域 venueId / collectibleId 惯例）：
--   可空 = 环境叙述型 NPC（无 character 人设）；非空 = 引用 characters.id 的人设快照。
--   不加外键的理由与 culture_materials.research_id 同：被引用行会被覆盖/重写，而 NPC 行必须一直活着。
--
-- 幂等性（本表必须能进启动清单）：
--   只有 CREATE TABLE IF NOT EXISTS 与 CREATE INDEX IF NOT EXISTS，**零回填、零 UPDATE**
--   ⇒ 重跑收敛到同一终态，一行数据都不改。
--
-- ⚠️ 与 0042（characters）的索引差异：本表**额外**建 (product_id, id) 唯一索引。
--    characters 表刻意不建它（id 已是主键、唯一性由主键蕴含，见 0042 头注），本表保留是因为
--    计划 0043 显式要求。若后续评审认为冗余，删的是这条唯一索引，不是 id 主键。
-- ⚠️ 登记进 Dockerfile 的 CMD 清单**不等于**会自动跑：该清单烘焙在镜像里，
--   而 pms-server 走覆盖式部署（不重建镜像）⇒ 生产必须**手工 psql -f**（0033/0036/0042 同待遇）。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_npcs (
  id              varchar(50)  PRIMARY KEY,
  product_id      varchar(50)  NOT NULL,
  "order"         integer      NOT NULL DEFAULT 0,
  name            varchar(50)  NOT NULL,
  character_id    varchar(50),
  portrait_url    varchar(500),
  portrait_prompt text,
  voice_id        varchar(50),
  description     text,
  role            varchar(50),
  lines           jsonb        NOT NULL DEFAULT '[]'::jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now()
);

-- 端点级读路径是「按产品取整组」（与 characters 同），所以索引以 product_id 打头。
-- 额外的 (product_id, id) 唯一索引见上面头注（计划要求，与 characters 的「不建」口径不同）。
CREATE UNIQUE INDEX IF NOT EXISTS wenlv_npcs_product_id_id_uniq ON pms_bui_wenlv_npcs (product_id, id);
CREATE INDEX IF NOT EXISTS wenlv_npcs_product_id_idx ON pms_bui_wenlv_npcs (product_id);
