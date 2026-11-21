// 文旅团队准入（P2）· 列名契约：**两半都断**（schema 侧 + 手写 SQL 侧）。
// 模型与理由见同目录先例 `wenlv-play-mode.columns.test.ts`（71 行，2026-09-25 经 9 个近失变异校过）：
// 只断 schema 抓不到 SQL 漂移，只断 SQL 抓不到 schema 漂移。剥注释照它 `:37-42` 的写法（两条路径都剥）。
// ⚠️ 本文件里所有类型串 / 默认值都是**实测**值（2026-09-25，drizzle-orm 0.45.2）：
//    `varchar(50)` / `uuid` / `integer` / `timestamp with time zone`；
//    `.defaultNow()` 的 `.default` 是 **SQL 对象**（`[object Object]`）⇒ 只能断 `hasDefault`。
// ⚠️ 两个 import 陷阱（都实测过）：
//    · `getTableColumns` 在 **'drizzle-orm'**（'drizzle-orm/pg-core' 里是 undefined）；
//      `getTableConfig`/`PgDialect` **只在** **'drizzle-orm/pg-core'**（'drizzle-orm' 里是 undefined）。
//      互换模块说明符后，**本仓跑者**（vitest/vite-node 的 SSR 转换）报的**不是**加载期「不提供该导出」，
//      而是**调用点** `TypeError: getTableColumns is not a function`（该文件在收集期即失败、`0 test`）；
//      加载期的 `SyntaxError: The requested module '…' does not provide an export named …` 是**纯 Node ESM** 的形态。
//    · 索引名字只能读 `.config.name`：索引对象上**没有** `getName()`（实测 undefined）。
// ⚠️ SQL 半的判据**不止存在性**：`toContain` 之外另有序次 / 结构 / 计数断言，各自的已验变异写在就近注释里。
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig, PgDialect } from 'drizzle-orm/pg-core';
import { pmsBuiWenlvProgress, pmsBuiWenlvSessions } from '../wenlv.js';

const SQL_PATH = new URL('../../../../drizzle/wenlv-team-m1.sql', import.meta.url);
/** 剥注释（块 + 行尾，**两条都要**，照先例 `:37-42`；只剥整行 `--` 会被行尾注释喂饱）＋压平空白 */
const flatSql = readFileSync(SQL_PATH, 'utf-8')
  .replace(/\r\n/g, '\n') // 归一 EOL：CRLF 会让行尾注释剥不掉，见 drizzle-migration-registration.test.ts 的 readSql() 长注
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
  .replace(/\s+/g, ' ');

/** 部分索引的谓词 → 渲染文本。`sql` 模板**逐字**渲染（实测 `session_id IS NULL`，不带表前缀），
 *  所以这里钉字面量；若哪天有人改用 `isNotNull(col)`，渲染会变成 `"表"."session_id" is not null`
 *  ⇒ 本条会红。那时**改断言、别把 schema 改回裸串**（两种写法在库里等价，但读 schema 与读 SQL 看到的就不是同一串了）。 */
function whereText(idx: unknown): string {
  const w = (idx as { config: { where?: unknown } }).config.where;
  return w ? new PgDialect().sqlToQuery(w as never).sql : '';
}

