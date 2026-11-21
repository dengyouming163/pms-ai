import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';

/**
 * 「`drizzle/` 里有迁移、但没登记进 Dockerfile CMD」这件事必须变成不可能。
 *
 * ## 为什么需要这条测试
 * 生产唯一的**自动**迁移机制是 `docker-entrypoint.sh` 里那条手写的
 * `for f in … ; do psql … -f "drizzle/$f" || exit 1; done`
 * （`deploy.sh` 的兜底清单只到 `0017`，且只在 `./deploy.sh server` 那一支跑）。
 * 清单是**手写的**，所以「把 SQL 放进 `drizzle/` 就以为完事」会让新列**永远不建** ——
 * 而 schema 里已经声明了该列 ⇒ drizzle 整行 select 命中 42703 ⇒ 该模块读接口全 500。
 *
 * 这不是假想：`0030`–`0033` 四条**已经在生产应用**（手工 psql），但**长期漏登记**，
 * 直到 2026-09-20 才把其中可自动执行的（`0030`/`0032`）与新增的 `0034` 补进清单。
 *
 * ## 判据的语义（重要）
 * 断言「`drizzle/*.sql` 的**全集** ⊆ 已登记 ∪ 豁免」，且豁免项**必须自证不可自动执行**。
 * 不是「新增的都已登记」——「新增」测试无从判断；全集相等更强、也更难被绕过。
 *
 * ## ⚠️ 一个必须记住的前提：启动 psql **带** `ON_ERROR_STOP`
 * 所以**语句级报错也会让脚本非 0 退出**、容器起不来。
 * ⇒ 下面这些迁移「不该自动跑」的理由必须继续成立：幂等的就该登记；
 *   重跑会报错 / 会改写数据的，就留在 NEVER_AUTO_RUN 里。
 */

const DRIZZLE_DIR = new URL('../../../../drizzle/', import.meta.url);
const ENTRYPOINT = new URL('../../../../docker-entrypoint.sh', import.meta.url);

/**
 * 豁免：这些**不进启动清单**，缺它们**不是遗漏**。
 *
 * 两条是**建库基线引导脚本**（不可重复执行），两条是**DDL 幂等但回填非幂等**。
 * 四条的 `drizzle/` 产物在生产**都已存在**（手工执行过）⇒ 不登记不丢东西。
 */
const NEVER_AUTO_RUN: Record<string, string> = {
  '0000_next_steel_serpent.sql':
    '建库基线（25 处裸 CREATE TABLE）。重跑刷 25 条 ERROR 且不可能有收益，故只建库时执行一次',
  '0001_add_multi_tenant_fields.sql':
    '建库基线。招牌危害是 :88 会 DROP `pms_bui_staff.stores`（**不可逆**；生产该列是活的 —— ' +
    '`merchant_id` 与 `stores` 两列同时存在 ⇒ 0001 从未在生产执行过，一旦登记则每次启动都删掉它）。' +
    '另 38 处裸 ADD COLUMN 会刷 ERROR；两处 `UPDATE … WHERE store_id IS NULL` 因紧随其后的 ' +
    'SET NOT NULL 恒影响 0 行，**是 no-op，不是危害**',
  '0031_wenlv_ending_priority.sql':
    'DDL 幂等、回填非幂等：会把 priority = 0 的行重排成 1..k。而 0 是人类能显式设的合法值' +
    '（ending-form.tsx:58 `Number(d.priority) || 0`、wenlv.ts:1262 `… ? body.priority : 0`）' +
    '⇒ 重跑会把作者「设 0 = 平手必输」的结局静默提升，启动即可能改变游客实际拿到的结局',
  '0033_wenlv_asset_studio.sql':
    'DDL 幂等、is_selected 回填非幂等：用户改选过后重跑撞部分唯一索引 ' +
    'uq_wenlv_design_assets_selected 报 unique violation，整条 UPDATE 原子回滚 ⇒ 回填静默 no-op。' +
    '文件自己也写着「只可执行一次」「须手工在生产执行」',
  '0065_wenlv_nodes_refactor.sql':
    'RENAME COLUMN 非幂等（重跑报 column does not exist）；DROP COLUMN IF EXISTS 虽幂等但与 RENAME 同文件 ⇒ 整体只可执行一次',
  '0066_wenlv_products_config.sql':
    'ADD COLUMN IF NOT EXISTS 幂等，但 UPDATE 去 config 内冗余键非幂等（重跑无副作用但无意义）；整体只在 schema 切换时执行一次',
  '0067_wenlv_drop_storylines.sql':
    'DROP TABLE IF EXISTS 技术上幂等，但语义上是一次性删表（storylines 表已废弃），容器每次启动都跑无意义且危险',
  '0074_wenlv_nodes_binary_type.sql':
    'UPDATE 回填一次性：把 puzzle/choice/npc/ending 历史行（legacy_node_type 带 v1: 影子前缀）' +
    '一律收敛为 scene；二元化上线后新生行 legacy 默认「scene」无前缀，重跑虽不命中落平子句，' +
    '但影子回填在脏环境仍可能改写合法值，故只允许上线窗口手工执行一次。' +
    '同文件另含 DROP COLUMN IF EXISTS driver_type 与 CHECK 重建（语句本身幂等，但与一次性回填同文件），须手工 psql 执行一次',
};

