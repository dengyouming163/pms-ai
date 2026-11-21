// 文旅剧本角色（P1）· 0042 列契约：**两半都断**（schema 侧 + 手写 SQL 侧）。
// 模型与理由见同目录先例 `wenlv-team-admission.columns.test.ts:1-14` 与 `wenlv-play-mode.columns.test.ts`。
// ⚠️ 本文件里的类型串是**两侧各自的实测字面**，别拿一侧去核另一侧：
//    drizzle 侧 `getSQLType()` 给的是 `timestamp with time zone`，而 SQL 文件里写的是 `timestamptz`
//    —— 本来就不同名。`varchar(50)` / `text` / `jsonb` / `integer` 两侧同形。
// ⚠️ `.defaultNow()` 的 `.default` 是 **SQL 对象**（串化成 `[object Object]`）⇒ 时间戳只能断 `hasDefault`。
// ⚠️ 两个 import 陷阱（都实测过，见先例 `:7-13`）：
//    `getTableColumns` 在 **'drizzle-orm'**；`getTableConfig`/`PgDialect` **只在** 'drizzle-orm/pg-core'。
//    互换模块说明符后，**本仓跑者**报的**不是**加载期缺导出，而是**调用点**
//    `TypeError: getTableColumns is not a function`（收集期即失败、`0 test`）。
import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { getTableConfig } from 'drizzle-orm/pg-core';
import { pmsBuiWenlvCharacters } from '../wenlv.js';

// 剥注释 + 压平空白 + **归一 EOL** —— 三条都要。
// EOL 那条的理由见 `drizzle-migration-registration.test.ts` 的 `readSql()` 长注：本仓
// `core.autocrlf=true` 且无 `.gitattributes` ⇒ 行尾带 CR 时 `--.*$` **剥不掉注释**，
// 而注释里出现的列名会喂饱下面的 `toContain` ⇒ **假绿**（真语句被注释替进去）。
const flatSql = readFileSync(
  new URL('../../../../drizzle/0042_wenlv_characters.sql', import.meta.url),
  'utf-8',
)
  .replace(/\r\n/g, '\n')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')
  .split('\n').map((l) => l.replace(/--.*$/, '')).join('\n')
  .replace(/\s+/g, ' ');

