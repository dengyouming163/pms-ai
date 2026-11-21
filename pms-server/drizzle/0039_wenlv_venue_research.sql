-- 场地网络调研（采风前 AI 调研）：1 张新表 + 素材/点位各加一列 research_id。
--
-- 🔴 **纯幂等 DDL，零回填** —— 全条只有 CREATE TABLE IF NOT EXISTS、
--    ADD COLUMN IF NOT EXISTS、CREATE ... INDEX IF NOT EXISTS。
--    这不是风格问题：pms-server 的 Dockerfile CMD 把登记在清单里的迁移**每次容器启动都跑一遍**。
--    本表是「每次调研覆盖同一行」的**活表** —— 任何 UPDATE/INSERT 回填都会在第二次启动时
--    把用户正在看的报告洗掉。注册闸 drizzle-migration-registration.test.ts 的 hazardClasses()
--    会拒掉含回填的迁移；本文件一个不中（已实测，见提交信息）。
--
-- 场地 1:1 的调研行。1:1 由 venue_id 上的唯一索引兑现，是设计里的
-- 「只留最新一份，重跑覆盖」：重跑 UPDATE 同一行 ⇒ 不存在历史行，
-- 也就不存在「哪一份才是最新的」这个问题，读端无需排序/取最新。
--
-- 报告的唯一属主是 pms-server：ai-crew 只经 PATCH 端点回写，它不碰数据库。
-- 故 anchor/report/progress/search_log 内部的键名由 **ai-crew** 决定（snake_case），
-- 本服务不做任何大小写转换 —— 转换层就是分叉层。

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_venue_research (
  id          varchar(50)  PRIMARY KEY,
  -- 一个场地只有一行调研；重跑覆盖它，不新建行
  venue_id    varchar(50)  NOT NULL,
  -- running / ready / partial / failed。合法迁移只有 running → 其余三态
  status      varchar(20)  NOT NULL DEFAULT 'running',
  -- 选中的调研对象 {name, region, one_liner, source_urls[], confidence, why}
  anchor      jsonb,
  -- 候选快照：排查「为什么锚错了」的唯一依据，重跑时整体清空重写
  candidates  jsonb,
  -- 6 节正文；每节 {items[], sources[], note, not_found}
  report      jsonb,
  -- 逐节状态 {history:'done', points:'failed'}；取值 pending/running/done/failed。
  -- 读端**不许把「键不在」当成 done** —— 缺失只表示「还没轮到这一节」。
  progress    jsonb,
  -- 每节检索词 / 命中来源数 / 是否被 10 秒预算截断（不设用量闸，先记日志观察）
  search_log  jsonb,
  -- 终态失败原因（给人看的一句话）
  error       text,
  -- 操作人（平台用户 id）。不加外键，**仅审计归属**，可空不回填（同 created_by）
  started_by  varchar(50),
  -- 看门狗判定用：>15 分钟仍 running ⇒ 「疑似中断」，放行重跑。
  -- 少了它，进程重启丢掉终态的那一行会永远卡在 running 且被 409 挡住。
  started_at  timestamptz,
  finished_at timestamptz,
  created_at  timestamptz  NOT NULL DEFAULT now(),
  updated_at  timestamptz  NOT NULL DEFAULT now()
);

-- 具名唯一索引（而不是列内联 UNIQUE）：与 uq_wenlv_venue_points_code、
-- uq_wenlv_beacons_frame 同惯例 —— schema 侧写 uniqueIndex('…')，两处**同名**才不会漂。
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_venue_research_venue
  ON pms_bui_wenlv_venue_research(venue_id);

-- 「这条素材/点位是调研来的」的唯一可靠依据。
-- 靠 source 文案前缀去认是脆的（人一改文案就断），列才认得住。
-- 可空 = 人工创建；存量行全部为 NULL，**不回填**（回填等于编造来源）。
-- 不加外键：调研行会被重跑覆盖，而落地产物必须一直活着。
ALTER TABLE pms_bui_wenlv_culture_materials ADD COLUMN IF NOT EXISTS research_id varchar(50);
ALTER TABLE pms_bui_wenlv_venue_points      ADD COLUMN IF NOT EXISTS research_id varchar(50);