/** 从 docker-entrypoint.sh 的启动清单里解析出迁移清单。 */
function registeredMigrations(): string[] {
  const df = readFileSync(ENTRYPOINT, 'utf-8');
  const m = df.match(/for f in ([^;]*); do\b/);
  if (!m) {
    throw new Error(
      'docker-entrypoint.sh 里找不到 `for f in … ; do` 迁移清单 —— 本测试的**前提**失效了。' +
        '请先修测试（或修入口脚本），不要直接放行：本测试的价值正来自它盯着那份清单。',
    );
  }
  return m[1].split(/\s+/).filter(Boolean);
}

function drizzleMigrationFiles(): string[] {
  return readdirSync(DRIZZLE_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort();
}

/**
 * 读 `drizzle/` 下的 .sql，**行尾一律归一到 LF**。
 *
 * 🔴 **为什么归一在「读」这一层，而不是在 `stripComments` 里补一句 `replace(/\r/g,'')`**：
 * `stripComments` 的契约是「去注释」，往里塞 EOL 处理是**职责外溢**；而这里的主语是
 * 「拿到的产物应被当成什么形态」—— blob 里存的就是 LF（下面有实测），归一之后，
 * 下游**任何** `$` 锚定 / 空白敏感的判据都不会再按 checkout 结果改口径。
 *
 * 🔴 **这是必须的，不是洁癖**：本仓 `core.autocrlf=true` 且**无 `.gitattributes`**
 * ⇒ 同一个 `.sql`，blob 是 LF、checkout 到工作树可能变 CRLF，且**逐文件不同**。
 * 🔴 **这里刻意不写「N 个 .sql 里 M 个是 CRLF」这类计数**：写下时是 52/9/43，
 *    同日下午加了 `0042` 就变成 53/9/44 ⇒ 计数会被写下它的文本自己改变。
 *    要数就**当场用字节权威命令**（宿主上跑，`drizzle/` 下）：
 *      `for f in drizzle/*.sql; do c=$(tr -dc '\r' < "$f" | wc -c); [ "$c" -gt 0 ] && echo "$f"; done | wc -l`
 *      `ls drizzle/*.sql | wc -l`
 *    ⚠️ **别用 `awk '/\r$/'` 或 `grep -c $'\r$'`** —— 本机实测**恒报 0**（坏量具）。
 *    ⚠️ **别用 `git ls-files` 枚举** ⇒ 未跟踪的 `.sql` 结构性不可见。
 * 而 `stripComments` 的 `.replace(/--.*$/, '')` 不带 `m` ⇒ `$` **不匹配 `\r` 前的位置**、
 * `.` 也不吃 `\r` ⇒ **行尾带 CR 的注释整条剥不掉**，注释里的
 * `ADD COLUMN` / `CREATE INDEX` / 列名会被当成真语句计入 ⇒ **假红**。
 *
 * ⚠️ **别改成 `git show HEAD:` 去读 blob**：TDD 期间新迁移文件是**未跟踪**的，blob 里还不存在。
 */
function readSql(name: string): string {
  return readFileSync(new URL(name, DRIZZLE_DIR), 'utf-8').replace(/\r\n/g, '\n');
}

/**
 * 去掉注释，避免「注释里提到 UPDATE / DROP」把判据喂饱（假绿）。
 *
 * 🔴 **只剥「整行 `--`」是不够的**（2026-09-25 实测，同族见
 * `wenlv-play-mode.columns.test.ts:27-33`，那里的剥法已按本条改写）：
 *   · **行尾** `--` 注释：`SELECT 1; -- 本文件重跑会 DROP COLUMN x` ⇒ 仍绿
 *   · **块注释** `/* … *​/`：同上 ⇒ 仍绿
 * 两者都能留下 `DROP COLUMN` / `UPDATE …` 这类字样。**判据方向要认清**：本文件里
 * 「多认出一个危害词（`hasRerunHazard` 假 true）」才会放行一条**其实幂等**的豁免 ——
 * 是**假绿**；「少认」则是假红（会有人来看）。所以这两条路径必须堵。
 * ⚠️ 副作用：SQL 的**字符串字面量**里出现 `--` 或 `/* *​/` 会被误剥 ⇒ 假红。
 *    假红比假绿安全；真出现时正解是**结构式抽取**（先 `match` 出语句再逐字比），
 *    别再往「剥注释」上打补丁。
 */
function stripComments(sql: string): string {
  return sql
    .replace(/\/\*[\s\S]*?\*\//g, ' ') // 块注释（可跨行）→ 先剥
    .split('\n')
    .map((l) => l.replace(/--.*$/, '')) // 行尾/整行注释 → 再剥
    .join('\n');
}

/**
 * 该文件是否含「自动重跑**不安全**」的语句。三类：
 *   ① 重跑会**报错**：裸 CREATE TABLE / ADD COLUMN / CREATE INDEX（无 IF NOT EXISTS）
 *   ② 重跑会**静默改写状态**：裸 UPDATE / INSERT INTO / DELETE FROM
 *   ③ 重跑会**不可逆地删东西**：DROP TABLE / DROP COLUMN / DROP INDEX
 *
 * ⚠️ ③ 这一条是本判据**最要紧**的一维，别当成冗余删掉（前科：`0001` 的豁免理由一度只写
 * 「裸 ADD COLUMN + 改数据的 UPDATE」，而它真正的招牌危害是 `:88 ALTER TABLE "pms_bui_staff"
 * DROP COLUMN "stores";` —— 那条 DROP 没被任何维度覆盖。失效形态非常隐蔽：若有人把 `0001`
 * 的 ADD COLUMN 都补上 `IF NOT EXISTS`（一次看似纯净化的重构）而 DROP 原样留着，
 * 本用例会**变红并主动劝人把 `0001` 登记进启动清单** —— 也就是把「每次容器启动删掉
 * `pms_bui_staff.stores`」这条路径装回去。**判据主动劝人做危险动作，比判据缺失更坏。**
 *
 * ③ 这一维经**变异实验**证明确实承重（2026-09-20，`D:/tmp/t10/mutate_judge.js`）：
 *   把 `0001` 的 ADD COLUMN / CREATE TABLE / CREATE UNIQUE INDEX 全补上 `IF NOT EXISTS`
 *   并删掉两处 `UPDATE`（**只留那条 DROP**），
 *     · 旧判据（无 ③）⇒ **RED**，失败消息正是「它就**可以也应该**登记进 CMD，
 *       请把它从 NEVER_AUTO_RUN 删掉」（`mut_E2.txt`）
 *     · 新判据（有 ③）⇒ green（`mut_A2.txt`，剩余危害类别恰为 `[DROP]`）
 *   而对同一文件**只做**「删掉 DROP、其余全裸」的变异仍为 green（`mut_B.txt`）——
 *   所以 ③ 既非冗余，也不是「恒红」。
 */
function hasRerunHazard(sql: string): boolean {
  return hazardClasses(sql).length > 0;
}

/**
 * 列出该文件命中了哪几类危害。**判据的唯一实现**（`hasRerunHazard` 由它派生），
 * 分类文本同时用于失败消息与变异实验归因 —— 别在别处再抄一份正则，抄了就会漂移。
 */
function hazardClasses(sql: string): string[] {
  const s = stripComments(sql);
  const out: string[] = [];
  if (/CREATE TABLE(?! IF NOT EXISTS)/.test(s)) out.push('bare CREATE TABLE');
  if (/ADD COLUMN(?! IF NOT EXISTS)/.test(s)) out.push('bare ADD COLUMN');
  if (/CREATE (?:UNIQUE )?INDEX(?! IF NOT EXISTS)/.test(s)) out.push('bare CREATE INDEX');
  if (/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i.test(s)) out.push('DROP');
  if (/\bUPDATE\s+\w/i.test(s)) out.push('UPDATE');
  if (/\bINSERT\s+INTO\b/i.test(s)) out.push('INSERT INTO');
  if (/\bDELETE\s+FROM\b/i.test(s)) out.push('DELETE FROM');
  return out;
}

describe('drizzle 迁移 ↔ Dockerfile CMD 登记一致性', () => {
  it('CMD 迁移清单可解析，且非空、都以 .sql 结尾', () => {
    const list = registeredMigrations();
    expect(list.length).toBeGreaterThan(0);
    for (const f of list) expect(f).toMatch(/\.sql$/);
  });

  it('CMD 用 drizzle/$f 取文件（本测试假定迁移都在 drizzle/ 下）', () => {
    expect(readFileSync(ENTRYPOINT, 'utf-8')).toContain('-f "drizzle/$f"');
  });

  it('drizzle/ 下每个迁移都已登记进 CMD，或落在豁免表里', () => {
    const registered = new Set(registeredMigrations());
    const unregistered = drizzleMigrationFiles().filter(
      (f) => !registered.has(f) && !(f in NEVER_AUTO_RUN),
    );
    expect(
      unregistered,
      `以下迁移存在于 drizzle/ 但没登记进 docker-entrypoint.sh 的启动清单：\n  ${unregistered.join('\n  ')}\n` +
        '⇒ 它们**永远不会自动执行**。若恰好含建表/加列，schema 已声明而库里没有 ⇒ 42703 ⇒ 读接口全 500。\n' +
        '修法：把文件名追加到 docker-entrypoint.sh 清单末尾（**仅幂等 SQL 可登记**）；' +
        '若确实不可自动重跑，则加进本文件的 NEVER_AUTO_RUN 并写明理由。',
    ).toEqual([]);
  });

  it('豁免表里的每一项都确实存在', () => {
    const files = new Set(drizzleMigrationFiles());
    for (const name of Object.keys(NEVER_AUTO_RUN)) {
      expect(files.has(name), `豁免表里的 ${name} 在 drizzle/ 下不存在`).toBe(true);
    }
  });

  it('豁免项必须自证「自动重跑不安全」（防「恰好通过」的豁免）', () => {
    for (const name of Object.keys(NEVER_AUTO_RUN)) {
      const sql = readSql(name);
      expect(
        hasRerunHazard(sql),
        `${name} 被豁免的理由是「自动重跑不安全」，但（去掉注释后）它的内容里找不到任何` +
          '会重跑报错或静默改写状态的语句。若它其实幂等 ⇒ 它就**可以也应该**登记进 CMD，' +
          '请把它从 NEVER_AUTO_RUN 删掉。',
      ).toBe(true);
    }
  });

  it('CMD 清单里每一项在 drizzle/ 下都有对应文件（防登记幽灵文件）', () => {
    const files = new Set(drizzleMigrationFiles());
    const ghosts = registeredMigrations().filter((f) => !files.has(f));
    expect(
      ghosts,
      `CMD 登记了不存在的迁移文件：\n  ${ghosts.join('\n  ')}\n` +
        '⇒ psql 报「could not open file」（**致命错**）⇒ `|| exit 1` ⇒ 服务起不来。',
    ).toEqual([]);
  });

  it('CMD 清单里没有重复项', () => {
    const list = registeredMigrations();
    const dup = list.filter((f, i) => list.indexOf(f) !== i);
    expect(dup, `CMD 清单里重复登记：${[...new Set(dup)].join(', ')}`).toEqual([]);
  });

  it('启动 psql 带 ON_ERROR_STOP —— 语句级错误必须让容器启动失败', () => {
    const df = readFileSync(ENTRYPOINT, 'utf-8');
    expect(
      df,
      '入口脚本里的 psql 必须带 `-v ON_ERROR_STOP=1`：否则裸 CREATE TABLE / ADD COLUMN 等语句级错误' +
        '只会刷 ERROR，容器照常启动，schema 与数据库静默漂移。',
    ).toContain('-v ON_ERROR_STOP=1');
  });
});

describe('0034_wenlv_products_venue_idx 迁移（products.venue_id 索引）', () => {
  const FILE = '0034_wenlv_products_venue_idx.sql';

  it('已登记进 CMD 清单', () => {
    expect(registeredMigrations()).toContain(FILE);
  });

  it('SQL 建的是 venue_id 上的索引，且带 IF NOT EXISTS（幂等）', () => {
    // 🔴 压平 + 剥注释 + **整条含分号**（照下面 `wenlv-team-m1` 那个 describe 的范式）。
    //    原写法是两条 `toContain`，都跑在**原文**上、且都以「片段」结尾 ⇒ 2026-09-29 变异 A 实测零信号：
    //    把索引名改成 `idx_wenlv_products_venue_v2` ⇒ **18/18 全绿**（`ON …(venue_id)` 那半也照样绿）。
    //    同族见本文件 0042 那段的表名 / 主键两条。
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    expect(t, '0034 缺整条 CREATE INDEX 子句（索引名被改 / 追加 WHERE / 少 IF NOT EXISTS 都在这里红）').toContain(
      'CREATE INDEX IF NOT EXISTS idx_wenlv_products_venue ON pms_bui_wenlv_products(venue_id);',
    );
  });

  it('是纯幂等的（无回填/UPDATE/INSERT 等只有第一次能跑对的语句）', () => {
    const sql = readSql(FILE);
    const hazards = hazardClasses(sql);
    expect(hazards, `${FILE} 应当纯幂等，却命中了危害类别：${hazards.join(', ')}`).toEqual([]);
  });
});

describe('wenlv-team-m1 迁移（progress 通道列 + 两条部分唯一索引 + sessions 表）', () => {
  const FILE = 'wenlv-team-m1.sql';

  it('已登记进 CMD 清单', () => {
    expect(registeredMigrations()).toContain(FILE);
  });

  it('SQL 的子句（整条、含次序与结尾分号）', () => {
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    expect(t).toContain('ALTER TABLE pms_bui_wenlv_progress ADD COLUMN IF NOT EXISTS session_id varchar(50);');
    expect(t).toContain(
      'DROP INDEX IF EXISTS uq_wenlv_progress_user_product; CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_solo ON pms_bui_wenlv_progress (mini_user_id, product_id) WHERE session_id IS NULL;',
    );
    expect(t).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_team ON pms_bui_wenlv_progress (mini_user_id, product_id, session_id) WHERE session_id IS NOT NULL;',
    );
    expect(t).toContain('CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_sessions_code ON pms_bui_wenlv_sessions (code);');
  });

  it('危害类别**恰为** [DROP]：那一条 DROP 是有意的，且必须带 IF EXISTS', () => {
    const sql = readSql(FILE);
    const hazards = hazardClasses(sql);
    expect(
      hazards,
      `${FILE} 命中了预期外的危害类别：${hazards.join(', ')}。\n` +
        '本文件**应该**只命中 DROP（那条有意 DROP INDEX IF EXISTS，见文件头注）。\n' +
        '🛑 别把期望值改成实际值来放行 —— 先弄清多出来的那一类是什么：\n' +
        '  · bare ADD COLUMN / CREATE INDEX / CREATE TABLE ⇒ 你漏了 IF NOT EXISTS（重跑会刷 ERROR，而 CMD 的 psql 不带 ON_ERROR_STOP ⇒ **静默**）\n' +
        '  · UPDATE / INSERT INTO / DELETE FROM ⇒ 文件里出现了**回填**，那它就不该进启动清单',
    ).toEqual(['DROP']);
    // DROP 必须可重入：裸 DROP INDEX 在第二次启动时静默失败
    expect(stripComments(sql)).toContain('DROP INDEX IF EXISTS uq_wenlv_progress_user_product');
  });
});

describe('0042_wenlv_characters 迁移（剧本角色表）', () => {
  const FILE = '0042_wenlv_characters.sql';

  it('已登记进 CMD 清单', () => {
    expect(registeredMigrations()).toContain(FILE);
  });

  it('建的是角色表，且列齐备（逐列点名，含主键）', () => {
    // ⚠️ 这里**必须**剥注释：本文件的头注里**真的**含列名/表名字样 —— 实测 0042 里
    //    `vitality` 出现 2 行（注释 :19 + 真列 :38），`faction`/`identity`/`role` 同为 2 行
    //    ⇒ 跑在原文上时注释能喂饱下面的 `toContain`。别让这里依赖「注释里恰好没有那个词」这个巧合。
    const sql = stripComments(readSql(FILE));
    // 🔴 表名后必须紧跟 `(`：原写法不带到此为止的边界 ⇒ 2026-09-29 变异 C 实测
    //    把表名改成 `pms_bui_wenlv_characters_old` 后 **18/18 全绿**（前缀子串 ⇒ 零信号）。
    expect(sql, '0042 没建 `pms_bui_wenlv_characters` 这张表（表名被改后缀也会在这里红）').toMatch(
      /CREATE TABLE IF NOT EXISTS pms_bui_wenlv_characters\s*\(/,
    );
    // 逐列点名：漏一列的症状是「该字段静默永远是 null / 42703」，
    // 而 42703 只在真正 select 到那一列时才炸 —— 建表阶段看不出来。
    // ⚠️ `id` **刻意不在这张清单里** —— 见下面那条独立的主键断言及其理由。
    // ⚠️ 这 17 条是**名字存在性**判据，不覆盖类型 / 非空（那一半归下面的逐项相等与
    //    `wenlv-characters.columns.test.ts` 的 18 条子句针）；而它们只有在**剥注释**的文本上
    //    才真正盯着建表语句 —— 原文里注释含 `vitality`/`product_id` 等字样，能喂饱它们。
    for (const col of [
      'product_id', '"order"', 'name', 'faction', 'faction_color', 'identity', 'identity_desc',
      'role', 'avatar_url', 'ip_prompt', 'vitality', 'wisdom', 'insight', 'skills', 'hidden_quest',
      'created_at', 'updated_at',
    ]) {
      expect(sql, `0042 里缺列 ${col}`).toContain(col);
    }
    // 🔴 **主键必须单独断言，且不能靠往上面那张清单里追加 `'id'` 来修**：
    //    `toContain('id')` 会命中 `product_id` / `identity` 里的子串 ⇒ **零判别力的空断言**。
    //    实测（2026-09-29 规格审查）：把整行 `id varchar(50) PRIMARY KEY,` 删掉，
    //    上面那张列清单**全绿** ⇒ 这个 describe 块曾**完全不覆盖主键**。
    //    `\b` 的判别力：`product_id` 里那个 `id` 的前邻是 `_`（词字符）⇒ 无边界 ⇒ 不命中。
    expect(sql, '0042 缺主键列 id（varchar(50) PRIMARY KEY）').toMatch(
      // 🔴 必须带行尾终结符 `(?=\s*[,)])`：原写法是前缀子串 ⇒ 2026-09-29 变异 D 实测
      //    给主键子句追加 ` DEFAULT 'unknown'` 后 **18/18 全绿**（零信号）。
      //    形状与 `wenlv-characters.columns.test.ts` 那 18 条子句针逐字同形。
      /\bid\s+varchar\(50\)\s+PRIMARY KEY(?=\s*[,)])/,
    );
    // 🔴 **结构判据：`CREATE TABLE` 体内的列名「逐项相等」**，不是「包含」。
    //    形状照抄本仓强形态 `wenlv-team-admission.columns.test.ts:211-237`
    //    （记忆：**照抄先例只可照抄形状**；那里实测过 M3 —— 复制一行列定义 ⇒ 所有
    //    `toContain` 全绿，而 PG 报 42701 `column … specified more than once`，
    //    **整张表根本建不出来**）。上面那批 `toContain` 结构性看不见的还有：
    //    **重复列**、**多一列**、**顺序错**（本表 `"order"` 列名与 SQL 关键字撞名也要保住引号）。
    //    ⇒ 与上面那条主键子句断言**互补、不重复**：这条钉**列名的集合**，
    //       那条钉**主键子句的存在**（列名对 ≠ 主键还在）。
    const stripped = stripComments(readSql(FILE));
    const createTableStmts = stripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^CREATE TABLE\b/i.test(s));
    expect(createTableStmts, '0042 的 CREATE TABLE 语句应当恰好一条').toHaveLength(1);
    const stmt = createTableStmts[0];
    const body = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
    const defs = body
      .split(',')
      .map((d) => d.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(defs, '0042 的列名必须逐项相等（重复列 ⇒ PG 42701，整张表建不出来）').toEqual([
      'id', 'product_id', '"order"', 'name', 'faction', 'faction_color', 'identity',
      'identity_desc', 'role', 'avatar_url', 'ip_prompt', 'vitality', 'wisdom', 'insight',
      'skills', 'hidden_quest', 'created_at', 'updated_at',
    ]);
  });

  it('三个属性列**刻意不带 DEFAULT** —— 它们是必填语义（改了这条要同步改迁移头注）', () => {
    const sql = stripComments(readSql(FILE));
    for (const col of ['vitality', 'wisdom', 'insight']) {
      expect(sql, `${col} 不该有 DEFAULT`).toMatch(new RegExp(`${col}\\s+integer\\s+NOT NULL(?!\\s+DEFAULT)`, 'i'));
    }
  });

  it('是纯幂等的（无回填 / UPDATE / INSERT 等只有第一次能跑对的语句）', () => {
    const sql = readSql(FILE);
    const hazards = hazardClasses(sql);
    expect(hazards, `${FILE} 应当纯幂等，却命中了危害类别：${hazards.join(', ')}`).toEqual([]);
  });
});

describe('0043_wenlv_npcs 迁移（剧本 NPC 表）', () => {
  const FILE = '0043_wenlv_npcs.sql';

  it('已登记进 CMD 清单', () => {
    expect(registeredMigrations()).toContain(FILE);
  });

  it('建的是 NPC 表，且列齐备（逐列点名，含主键）', () => {
    // ⚠️ 这里**必须**剥注释：本文件头注里**真的**含列名/表名字样 —— 实测 0043 里
    //    `character_id`、`portrait_url`、`voice_id`、`lines` 等都在头注出现，跑在原文上时
    //    注释能喂饱下面的 `toContain`。别让这里依赖「注释里恰好没有那个词」这个巧合。
    //    同族见本文件 0042 那段的完整推导。
    const sql = stripComments(readSql(FILE));
    // 🔴 表名后必须紧跟 `(`：前缀子串 ⇒ 把表名改成 `pms_bui_wenlv_npcs_old` 后零信号。同族见 0042。
    expect(sql, '0043 没建 `pms_bui_wenlv_npcs` 这张表（表名被改后缀也会在这里红）').toMatch(
      /CREATE TABLE IF NOT EXISTS pms_bui_wenlv_npcs\s*\(/,
    );
    // 逐列点名：漏一列的症状是「该字段静默永远是 null / 42703」，而 42703 只在真正 select 到那一列时才炸。
    // ⚠️ `id` **刻意不在这张清单里** —— 见下面那条独立的主键断言及其理由。
    // ⚠️ 这 12 条是**名字存在性**判据，不覆盖类型 / 非空（那一半归下面的逐项相等）。
    for (const col of [
      'product_id', '"order"', 'name', 'character_id', 'portrait_url', 'portrait_prompt',
      'voice_id', 'description', 'role', 'lines', 'created_at', 'updated_at',
    ]) {
      expect(sql, `0043 里缺列 ${col}`).toContain(col);
    }
    // 🔴 **主键必须单独断言，且不能靠往上面那张清单里追加 `'id'` 来修**：
    //    `toContain('id')` 会命中 `product_id` / `character_id` 里的子串 ⇒ **零判别力的空断言**。
    //    `\b` 的判别力：`product_id` 里那个 `id` 的前邻是 `_`（词字符）⇒ 无边界 ⇒ 不命中。
    //    必须带行尾终结符 `(?=\s*[,)])`：原写法是前缀子串 ⇒ 给主键子句追加 ` DEFAULT 'unknown'` 后零信号。
    //    形状与 0042 那条逐字同形。
    expect(sql, '0043 缺主键列 id（varchar(50) PRIMARY KEY）').toMatch(
      /\bid\s+varchar\(50\)\s+PRIMARY KEY(?=\s*[,)])/,
    );
    // 🔴 **结构判据：`CREATE TABLE` 体内的列名「逐项相等」**，不是「包含」。
    //    形状照抄 0042 那条（同族先例：复制一行列定义 ⇒ 所有 `toContain` 全绿，而 PG 报 42701
    //    `column … specified more than once`，**整张表根本建不出来**）。上面那批 `toContain`
    //    结构性看不见的还有：**重复列**、**多一列**、**顺序错**（本表 `"order"` 列名与 SQL 关键字
    //    撞名也要保住引号）。
    //    ⇒ 与上面那条主键子句断言**互补、不重复**：这条钉**列名的集合**，
    //       那条钉**主键子句的存在**（列名对 ≠ 主键还在）。
    const stripped = stripComments(readSql(FILE));
    const createTableStmts = stripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^CREATE TABLE\b/i.test(s));
    expect(createTableStmts, '0043 的 CREATE TABLE 语句应当恰好一条').toHaveLength(1);
    const stmt = createTableStmts[0];
    const body = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
    const defs = body
      .split(',')
      .map((d) => d.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(defs, '0043 的列名必须逐项相等（重复列 ⇒ PG 42701，整张表建不出来）').toEqual([
      'id', 'product_id', '"order"', 'name', 'character_id', 'portrait_url', 'portrait_prompt',
      'voice_id', 'description', 'role', 'lines', 'created_at', 'updated_at',
    ]);
  });

  it('是纯幂等的（无回填 / UPDATE / INSERT 等只有第一次能跑对的语句）', () => {
    const sql = readSql(FILE);
    const hazards = hazardClasses(sql);
    expect(hazards, `${FILE} 应当纯幂等，却命中了危害类别：${hazards.join(', ')}`).toEqual([]);
  });
});

describe('0044_wenlv_nodes_npc 迁移（节点 NPC 出场列）', () => {
  const FILE = '0044_wenlv_nodes_npc.sql';

  it('已登记进 CMD 清单', () => {
    expect(registeredMigrations()).toContain(FILE);
  });

  it('为 pms_bui_wenlv_nodes 加两列 + 一条 npc_id 索引（整条、含次序与结尾分号）', () => {
    // ⚠️ 这里**必须**剥注释 + 压平 + 整条含分号（同 0034/0042 那条范式）——
    //    原写法若用 `toContain` 跑在原文上，索引名被改成 `idx_wenlv_nodes_npc_v2`
    //    ⇒ 零信号；分号结尾的整条断言才能盯住「索引名 + 表名 + 列名」三元组。
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    expect(t, '0044 缺 ADD COLUMN npc_id 整条').toContain(
      'ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS npc_id varchar(50);',
    );
    expect(t, '0044 缺 ADD COLUMN npc_line_ids 整条').toContain(
      "ALTER TABLE pms_bui_wenlv_nodes ADD COLUMN IF NOT EXISTS npc_line_ids jsonb NOT NULL DEFAULT '[]'::jsonb;",
    );
    expect(t, '0044 缺 npc_id 索引整条').toContain(
      'CREATE INDEX IF NOT EXISTS idx_wenlv_nodes_npc_id ON pms_bui_wenlv_nodes (npc_id);',
    );
  });

  it('是纯幂等的（两条 ADD COLUMN IF NOT EXISTS + 一条 CREATE INDEX IF NOT EXISTS，无回填）', () => {
    const sql = readSql(FILE);
    const hazards = hazardClasses(sql);
    expect(hazards, `${FILE} 应当纯幂等，却命中了危害类别：${hazards.join(', ')}`).toEqual([]);
  });
});

describe('0079_wenlv_unified_rebuild 迁移（剧本房中心模型全量对等扩表）', () => {
  const FILE = '0079_wenlv_unified_rebuild.sql';

  it('已登记进 CMD 清单', () => {
    expect(registeredMigrations()).toContain(FILE);
  });

  it('scenes 补齐旧 nodes 对等玩法列 + 结局承载列（逐整条，含类型/非空/默认）', () => {
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    for (const stmt of [
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS venue_point_id varchar(50);',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS requires jsonb;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS geo jsonb;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS map_x integer;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS map_y integer;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS image varchar(500);',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS narration_url varchar(500);',
      "ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '[]'::jsonb;",
      "ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS npc_line_ids jsonb NOT NULL DEFAULT '[]'::jsonb;",
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS opening_line text;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS chapter_goal jsonb;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS perspective_character_id varchar(50);',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS san_delta integer NOT NULL DEFAULT 0;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ar_asset_url varchar(500);',
      "ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ar_asset_urls jsonb NOT NULL DEFAULT '{}'::jsonb;",
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ar_dialogue text;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS trigger_condition jsonb;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS priority integer NOT NULL DEFAULT 0;',
      'ALTER TABLE pms_bui_wenlv_scenes ADD COLUMN IF NOT EXISTS reward_id varchar(50);',
    ]) {
      expect(t, `0079 缺 scenes 列整条：${stmt}`).toContain(stmt);
    }
  });

  it('flows：condition 由 text 升级 jsonb 用 DO 块按列类型守护（裸 ALTER 在 jsonb 列重跑会报错）', () => {
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    expect(t, '缺 information_schema 列类型守护（第二次跑时列已 jsonb ⇒ 必须整块跳过）').toContain(
      "AND data_type <> 'jsonb'",
    );
    expect(t).toContain('ALTER TABLE pms_bui_wenlv_flows ALTER COLUMN condition TYPE jsonb');
    for (const stmt of [
      "ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS grants jsonb NOT NULL DEFAULT '[]'::jsonb;",
      'ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS san_delta integer NOT NULL DEFAULT 0;',
      'ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS sort_order integer NOT NULL DEFAULT 0;',
      'ALTER TABLE pms_bui_wenlv_flows ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();',
    ]) {
      expect(t, `0079 缺 flows 列整条：${stmt}`).toContain(stmt);
    }
  });

  it('chapters.ai_generated / triggers.scene_id / merchant_partners.script_room_id 整条就位', () => {
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    expect(t).toContain(
      'ALTER TABLE pms_bui_wenlv_chapters ADD COLUMN IF NOT EXISTS ai_generated boolean NOT NULL DEFAULT false;',
    );
    expect(t).toContain('ALTER TABLE pms_bui_wenlv_triggers ADD COLUMN IF NOT EXISTS scene_id varchar(50);');
    expect(t).toContain(
      'ALTER TABLE pms_bui_wenlv_merchant_partners ADD COLUMN IF NOT EXISTS script_room_id varchar(50);',
    );
  });

  it('content_id 唯一约束的 DO 块同时吞 duplicate_object 与 duplicate_table（生产空库两次连跑踩中 42P07）', () => {
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    expect(t).toContain('ADD CONSTRAINT uq_wenlv_script_rooms_content UNIQUE (content_id)');
    // 只写 duplicate_object（照抄 m7 的 CHECK 范式）对 UNIQUE 约束无效：它自动建同名索引，
    // 第二次 ADD 报 42P07 duplicate_table（relation already exists）⇒ 必须两者并列。
    expect(t, 'UNIQUE 约束幂等必须同时捕获 duplicate_table，否则容器第二次启动刷 ERROR').toContain(
      'WHEN duplicate_object OR duplicate_table THEN NULL',
    );
  });

  it('新建且仅新建 ai_sessions 一张表，且列名逐项相等（重复列 ⇒ PG 42701）', () => {
    const stripped = stripComments(readSql(FILE));
    const createTableStmts = stripped
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^CREATE TABLE\b/i.test(s));
    expect(createTableStmts, '0079 应当恰好一条 CREATE TABLE（ai_sessions）').toHaveLength(1);
    expect(createTableStmts[0]).toMatch(
      /CREATE TABLE IF NOT EXISTS pms_bui_wenlv_ai_sessions\s*\(/,
    );
    const body = createTableStmts[0].slice(
      createTableStmts[0].indexOf('(') + 1,
      createTableStmts[0].lastIndexOf(')'),
    );
    const defs = body
      .split(',')
      .map((d) => d.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(defs).toEqual([
      'id', 'script_room_id', 'user_id', 'stage', 'intent', 'transcript',
      'draft_snapshots', 'status', 'created_at', 'updated_at',
    ]);
  });

  it('六个新索引整条就位（scenes×2 / triggers / merchants / ai_sessions×2）', () => {
    const t = stripComments(readSql(FILE)).replace(/\s+/g, ' ').trim();
    for (const stmt of [
      'CREATE INDEX IF NOT EXISTS idx_wenlv_scenes_venue_point ON pms_bui_wenlv_scenes(venue_point_id);',
      'CREATE INDEX IF NOT EXISTS idx_wenlv_scenes_npc_id ON pms_bui_wenlv_scenes(npc_id);',
      'CREATE INDEX IF NOT EXISTS idx_wenlv_triggers_scene ON pms_bui_wenlv_triggers(scene_id);',
      'CREATE INDEX IF NOT EXISTS idx_wenlv_merchant_partners_room ON pms_bui_wenlv_merchant_partners(script_room_id);',
      'CREATE INDEX IF NOT EXISTS idx_wenlv_ai_sessions_room ON pms_bui_wenlv_ai_sessions(script_room_id);',
      'CREATE INDEX IF NOT EXISTS idx_wenlv_ai_sessions_user ON pms_bui_wenlv_ai_sessions(user_id);',
    ]) {
      expect(t, `0079 缺索引整条：${stmt}`).toContain(stmt);
    }
  });

  it('是纯幂等的（IF NOT EXISTS / DO 守护，无回填、无裸 DDL、无 DROP）', () => {
    const sql = readSql(FILE);
    const hazards = hazardClasses(sql);
    expect(hazards, `${FILE} 应当纯幂等，却命中了危害类别：${hazards.join(', ')}`).toEqual([]);
  });
});