describe('角色表 0042 · 列契约（schema 半）', () => {
  const cols = getTableColumns(pmsBuiWenlvCharacters) as Record<string, {
    name: string; getSQLType: () => string; notNull: boolean; hasDefault: boolean; default: unknown;
  }>;

  it('schema 侧：全列契约（键名 / 列名 / 类型 / 长度 / 非空）—— 少一列就是运行期 42703', () => {
    // [TS 键, SQL 列名, getSQLType(), 非空]
    // ⚠️ `order` 与 SQL 关键字撞名：drizzle 生成 DDL 时会**自己加引号** ⇒ 这里的 `name` 仍是
    //    `order`；而**手写 SQL 侧**必须写成 `"order"`。这两件是两侧各自的事实，别互推。
    const spec: [string, string, string, boolean][] = [
      ['id', 'id', 'varchar(50)', true],
      ['productId', 'product_id', 'varchar(50)', true],
      ['order', 'order', 'integer', true],
      ['name', 'name', 'varchar(50)', true],
      ['faction', 'faction', 'varchar(50)', true],
      ['factionColor', 'faction_color', 'varchar(20)', false],
      ['identity', 'identity', 'varchar(50)', true],
      ['identityDesc', 'identity_desc', 'text', false],
      ['role', 'role', 'varchar(50)', false],
      ['avatarUrl', 'avatar_url', 'varchar(500)', false],
      ['ipPrompt', 'ip_prompt', 'text', false],
      ['vitality', 'vitality', 'integer', true],
      ['wisdom', 'wisdom', 'integer', true],
      ['insight', 'insight', 'integer', true],
      ['skills', 'skills', 'jsonb', true],
      ['hiddenQuest', 'hidden_quest', 'jsonb', false],
      ['createdAt', 'created_at', 'timestamp with time zone', true],
      ['updatedAt', 'updated_at', 'timestamp with time zone', true],
    ];
    for (const [key, name, sqlType, notNull] of spec) {
      const c = cols[key];
      expect(c, `characters.${name}（TS 键 ${key}）不在 schema 里`).toBeTruthy();
      expect(c.name).toBe(name);
      expect(c.getSQLType()).toBe(sqlType);
      expect(c.notNull, `characters.${name} 的可空性与契约不符`).toBe(notNull);
    }
    // 计数：防「顺手多一列」在其余全绿时发生（先例 `:167-168` 同款）
    expect(Object.keys(cols)).toHaveLength(spec.length);
  });

  it('schema 侧：默认值（order 默认 0、skills 有默认；三维**刻意没有**；时间戳只断 hasDefault）', () => {
    expect(cols.order.default).toBe(0);
    expect(cols.skills.hasDefault).toBe(true);
    // ⚠️ 时间戳的 `.default` 是 SQL 对象 ⇒ 只能断 hasDefault，不能断值
    expect(cols.createdAt.hasDefault).toBe(true);
    expect(cols.updatedAt.hasDefault).toBe(true);
    // 三维不给默认是**设计意图**（必填语义，见 0042 头注）⇒ 漏填必须是 23502 not_null_violation，
    // 不是静默 0。这条判据守的正是「有人顺手加个 default 让报错消失」。
    for (const k of ['vitality', 'wisdom', 'insight']) {
      expect(cols[k].hasDefault, `${k} 不该有默认值（必填语义，见 0042 头注）`).toBe(false);
    }
  });

  it('schema 侧：product_id 上挂的是**普通**索引（唯一性由主键蕴含，不要唯一索引）', () => {
    const hits = getTableConfig(pmsBuiWenlvCharacters).indexes
      .filter((i) => i.config.name === 'idx_wenlv_characters_product');
    expect(hits, 'schema 里找不到 idx_wenlv_characters_product').toHaveLength(1);
    // 这里只关心「别是 true」：非唯一索引的 `unique` 可能是 `false`，也可能是 `undefined`
    // （`undefined` 也是「不是唯一索引」）⇒ 不钉死具体形态。
    // ⚠️ 所以用 `Boolean(…)` 把 `undefined` 归成 `false` 再断 `toBe(false)`（而不是只断 falsy），
    //    把「别是 true」钉成精确值；matcher 是否可用以 src/types/vitest.d.ts 为准。
    expect(Boolean(hits[0].config.unique), 'product_id 索引不该是唯一索引').toBe(false);
    expect((hits[0].config.columns as { name: string }[]).map((c) => c.name)).toEqual(['product_id']);
  });

  it('schema 侧：id 是**主键**（只断 notNull 抓不到「.primaryKey() 被换成 .notNull()」）', () => {
    // 判据取 `getTableColumns(...).id.primary`。
    // 🔴 **不要**改用 `getTableConfig(t).primaryKeys`：本仓 drizzle 0.45.2 上**就地实测**
    //    （2026-09-29 读数：`id.primary = true` 而 `primaryKeys.length = 0`）——
    //    列级 `.primaryKey()` 下它是**空数组** ⇒ 那个取法对本缺陷零判别力。
    // 就地重取一次而**不**复用上面的 `cols` 常量，两点理由：
    //   ① `cols` 的类型被收窄成 `{name,getSQLType,notNull,hasDefault,default}`，里面**没有** `primary`
    //      ⇒ 就地重取能让 `primary` 走原类型（`node_modules/drizzle-orm/column.d.ts` 上实测声明
    //      是 `readonly primary: boolean`），从而**不必**加 `as any`（那会顺手废掉整条链路的类型检查）；
    //   ② 重取没有成本：`getTableColumns` 只是读 schema 对象上的列映射。
    const full = getTableColumns(pmsBuiWenlvCharacters);
    expect(full.id.primary, 'id 必须是主键 —— 全表唯一的依据（0042 头注，以及本文件 SQL 半的 `id varchar(50) PRIMARY KEY` 子句针都引它）').toBe(true);
    // 负对照：同一取法下**非**主键列必须是 false。没有它，「primary 恒真」这种量具坏法会静默通过
    // （断言看对了、量具是坏的 ⇒ 空断言）。
    expect(full.productId.primary, 'productId 不该是主键（负对照：证明上面那条不是恒真）').toBe(false);
  });
});

