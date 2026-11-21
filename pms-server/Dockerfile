FROM node:22-alpine
ENV LANG=C.UTF-8
WORKDIR /app
# 安装 PostgreSQL 客户端用于启动前建表迁移
# 注：不设容器 TZ（容器保持 UTC）；素材自动化等时区敏感逻辑已在代码内显式用 BJ_OFFSET_MS 处理，TZ 无关。
# 注意：本 RUN 层保持与线上已构建镜像完全一致以命中缓存 —— 若需修改 apk/tzdata 会触发 pnpm 全量重装（ffmpeg-static postinstall 访问 GitHub 可能挂起）。
RUN apk add --no-cache postgresql-client
COPY package.json pnpm-lock.yaml ./
RUN npm config set registry https://registry.npmmirror.com && \
    npm install -g pnpm@9 && \
    pnpm config set registry https://registry.npmmirror.com && \
    pnpm install --frozen-lockfile
COPY src/ ./src/
COPY drizzle/ ./drizzle/
COPY drizzle.config.ts tsconfig.json ./
COPY scripts/ ./scripts/
EXPOSE 9090
# ⚠️ **新增迁移必须追加到 `docker-entrypoint.sh` 的列表末尾**（幂等 SQL 已放 drizzle/ 还不够）。
#    这个列表是生产唯一的自动迁移机制 —— deploy.sh 的兜底清单只到 0017。
#    漏登记＝新列永远不建，而 schema 里已声明 ⇒ drizzle 整行 select 命中 42703 ⇒ 该模块读接口全 500。
#    ⚠️ 本列表烘焙在镜像里，而 pms-server 走覆盖式部署（不重建镜像）⇒ 新迁移登记了也**不会自动跑**，必须手工 psql -f（0033/0036 同待遇）。
# ⚠️ **但「回填非幂等」的迁移不得登记** —— 下面这几条缺在清单里**不是遗漏**，别当漏项补上：
#    · 0000_next_steel_serpent.sql / 0001_add_multi_tenant_fields.sql：建库基线引导脚本
#      （0000 建 25 张表，无任何破坏性语句；0001 有 38 处裸 ADD COLUMN + 改数据的 UPDATE/ALTER COLUMN）。
#      ⚠️ 0001 里最危险的是 `:88 ALTER TABLE "pms_bui_staff" DROP COLUMN "stores";` ——
#      那是重跑时**唯一真会删东西**的语句（其余 `UPDATE … SET store_id='default_store'`
#      因紧随其后的 `SET NOT NULL` 恒影响 0 行）。`stores` 若在此后被重建过，重跑就会删掉它
#      ⇒ 这两条只准在建库时执行一次。
#    · 0031_wenlv_ending_priority.sql：DDL 幂等，但回填会把 **priority = 0** 的行重排成 1..k。
#      而 0 是**人类能显式设的合法值**（创作台 ending-form.tsx:58 的 `Number(d.priority) || 0`、
#      后台 wenlv.ts:1262 的 `typeof body.priority === 'number' ? … : 0`）⇒ 重跑会把作者
#      「设 0 = 平手必输」的结局静默提升到 1，与既有 priority=1 者平手后按 id 字典序决胜
#      （wenlv-engine.ts:78）⇒ **启动即可能改变游客实际拿到的结局**。
#    · 0033_wenlv_asset_studio.sql：DDL 幂等，但 is_selected 回填非幂等 —— 用户改选过之后
#      重跑会撞部分唯一索引 uq_wenlv_design_assets_selected 报 unique violation，整条 UPDATE
#      原子回滚 ⇒ 回填**静默 no-op**。文件自己也写着「只可执行一次」「须手工在生产执行」。
#    以上几条都须**手工 psql 执行一次**，不进启动清单；它们的对象在生产均已存在，不登记不丢东西。
#    ⚠️ 但 0038 是**这条规则的例外**，别按本规则把它摘掉：它的回填写在
#      `NOT EXISTS(列还不存在)` 的 DO 守护块里 ⇒ **重跑整块跳过、一行都不改**。
#      理由是「重跑什么都不做」，**不是**「收敛到同一终态」—— 该文件的头注有完整推导。
#    ⚠️ 但 0038 还**依赖 0033 的列**（`design_assets.job_id`、`asset_jobs.target_kind`，都由 0033 加、
#      而 0033 故意不在本清单里）⇒ **全新库必须先手工跑 0033**；否则 0038 的 DO 块报 42703 原子回滚、
#      **两列永不建**，而 schema 已声明它们 ⇒ 该模块读接口全 500（即 `:20` 那个后果，只是成因是依赖）。
#
# ⚠️ 入口脚本里的 psql **带 `-v ON_ERROR_STOP=1`** ⇒ **语句级报错也会让脚本非 0 退出**、
#    容器起不来。原 CMD 不带该参数时，重跑 0000 报 25 条、0001 报 47 条，退出码仍为 0
#    （已修复的旧行为）；现在被豁免的迁移若自动重跑会直接阻断启动，故继续留在
#    NEVER_AUTO_RUN 里（理由仍是「不该自动跑」）。
#    ⇒ 上面这些理由是「**不该自动跑**」，**不是**「会炸容器」；别拿「反正不炸」当登记它们的理由。
# 启动前先执行建表迁移（幂等）：mini 模块 + 站内消息/订阅授权/满意度回访 + 自动收益管家（price-robot 一期 4 表 + 二期 plans/targetDate）+ 素材库打卡体系 + value 列 + 自动化任务规则 + 幂等唯一索引 + 定价中心（daily_price/holidays/config 加列）+ 平台订单字段（0017）+ 文旅集章（0021 rally 档位/领取台账、0022 claims 核销门店列、0023 全局设计系统两表+既有表扩展）+ 场地与点位（0024 venues/venue_points 两表 + products 4 列 + nodes venue_point_id）+ 采风与生成（0025 venue_points photos 列、culture_materials 表、products ai_input 列）+ 采集人归属（0026 venue_points / culture_materials 各加 created_by 列，可空不回填）、素材生产（0027 asset_jobs 表 + design_assets.venue_id + nodes.narration_url + products 的 style_bible/style_anchor_url 两列）、铺码四态（0028 venue_points 六列 + nodes venue_point_id 索引）、游客端问题上报（0029 client_reports 表）；并补回此前遗漏的 0018/0019/0020 三个幂等迁移；并补登记遗漏的 0002/0030/0032 与新增 0034/0035/0036（0036 design_assets 加剧本级列 product_id + 索引 + 只补空的回填；0037 信标设备台账表（beacons 一表 + mac 唯一索引 + uuid/major/minor 组合唯一索引 + venue/point 两索引，纯 IF NOT EXISTS）；0038 design_assets 加坐标两列（target_kind/target_id + 索引 + 从 asset_jobs **一次性**回填，重跑整块跳过）；0039 场地网络调研（venue_research 一表 + venue_id 唯一索引 + 素材/点位各加 research_id 列，纯 IF NOT EXISTS、零回填）；0040 内容侧剧本成局形态（pms_bui_wenlv_products 加 play_mode 列，默认 solo，纯 ADD COLUMN IF NOT EXISTS、零回填）；wenlv-team-m1 内容侧团队准入（progress 加 session_id 列 + 旧整表唯一索引换两条部分唯一索引 + sessions 队伍表；纯 IF NOT EXISTS、零回填、含一条有意的 DROP INDEX IF EXISTS）；0041 内容侧免费剧本（pms_bui_wenlv_products 加 is_free 列默认 false、pms_bui_wenlv_progress 加 visit_count 列默认 0，纯 ADD COLUMN IF NOT EXISTS、零回填）；0031/0033 因回填非幂等**故意不登记**，理由见上面的 ⚠️）
CMD ["pnpm", "start"]
#
# ⚠️ **关于迁移清单（已移至 `docker-entrypoint.sh`）：它刻意不按数值升序，别「顺手排好」。**
#    · 数值段里只有一处逆序：`0007_price-robot-phase2.sql` 紧跟在 `0003_price-robot.sql` 之后，
#      而 `0004~0006`（素材库三块）反在它后面 —— **看着**是按主题分组（price-robot 两期贴在一起），
#      不像笔误；该处之后到 `0042_wenlv_characters.sql` 严格升序。
#    · 这不只是排版：**清单顺序 = 全新库上迁移的执行顺序** ⇒ 重排等于改生产全新库的落地次序，
#      收益却只是「好看」。真非动不可，**先证明这两组之间无依赖**。
#    · 📏 数值段须**严格升序**（除上面那处有意的逆序）。**别在这行写项数** ——
#      每加一条迁移它就过期一次，而下面那条仓库级闸（`drizzle-migration-registration.test.ts`）
#      已经在守「登记」这件事，不需要一个手写的数字再守一遍。
#      要数就现场数（在 pms-server/ 下，逐条列出 / 只数数值段）：
#        grep -v '^#' docker-entrypoint.sh | grep -o 'for f in [^;]*' | tr ' ' '\n' | grep '\.sql$'
#        grep -v '^#' docker-entrypoint.sh | grep -o 'for f in [^;]*' | tr ' ' '\n' | grep -cE '^[0-9]'
#      ⚠️ **别用「跑那条 vitest」来数**：它输出里最醒目的是**用例数**（不是清单项数），照它数会数错对象。
#         也**别指望读 `registeredMigrations()`** —— 那个函数**没有导出**，文件外面读不到。
#    · ⇒ **别为「升序」另加闸**：那要么逼你改执行顺序，要么写成「只准这一处例外」（等于没闸）。
#      重复项已由仓库级闸兜着 —— `it('CMD 清单里没有重复项')`，见
#      `src/db/schema/__tests__/drizzle-migration-registration.test.ts`（该闸读 docker-entrypoint.sh）。
#
# 📌 本注释**放在 CMD 之后**（而非上方规则块旁）是刻意的：该文件的 `:18-51` 行号被多份计划
#    与 `.sql` 头注引用（`Dockerfile:21`/`:48`/`:50`/`:51` 等），在上方插行会**把引用全部推漂**。
#    注释放末尾 ⇒ 前面行号逐字不变。**要补写本文件注释时请沿用同一位次。**

# 启动入口：docker-entrypoint.sh 先执行建表/迁移，成功后再 exec 上面的 CMD。
# 追加在本文件末尾是为了不打乱 `:18-51` 的既有行号引用（见上）。
COPY docker-entrypoint.sh /app/docker-entrypoint.sh
ENTRYPOINT ["sh", "/app/docker-entrypoint.sh"]
