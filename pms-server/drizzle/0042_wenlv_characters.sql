-- 0042：文旅「剧本角色体系」—— 角色表
--
-- 为什么是独立表，而不是继续塞 products.config 的 jsonb：
--   ① PC 创作台要按角色行增删改，jsonb 做不到「改一个角色不影响其余角色」的原子写；
--   ② 角色要成为**机制引用目标**（P5 的 role/skill 条件、专属选项门控）⇒ 需要一个稳定、
--      可按行校验的 id；
--   ③ 素材流水线的回写是按 (target_kind, target_id) 定位的，jsonb 内的路径没有行列语义。
--
-- 与 config.characters 的关系（**设计意图**）：本表将成唯一权威，config.characters 退化为
--   AI 出稿快照、只作追溯。⛔ 这里不写「现状谁在读」：那类声明已反复失真，要判当前读路径按 `pmsBuiWenlvCharacters` 全仓 grep 当场取数。
--
-- 幂等性（本表必须能进启动清单）：
--   只有 CREATE TABLE IF NOT EXISTS 与 CREATE INDEX IF NOT EXISTS，**零回填、零 UPDATE**
--   ⇒ 重跑收敛到同一终态，一行数据都不改。
--
-- 三个属性列**刻意不给 DEFAULT**：它们是必填语义 —— 不给值就是没想过这个角色。
--   让 INSERT 报 23502（not_null_violation）而不是静默填一个看起来像作者决定的数字。
--   ⚠️ 别写成 42702 —— 那是 ambiguous_column，与这里无关。2026-09-29 在 pms-pg-sop 上实测：
--      漏填 vitality ⇒ `ERROR:  null value in column "vitality" ... violates not-null constraint`，
--      `SQLSTATE 23502`。
--   （写入口**打算**是两处，都在代码里显式给值：PC 表单 → T2 的 admin 路由；AI 出稿 → T7。
--     ⚠️ 别信注释里关于「今天有没有调用方」的话：2026-09-29 那次实测早已过期，按上法当场 grep。）
--
-- ⚠️ 登记进 Dockerfile 的 CMD 清单**不等于**会自动跑：该清单烘焙在镜像里，
--   而 pms-server 走覆盖式部署（不重建镜像）⇒ 生产必须**手工 psql -f**（0033/0036 同待遇）。
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_characters (
  id            varchar(50) PRIMARY KEY,
  product_id    varchar(50) NOT NULL,
  "order"       integer     NOT NULL DEFAULT 0,
  name          varchar(50) NOT NULL,
  faction       varchar(50) NOT NULL,
  faction_color varchar(20),
  identity      varchar(50) NOT NULL,
  identity_desc text,
  role          varchar(50),
  avatar_url    varchar(500),
  ip_prompt     text,
  vitality      integer     NOT NULL,
  wisdom        integer     NOT NULL,
  insight       integer     NOT NULL,
  skills        jsonb       NOT NULL DEFAULT '[]'::jsonb,
  hidden_quest  jsonb,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);

-- 端点级读路径都是「按产品取整组」（PC 创作台的 full、发布闸、mini detail 投影、admin 的 full 与列表端点）
-- ⇒ 索引以 product_id 打头。
-- ⚠️ 这里**不建** `unique(product_id, id)`：`id` 已是主键（全局唯一），
--    (product_id, id) 上的唯一性由主键蕴含 ⇒ 再建一个唯一索引只是白付写放大。
--    T2 的 POST 幂等重入检查按 id 单条件查已存在行（**已落地**） ⇒ 主键全局唯一**不是**可选项。
--    （原句的「同 (b)」指计划里的条目，代码里看不到；检查已落地。）
CREATE INDEX IF NOT EXISTS idx_wenlv_characters_product ON pms_bui_wenlv_characters (product_id);