describe('角色表 0042 · 列契约（SQL 半）', () => {
  it('SQL 侧：建表整条子句（含 IF NOT EXISTS —— 本文件进了启动清单）', () => {
    expect(flatSql).toContain('CREATE TABLE IF NOT EXISTS pms_bui_wenlv_characters (');
    // 逐条钉**整条列定义**（类型 / 长度 / 非空 / 默认值），不是只钉列名。
    // 🔴 **针必须带「行尾终结符」，否则它是前缀子串断言 ⇒ 对「往子句后面追加」的变异一律零信号。**
    //    实测（2026-09-29）：`faction varchar(50) NOT NULL` 不带终结符时，变异后的
    //    `… NOT NULL DEFAULT '未知',` **仍然包含**它 ⇒ **18/18 全绿、零信号**
    //    —— 而「给 faction 加 DEFAULT」正是本文件存在的理由之一（见本文件头注与本 Task 开头）。
    //    ⇒ 也就是说：**第一版这 18 条只补上了「改口径」那一半，没补上「追加」那一半。**
    //    修法：用 `(?=\s*[,)])` 要求子句后面紧跟 `,` 或 `)`（即它是一条**完整**的列定义）。
    //    同族覆盖：追加 `DEFAULT` / `CHECK` / `REFERENCES` / `GENERATED` 全被挡下；
    //    「可空列被改成 NOT NULL」也被挡下（`faction_color varchar(20),` 不再匹配）。
    // ⚠️ 空白已在 flatSql 里压平 ⇒ 这里写单空格形态；`(` / `[` / `'` 等元字符**必须转义**，
    //    否则 `new RegExp` 会把它们当正则语法（`'[]'` 会变成空字符类、`(` 会变成捕获组）。
    const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    for (const clause of [
      'id varchar(50) PRIMARY KEY',
      'product_id varchar(50) NOT NULL',
      '"order" integer NOT NULL DEFAULT 0',
      'name varchar(50) NOT NULL',
      'faction varchar(50) NOT NULL',
      'faction_color varchar(20)',
      'identity varchar(50) NOT NULL',
      'identity_desc text',
      'role varchar(50)',
      'avatar_url varchar(500)',
      'ip_prompt text',
      'vitality integer NOT NULL',
      'wisdom integer NOT NULL',
      'insight integer NOT NULL',
      "skills jsonb NOT NULL DEFAULT '[]'::jsonb",
      'hidden_quest jsonb',
      'created_at timestamptz NOT NULL DEFAULT now()',
      'updated_at timestamptz NOT NULL DEFAULT now()',
    ]) {
      expect(
        flatSql,
        `0042 的 ${clause} 丢了或被改了口径（或缺行尾终结符 ⇒ 有人往它后面追加了东西）`,
      ).toMatch(new RegExp(esc(clause) + '(?=\\s*[,)])'));
    }
  });

  it('SQL 侧：product_id 上是**普通**索引，且不另建 (product_id, id) 唯一索引', () => {
    expect(flatSql).toContain(
      'CREATE INDEX IF NOT EXISTS idx_wenlv_characters_product ON pms_bui_wenlv_characters (product_id);',
    );
    // id 已是主键（全局唯一）⇒ 产品内唯一性由主键**蕴含**；再建唯一索引只是白付写放大。
    // 这条钉的是「有人按 spec §4.1 那句 expired 的 `unique(product_id, id)` 把它加回来」。
    expect(flatSql).not.toMatch(/CREATE UNIQUE INDEX[^;]*wenlv_characters/i);
  });

  it('SQL 侧：建表体内的列定义**逐项相等**（多一列 / 少一列 / 对调都是真缺陷）', () => {
    // 形状照同目录先例 `wenlv-team-admission.columns.test.ts` 那段「CREATE TABLE 体内逐项相等」。
    // 为什么非有这一段：上面那一组 `toMatch` 是**存在性 + 子句完整**判据，**对「多一列」零信号**。
    //   实测（2026-09-29 本文件跑）：建表体中间插一行 `evil text NOT NULL,`、以及末列后追加一行
    //   `evil text NOT NULL`，两种变异下本文件都是「只有本用例红、其余全绿」。
    // 生产后果不是「多一列而已」：迁移跑完物理表就多一个 NOT NULL 无默认列，而 drizzle 只写它知道的
    //   18 列 ⇒ **每次经 ORM 的 INSERT 都 23502，整表不可写**（同一失败形态见 0042 头注：那里记的是
    //   漏填 `vitality` 报 `null value in column ... violates not-null constraint` / SQLSTATE 23502）。
    // 逐项相等同时钉住「少一列」（运行期 42703）与「重复一列」（PG 42701，整张表建不出来）；
    //   又因为是**有序**比较，两列对调也会红（对调在生产上是静默的列错位）。
    // ⚠️ 本用例只钉**列名**；类型 / 非空 / 默认值那一半归上面的 18 条子句针。
    const createTableStmts = flatSql
      .split(';')
      .map((s) => s.trim())
      .filter((s) => /^CREATE TABLE\b/i.test(s));
    expect(createTableStmts, 'characters 的 CREATE TABLE 语句应当恰好一条').toHaveLength(1);
    const stmt = createTableStmts[0];
    const body = stmt.slice(stmt.indexOf('(') + 1, stmt.lastIndexOf(')'));
    // 每条列定义取**第一个词**（= 列名）。`"order"` 的引号会一起取到 —— 手写 SQL 里它必须带引号
    //   （理由见上面 schema 半里 `order` 那段）。
    const defs = body.split(',').map((d) => d.trim().split(/\s+/)[0]).filter(Boolean);
    expect(
      defs,
      'CREATE TABLE 体内的列定义必须**逐项依次相等、一项不多一项不少**：'
        + '多一列 ⇒ 物理表多一个 NOT NULL 无默认列，ORM 的 INSERT 恒 23502；'
        + '少一列 ⇒ 运行期 42703；对调 ⇒ 静默列错位。',
    ).toEqual([
      'id',
      'product_id',
      '"order"',
      'name',
      'faction',
      'faction_color',
      'identity',
      'identity_desc',
      'role',
      'avatar_url',
      'ip_prompt',
      'vitality',
      'wisdom',
      'insight',
      'skills',
      'hidden_quest',
      'created_at',
      'updated_at',
    ]);
  });
});
