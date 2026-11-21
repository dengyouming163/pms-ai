-- 素材 ↔ 剧本要素的「坐标系」（设计见
-- docs/superpowers/specs/2026-09-23-wenlv-asset-script-correspondence-design.md §4.1）。
--
-- 为什么把 target 抄到素材行，而不是每次去 join asset_jobs：
--   job 是「一次生成动作」的**一次性凭据、不是长期归属**，而素材要长期留着；
--   素材的**归属**不该依赖一次性的动作记录。同表已有的 product_id 就是这条路子
--   （迁移 0036：加可空列 + btree 索引 + 只补空的回填。那句「本列是查询的最终归属地」
--    写在 `src/db/schema/wenlv.ts` 的 productId 列注释里，**不在** 0036 的注释里），
--   本迁移与它同形，**差别是回填只做一次**（理由见下面那个 🔴）。
--
-- 为什么是两列而不是一个 slot：
--   槽位 ≡ design_assets.type。注册表 ASSET_TYPES[type].writeback 已经给出了
--   (entity, column, jsonKey)，再加 slot 是同一事实的第二份规格，必然漂移。
--
-- 为什么 kind 的取值域是那六个：
--   与 writeback-type.ts 的 WritebackEntity 一一对应
--   (node / product / collectible / ending / reward / tier)，也与 asset_jobs.target_kind
--   同宽同域。三者是同一个枚举的三处视图，勿各自扩展。
--
-- 🔴 **回填只做一次，绝不能写成「重跑就把差异收敛掉」。**（2026-09-23 订正。）
--    ⛔ **反例**（初稿是一条 `(a.target_kind, a.target_id) IS DISTINCT FROM (j.target_kind, j.target_id)`
--    的 UPDATE，**勿实现、勿照抄**）：那会**静默把已解绑的素材重新绑回已删除的要素**。
--
--    为什么：**删要素时会「有意解绑」** —— 把素材的 target 两列置 NULL（决策 2「解绑不删」），
--    而 job 行**不随要素删除**、它自己的 target 还在。于是「素材空 / job 有值」这一对
--    **既是「还没回填」也是「已被有意解绑」**；两种状态下素材行的 `job_id` 与两列 target
--    **长得一模一样**，所以**任何只看素材行的谓词都区分不了**，第二次跑都会把刚解绑的
--    素材重新绑回去 —— 「只补空」（`AND a.target_kind IS NULL`）**也不是解药**，同上。
--    实测语义：`(NULL,NULL) IS DISTINCT FROM ('collectible','C1')` = **true**。
--    本仓前例：`0031` 的非幂等回填把人类显式设的值静默盖掉（0036 头注记着这条）——
--    初稿复刻的正是它，而不是 0036 的「只补空」。
--    后果放大：本文件**登记在 Dockerfile 的 CMD 清单里**（容器每次启动重跑整份清单）⇒
--    写错就等于把「每次启动都批量制造一批指向死 id 的脏数据」变成例行公事。
--    ⚠️ 但这份清单**烘焙在镜像里**，而 pms-server 走**覆盖式部署（不重建镜像）** ⇒
--       **本次上线本文件不会自动跑，须手工 `psql -f` 一次**；「每次启动重跑」描述的是
--       **将来重建镜像之后**的状态（`Dockerfile:21`）。
--
--    做法：建列与回填放进**同一个 DO 块**，条件是「列还不存在」—— 那是「回填还没跑过」的
--    **唯一可靠标记**。于是：
--      首跑 = 建列 + 回填（同一个语句 = 同一个事务 ⇒ 不存在「列建好了但没回填」的中间态）；
--      重跑 = 整块跳过 ⇒ **已解绑的素材一行都不会被重新绑上**。
--    登记进启动清单仍然安全，但理由与 0036 **不同**：不是「收敛到同一终态」，而是「重跑什么都不做」。
--    🔴 **本文件依赖 0033 的产物，而 0033 故意不在清单里**：回填要读 `design_assets.job_id`
--       （`0033_wenlv_asset_studio.sql:83`）与 `asset_jobs.target_kind`（`0033:20-21`），
--       而 `0033` 只因回填非幂等被排除在启动清单之外 ⇒ **只用清单建出来的新库**跑本文件：
--       守护放行 → 两条 ADD COLUMN 成功 → UPDATE 报 42703 → **整个 DO 块原子回滚**（两列一并不建）
--       → 语句级报错、退出码仍 0、容器照起 ⇒ **静默**；而 schema 已声明这两列 ⇒
--       design_assets 的读接口整片 42703 → 500（与 `Dockerfile:20` 那条同形，成因不同）。
--       ⇒ 建新库的顺序是**先手工跑 0033、再跑本文件**。清单里**只有本文件**有这个性质
--       （2026-09-23 已扫**全清单 44 个文件**的**非注释行**：对 0033 的那 14 个产物列名**按整词
--         匹配**、零实际读取 —— 用子串匹配会多出 `0027` 的 `parent_job_id` 与 `0035` 的
--         `human_review_*` 这几处**假阳性**；`0034:22` / `0035:16` 只在注释里提及 `is_selected`）。
--    ⚠️ 要知情的副作用：若两列**已被别的途径先加上**（例如手工 ALTER），本块整体跳过、
--       回填**不会**执行。生产上本文件是唯一加这两列的地方，故不构成问题。
--    ⚠️ 反向的残余风险（与上一条同一个成因，也是它唯一现实的补救路径）：若有人**手工 DROP
--       掉这两列再跑本文件**，就等价于「从未回填」⇒ 那一刻**已解绑**的行会被按 job 重新绑上。
--       「列不存在」能标记「回填没跑过」，但**标记不出「这些行是被有意解绑的」**（同一行两种
--       含义不可区分，正是本迁移必须做成一次性的原因）⇒ 真要这么补救，只能接受重绑，
--       或事后把那批素材**再解绑一次**（按 (kind,id) 已经找不到它们，得靠人认）。
--    ⇒ **回滚 = 重发旧 build；不要 `DROP COLUMN`**（旧 schema 不声明这两列，库里留着**无害**；
--       而 `DROP` 之后的任何一次重跑都会让上面那条反向风险成真）。口径同 `0036:63-65`。
--    ⚠️ **只加了一列**时更隐蔽，两个方向都要知情（守护只探 `target_kind` 一列，这是它的边界）：
--      · 手工只加 `target_kind`、没加 `target_id` ⇒ 守护判「列已存在」⇒ 整块跳过 ⇒
--        `target_id` **永不创建**，而 schema 已声明它 ⇒ design_assets 的读接口整片 42703 报错；
--      · 手工只加 `target_id` ⇒ 守护判「列不存在」⇒ 走到 `ADD COLUMN target_kind` 后再
--        `ADD COLUMN target_id` 撞重名报错 ⇒ 整个 DO 块**原子回滚**（先加的 `target_kind`
--        也一并撤掉）；**紧随其后的建索引语句**也会因 `target_kind` 缺失报同因的错、索引同样不建，
--        于是同一份日志里是**两处**语句级报错；但 psql **不带 `ON_ERROR_STOP`** ⇒ 退出码仍 **0**、清单循环的
--        `|| exit 1` **不触发** ⇒ **容器照常起得来**，响亮只体现在日志里（与 Dockerfile
--        CMD 段那条 ⚠️ 的说明一致；2026-09-23 在本地容器实测：语句级报错 RC=0）。
--      · 守护与 `ALTER` 解析「哪张表」用的是**两条规则**：`current_schema()` 取 search_path 里第一个
--        **存在**的 schema，而不带前缀的 `ALTER` 取第一个**含该表**的 schema ⇒ 两者不一致时
--        （首 schema 存在但无本表，例如给连接用户建过同名 schema）守护判「列不存在」、`ALTER`
--        打到真表 ⇒ `42701` → 整块回滚 ⇒ **每次启动一条 ERROR、末尾那条「跳过」NOTICE 不再出现**
--        （数据无影响：裸 `ADD COLUMN` 兜住；紧随的建索引是 `IF NOT EXISTS`，列已存在时无害）。
--        2026-09-23 本地容器实测：`search_path = <空 schema>, public` 时守护谓词读 **0** 行、
--        而 `'pms_bui_wenlv_design_assets'::regclass` 指向真表、`ALTER` 报 `already exists`。
--        另一条同效起因：`information_schema.columns` 自带**权限滤网**（只列当前角色有权限的列）。
--
-- 幂等性的观测量也随之改变：**不是**「第二次跑 `UPDATE 0`」（对本实现恒真、零判别力），
-- 而是**重跑时那行 `[0038] … 跳过…` 的 NOTICE**。观测法（自包含）：
-- 自造一行「未回填」的夹具 → 跑一次（应被填上）→ 人为解绑它 → 再跑一次（必须一行都不改）。
-- ⚠️ **一个例外**：上面第三条 `·` 那个环境（search_path 首 schema 存在但无本表）里，重跑走的是
--    THEN 分支并在 `ALTER` 处报错 ⇒ 这条「跳过」NOTICE **不会打印** ⇒ 别据它的缺席判定
--    「没跳过 / 迁移没生效」—— 那时看 `information_schema` 里两列在不在才作数。
--
-- ⚠️ **回填覆盖不到的行有三类**，报数时必须一起数（只数第一类会漏掉本机全部 9 行）：
--    ① `job_id IS NULL`；
--    ② `job_id` 悬空、join 不上 `asset_jobs`（UPDATE 是 JOIN，这类行**根本不参与**）；
--    ③ join 上了、但那条 job 自己的 `target_kind IS NULL`（比完了没有可抄的值）。
--    这组数是**首跑之后**才有意义的读数，且它对解绑**不敏感**：
--    解绑只动素材行，那条 job 自己的 target 还在 ⇒ 解绑出来的行**不落进任何一类**
--    （它们恰恰是「再跑一次会被填上」的那批 —— 是守卫让重跑不再发生，不是它们补不回来）。
--    ⚠️ 会被解绑打歪的是**任何拿素材行与 job 比对的复核**，例如
--    `(a.target_kind, a.target_id) IS DISTINCT FROM (j.target_kind, j.target_id)`（⛔ **反例**，勿照抄）：
--    有意解绑过的行会**永久**读作「不一致」⇒ 那种查询在生产上不能当「跑干净了」的判据。
--    口径必须写全三类，否则读出的数会与事实相反（窄到 `job_id IS NULL` 时本机读数是 0）。
--
-- 🔴 **别把「本机 9/9 补不回来」当成生产结论**。本机这 9 行**不能当作真实业务流程的分布样本**
--    （5 行的 `id` = `wa-residue-exp-anchor-1..5`、`job_id` = `residue-exp-anchor-1..5`，
--     `name` 是「别人的残留锚N」—— ⚠️ 按 `name LIKE '%residue%'` 搜是 **0 命中**，
--     这 5 行的出处**只能从 `id`/`job_id` 看出来，别从名字认**）。
--    ⚠️ **但别把这读成「任何生产代码都没写过本机这 9 行」**：数据只能钉死「不是 `writeAsset`
--    产出」（9 行全是 `is_selected = t`，而 `writeAsset` 的 values 不写该列）；其余几行的形状
--    （`candidate_index=0` + 非空 `job_id` + id `wa-<jobId>`）**与 `writeCandidate` 的输出一致**，
--    分不出「夹具直接 INSERT」与「夹具驱动 `writeCandidate`」—— 两者都不算真实业务流程。
--    另：全库 216 条 job 里 211 条是 `bootstrapStyleBible` 直接 insert 的 `style_bible`
--    记账合成行（有意不写 target），9 行素材里 7 行 `job_id` 悬空。本机分布**推不出**
--    生产分布，三类各有多少是**上线后才知道的数**。
--    上面这几段出现的数字（9 / 216 / 211 / 0 / 7 / 5）都是 **2026-09-23 在本地 `pms-pg-sop` /
--    库 `aipms` 的一次性快照**，不是会自更新的读数 —— 本机跑测试、落夹具、跑**动到这两张表**的
--    迁移都**可能**让它们失真，引用前先复读。
--
-- 关于已拍板接受的那条「历史旁白行补不回来」：它指的**正是上面那个 ①**，不是 ③。
--    依据：`writeAsset` 的 `values` 顶层键**没有 `jobId`**（只有 `meta.jobId`，见
--    `src/services/wenlv-asset-gen-scheduler.ts:305-328` 的 values 对象、`:334` 的 INSERT）
--    ⇒ 该函数在 0038 之前产出的行 `job_id` **恒 NULL** ⇒ 落进 ①，
--    因而**不可能** join 得到 job（与 ③ 无关）。
--    ⚠️ 这一类**在本机一条都观察不到**（本机 `job_id IS NULL` 计数为 0）⇒ 决策 3 的真实规模
--    本机**无法观察**，生产上是多少**只能上线后数**。
--    🚫 **别把本机那两条 narration 素材行当成决策 3 的样本**：它们的 `job_id` 是**非空**的
--    (`wa-844bc754-…` / `wa-dd16535c-…`)、而对应 job 的 target 为 NULL ⇒ 属于 **③**。
--    它们看着像「历史旁白」，但产生路径不同（**不是** `writeAsset` 产出的）——
--    拿它们推决策 3 的规模会推出错的方向。
DO $$
DECLARE
  n integer;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM information_schema.columns
     WHERE table_schema = current_schema()
       AND table_name   = 'pms_bui_wenlv_design_assets'
       AND column_name  = 'target_kind'
  ) THEN
    -- ⛔ **故意写成裸 `ADD COLUMN`，别加 `IF NOT EXISTS`。** 它是守护失效时**唯一的中止机制**：
    --    重名报错 → 整个 DO 块原子回滚 → 一行都不写。补上就变成：若库里**只**手工加过 `target_id`
    --    （上面那条「只加 `target_id`」），守护照样放行、两条语句都过、**没有任何报错** ⇒
    --    不再有原子回滚，而 `UPDATE` 会**真的执行** ⇒ 把有意解绑的行重新绑上。⚠️ 清单里同族的
    --    幂等迁移**一律**写 `IF NOT EXISTS`（0033 14/14、0035 4/4、0036 1/1；0037 不加列，
    --    用的是 `CREATE TABLE IF NOT EXISTS`）—— `pms-server/drizzle/` 里唯一的裸 `ADD COLUMN`
    --    先例是 0001 那 38 处**建库基线**（正因不幂等才被排除在清单之外）⇒ **别顺手「统一」这里**。
    --    （口径只限本包：`platform-server/drizzle/` 那套是 drizzle-kit 生成的另一个包，有 11 处
    --      裸写，不适用 `pms-server/` 的约定。）
    ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN target_kind varchar(32);
    ALTER TABLE pms_bui_wenlv_design_assets ADD COLUMN target_id   varchar(64);

    -- 回填：从产出这一行的 job 抄一份。
    -- 进到这里就说明两列是本次刚建的、全为 NULL ⇒ 不需要「只补空」的谓词（那正是它的效果），
    -- 也不可能误伤任何行。`j.target_kind IS NOT NULL` 有**两重**作用：①让报出的行数 = 真正填上的
    -- 行数；②挡住 job 自己 `kind` 为空而 `id` 有值时**照抄出一条只有 id 的畸形素材行**。
    -- ⚠️ 反方向没有谓词：job 是 `kind` 有、`id` 空时，回填会写出 `(kind, NULL)`。这一侧才是
    --   设计文档 §7 说的「**半空**」（§7 风险表「两份副本漂移」行；原文：「半空」（`kind` 有、
    --   `id` 空）仍为红）—— 该词**只指这一侧**，上面 ② 那侧叫「只有 id」，别混用。半空是
    --   **靠约定不靠约束**的脏态 ⇒ 这类 job 存在时，本迁移会把它**原样复制**到素材行上。
    UPDATE pms_bui_wenlv_design_assets a
       SET target_kind = j.target_kind,
           target_id   = j.target_id
      FROM pms_bui_wenlv_asset_jobs j
     WHERE a.job_id = j.id
       AND j.target_kind IS NOT NULL;

    GET DIAGNOSTICS n = ROW_COUNT;
    RAISE NOTICE '[0038] 首跑：已建列，回填 % 行', n;
  ELSE
    -- 重跑的**正常**表现：什么都不做。这句 NOTICE 有两个用处：① 让「重跑跑得很安静」
    -- 不被读成「迁移没生效」；② 每次容器启动都在日志里留下这行。
    RAISE NOTICE '[0038] 两列已存在 ⇒ 跳过建列与回填（重跑的预期行为）';
  END IF;
END $$;

-- 解绑（后续按 (kind, id) 定位）与全景页（另一份计划）都按这一对查 ⇒ 值得一个索引。
CREATE INDEX IF NOT EXISTS idx_wenlv_design_assets_target
  ON pms_bui_wenlv_design_assets (target_kind, target_id);