describe('progress 的通道列与两条部分唯一索引', () => {
  const cols = getTableColumns(pmsBuiWenlvProgress);

  it('schema 侧：session_id 是可空 varchar(50)（NULL = 散客行）', () => {
    expect(cols.sessionId, 'schema 里没有 sessionId').toBeTruthy();
    expect(cols.sessionId.name).toBe('session_id');
    expect(cols.sessionId.getSQLType()).toBe('varchar(50)');
    // 可空是**语义的一部分**：NOT NULL 会让所有散客进度写入炸在 23502
    expect(cols.sessionId.notNull).toBe(false);
  });

  it('schema 侧：两条索引的名字 / 列 / 唯一性 / 谓词（谓词丢了就退化成全表唯一）', () => {
    const idx = getTableConfig(pmsBuiWenlvProgress).indexes;
    // 集合相等而不是「包含」：只断存在会被「后来又加了一条整表唯一」静默满足
    expect(idx.map((i) => i.config.name).sort()).toEqual(['uq_wenlv_progress_solo', 'uq_wenlv_progress_team']);

    const solo = idx.find((i) => i.config.name === 'uq_wenlv_progress_solo')!;
    expect(solo.config.unique).toBe(true);
    expect((solo.config.columns as { name: string }[]).map((c) => c.name)).toEqual(['mini_user_id', 'product_id']);
    expect(whereText(solo)).toBe('session_id IS NULL');

    const team = idx.find((i) => i.config.name === 'uq_wenlv_progress_team')!;
    expect(team.config.unique).toBe(true);
    // 🔴 键必须含 session_id：少了它 = 「每人每产品一条」⇒ 同一个人第二场插不进去，
    //    且报错指向一个看起来无关的唯一约束
    expect((team.config.columns as { name: string }[]).map((c) => c.name))
      .toEqual(['mini_user_id', 'product_id', 'session_id']);
    expect(whereText(team)).toBe('session_id IS NOT NULL');
  });

  it('SQL 侧：先 DROP 旧索引、再建两条部分索引（DROP 与 CREATE 必须相邻且完整）', () => {
    expect(flatSql).toContain(
      'DROP INDEX IF EXISTS uq_wenlv_progress_user_product; ' +
        'CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_solo ON pms_bui_wenlv_progress (mini_user_id, product_id) WHERE session_id IS NULL;',
    );
    expect(flatSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_team ON pms_bui_wenlv_progress (mini_user_id, product_id, session_id) WHERE session_id IS NOT NULL;',
    );
    expect(flatSql).toContain('ALTER TABLE pms_bui_wenlv_progress ADD COLUMN IF NOT EXISTS session_id varchar(50);');
  });

  // ⚠️ 上面那条是**存在性**判据，`toContain` 抓不住三类真变异（2026-09-25 复核逐条实测，全绿）：
  //    M1 把 `ADD COLUMN … session_id` 挪到文件末尾（两条 CREATE INDEX 之后）⇒ 绿。生产上它是**静默**的：
  //       CMD 里那条 psql 没带 `-v ON_ERROR_STOP` ⇒ 全新库上两条 CREATE INDEX 报 42703 被跳过、`exit 0`，
  //       而旧整表唯一索引已 DROP ⇒ **完全没有唯一性**（已在 pms-pg-sop 上以 scratch 表实测）。
  //    M2 末尾追加 `ALTER TABLE … DROP COLUMN IF EXISTS session_id;` ⇒ 绿（该列不复存在）。
  //    M3 复制一行 `CREATE TABLE` 内的列定义 ⇒ 绿（PG 报 42701，sessions 表根本建不出来）。
  //    下面三条把它们分别钉住；形状照同目录先例 `wenlv-play-mode.columns.test.ts:62-69` 的**计数**写法。
  it('SQL 侧：ADD COLUMN 必须排在两条 CREATE INDEX 之前（全新库的 42703 会被 psql 静默吞掉）', () => {
    // 用**位置比较**（`indexOf`），不是行号 —— 行号会被任何无关插入推漂。
    const at = (needle: string) => flatSql.indexOf(needle);
    const addColumn = at('ALTER TABLE pms_bui_wenlv_progress ADD COLUMN IF NOT EXISTS session_id');
    const solo = at('CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_solo');
    const team = at('CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_progress_team');
    // 三者都在：缺失时 `indexOf` 给 -1，而 `-1 < 任何正数` 会**平凡通过** ⇒ 先各自钉存在（否则下面的比较是空断言）
    expect(addColumn, 'ADD COLUMN 子句丢了').toBeGreaterThanOrEqual(0);
    expect(solo, 'solo 索引子句丢了').toBeGreaterThanOrEqual(0);
    expect(team, 'team 索引子句丢了').toBeGreaterThanOrEqual(0);
    expect(
      addColumn,
      'ADD COLUMN 必须排在 solo 索引之前：否则全新库上该索引报 42703 被静默跳过（M1）',
    ).toBeLessThan(solo);
    expect(addColumn, '同上，team 索引也一样：全新库上 42703 ⇒ 两条部分唯一索引一条都建不出来').toBeLessThan(team);
  });

  it('SQL 侧：结构性 —— 索引语句恰好 3 条，且 progress 上的每条都是带 WHERE session_id IS 的部分唯一索引', () => {
    const indexStmts = flatSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^CREATE (UNIQUE )?INDEX\b/i.test(s));
    expect(indexStmts, '索引语句总数变了（本文件应为 progress 两条 + sessions 一条）').toHaveLength(3);

    const onProgress = indexStmts.filter((s) => /\bON pms_bui_wenlv_progress\b/.test(s));
    expect(onProgress, 'progress 上只能有两条索引语句').toHaveLength(2);
    // 🔴 逐条要求「唯一 + 带谓词」⇒ 任何**整表**唯一索引都逃不掉，**不管它叫什么名字**。
    //    实测 M16：追加一条换名字的 `… uq_wenlv_progress_all ON pms_bui_wenlv_progress (mini_user_id,
    //    product_id);`（无谓词）时三条存在性判据全绿 —— 而那正是「同一个人第二场插不进去」的形状
    //    （2026-09-25 在 pms-pg-sop 上实测：同一人第二行报
    //     `duplicate key value violates unique constraint "uq_wenlv_progress_all"`，
    //     同样的两行在两条部分唯一索引下可以并存）。
    for (const s of onProgress) {
      expect(s, `progress 上的索引必须是 UNIQUE：${s}`).toMatch(/^CREATE UNIQUE INDEX\b/i);
      expect(
        s,
        `progress 上的索引必须带 WHERE session_id IS … 谓词（丢掉谓词 = 退化成整表唯一）：${s}`,
      ).toMatch(/WHERE\s+session_id\s+IS\s+(NULL|NOT NULL)\b/);
    }
  });

  it('SQL 侧：负判据 —— 不得 DROP 掉 session_id，且该列在剥注释后的 SQL 里恰好出现 4 次', () => {
    expect(
      flatSql,
      '不得 DROP 掉 session_id —— 那会让两条 CREATE INDEX 在全新库上全部 42703 被跳过',
    ).not.toMatch(/DROP\s+(COLUMN\s+)?(IF\s+EXISTS\s+)?session_id/);
    // 计数（照先例 `wenlv-play-mode.columns.test.ts:62-69` 的形状）：4 次提及 =
    //   ① `ADD COLUMN … session_id` ② `WHERE session_id IS NULL`
    //   ③ `(…, session_id)`          ④ `WHERE session_id IS NOT NULL`
    // 追加任何一种提及（末尾 DROP / 二次 ADD / 又一条带该列的索引）都会变红，而 `toContain` 抓不住（M2）。
    expect(
      (flatSql.match(/session_id/g) ?? []).length,
      'session_id 应当恰好出现 4 次：多出来的那次就是有人在改这一列。',
    ).toBe(4);
  });
});

describe('sessions 新表（队伍）', () => {
  const cols = getTableColumns(pmsBuiWenlvSessions) as Record<string, {
    name: string; getSQLType: () => string; notNull: boolean; hasDefault: boolean; default: unknown;
  }>;

  it('schema 侧：全列契约（键名 / 列名 / 类型 / 非空）—— 少一列就是运行期 42703', () => {
    const spec: [string, string, string, boolean][] = [
      ['id', 'id', 'varchar(50)', true],
      ['productId', 'product_id', 'varchar(50)', true],
      ['orderId', 'order_id', 'uuid', true],
      ['slotId', 'slot_id', 'uuid', false],
      ['code', 'code', 'varchar(16)', true],
      ['seq', 'seq', 'integer', true],
      ['name', 'name', 'varchar(50)', true],
      ['status', 'status', 'varchar(20)', true],
      ['createdAt', 'created_at', 'timestamp with time zone', true],
      ['updatedAt', 'updated_at', 'timestamp with time zone', true],
    ];
    for (const [key, name, sqlType, notNull] of spec) {
      const c = cols[key];
      expect(c, `sessions.${name}（TS 键 ${key}）不在 schema 里`).toBeTruthy();
      expect(c.name).toBe(name);
      expect(c.getSQLType()).toBe(sqlType);
      expect(c.notNull, `sessions.${name} 的可空性与契约不符`).toBe(notNull);
    }
    // 计数：防「顺手多一列」在其余全绿时发生
    expect(Object.keys(cols)).toHaveLength(spec.length);
  });

  it('schema 侧：默认值（status 默认 forming；时间戳只断 hasDefault）', () => {
    expect(cols.status.default).toBe('forming');
    expect(cols.seq.hasDefault).toBe(true);
    // ⚠️ `.defaultNow()` 的 `.default` 是 SQL 对象（串化成 `[object Object]`）⇒ 只能断 hasDefault
    expect(cols.createdAt.hasDefault).toBe(true);
    expect(cols.updatedAt.hasDefault).toBe(true);
    // 没有默认值的三列：留给调用方（Task 5 的建队）自己填 ⇒ 漏填必须是 NOT NULL 违例（23502），不是静默空串
    expect(cols.orderId.hasDefault).toBe(false);
    expect(cols.code.hasDefault).toBe(false);
    expect(cols.name.hasDefault).toBe(false);
  });

  it('schema 侧：code 上是唯一索引（重复的队伍码 = 两支队共用一个码）', () => {
    const hits = getTableConfig(pmsBuiWenlvSessions).indexes
      .filter((i) => i.config.name === 'uq_wenlv_sessions_code');
    expect(hits).toHaveLength(1);
    expect(hits[0].config.unique).toBe(true);
    expect((hits[0].config.columns as { name: string }[]).map((c) => c.name)).toEqual(['code']);
  });

  it('SQL 侧：建表与唯一索引的整条子句（含 IF NOT EXISTS —— 本文件进了启动清单）', () => {
    expect(flatSql).toContain('CREATE TABLE IF NOT EXISTS pms_bui_wenlv_sessions (');
    for (const clause of [
      'id varchar(50) PRIMARY KEY',
      'product_id varchar(50) NOT NULL',
      'order_id uuid NOT NULL',
      'slot_id uuid',
      'code varchar(16) NOT NULL',
      'seq integer NOT NULL DEFAULT 1',
      'name varchar(50) NOT NULL',
      "status varchar(20) NOT NULL DEFAULT 'forming'",
      'created_at timestamptz NOT NULL DEFAULT now()',
      'updated_at timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(flatSql, `sessions 的 ${clause} 丢了`).toContain(clause);
    }
    expect(flatSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_sessions_code ON pms_bui_wenlv_sessions (code);',
    );

    // 🔴 结构判据：`CREATE TABLE` 体内的列定义**逐项相等**（不是「包含」）。
    //    实测 M3：把 `code varchar(16) NOT NULL,` 复制一份 ⇒ 上面所有 `toContain` 全绿，
    //    而 PG 会报 42701（column "code" specified more than once）⇒ sessions 表根本建不出来。
    //    逐项相等同时钉住「少一列」（少列 = 运行期 42703）、「多一列」与「重复一列」。
    const createTableStmts = flatSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^CREATE TABLE\b/i.test(s));
    expect(createTableStmts, 'sessions 的 CREATE TABLE 语句应当恰好一条').toHaveLength(1);
    const stmt = createTableStmts[0];
    const body = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
    const defs = body
      .split(',')
      .map((d) => d.trim().split(/\s+/)[0])
      .filter(Boolean);
    expect(defs, 'CREATE TABLE 体内的列定义必须逐项相等（重复列 ⇒ PG 42701，整张表建不出来）').toEqual([
      'id',
      'product_id',
      'order_id',
      'slot_id',
      'code',
      'seq',
      'name',
      'status',
      'created_at',
      'updated_at',
    ]);
  });
});
