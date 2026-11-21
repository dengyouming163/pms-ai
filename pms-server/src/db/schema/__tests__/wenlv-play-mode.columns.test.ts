import { readFileSync } from 'node:fs';
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { pmsBuiWenlvProducts } from '../wenlv.js';

/**
 * 「列名契约」有**两半**，**两边都要断** —— 只断一边，用例名就在替缺口担保：
 *   ① schema 侧：列对象（列名 / 长度 / 非空 / 默认值）
 *   ② SQL 侧：迁移里真建的是什么
 * 只断 ① 抓不到 SQL 漂移；只断 ② 抓不到 schema 漂移 —— 例如为「新建产品默认多人」把
 * `.default('solo')` 改成 `.default('group')` 而不动 SQL：库里 `DEFAULT` 仍是 `solo`，
 * 而 drizzle INSERT 会显式写 `'group'`（`pg-core/dialect.cjs` 的 `insertOrder` 取全部表列）
 * ⇒ 两条默认值悄悄分叉，而声称覆盖此事的用例全程沉默。
 *
 * 同目录先例 `wenlv-human-review-schema.test.ts:37-47`（裸子串那行在 `:45`）确实同时断两半 ——
 * ⚠️ 但它 SQL 那半用的是**裸子串** `toContain(col)`。2026-09-25 拿 **9 个**近失变异实测：
 * 裸子串 **9 个全绿**（判别力为零）。这里改锚**整条子句**（**9 个全红**）。
 * ⚠️ 也别以为「把子串写长点」就够 —— `toContain('play_mode varchar')` 只挡住 3 个。
 *    脚本在 `D:/tmp/substrnearmiss.mjs`（**只读**仓内文件，变异在内存里做）。
 */
const SQL_PATH = new URL('../../../../drizzle/0040_wenlv_play_mode.sql', import.meta.url);
/**
 * ⚠️ **必须先剥注释**：注释里若出现「正确子句应为 …」这类说明（本仓注释风格极易发生），
 * 整条子句判据会**假绿**。同目录的仓库级闸 `drizzle-migration-registration.test.ts` 里的
 * `stripComments()` 正是为同一个理由写的。
 * ⚠️ **这里刻意不写行号**：该函数上方那段 `readSql()` 长注是 2026-09-29 后加的，
 *    一加就把原来的行号引用全部推漂（当时写在注释里的 `:78-83` / `:116` 是给**加注之前**的文件的）。
 *    要定位就按**函数名**搜，别按行号。
 *
 * 🔴 但**照抄那个 `stripComments` 不够** —— 它只丢 `trimStart().startsWith('--')` 的**整行**注释，
 * 于是还有两条假绿路径（2026-09-25 实测，见订正记录第 30 条）：
 *   · **行尾** `--` 注释：`… DEFAULT 'solo'; -- 正确子句应为 <完整正确子句>` ⇒ 仍绿
 *   · **块注释** `/* … *​/`：同上 ⇒ 仍绿
 * 所以这里块注释与行尾注释**都剥**。
 * ⚠️ 副作用：若将来 SQL 的**字符串字面量**里出现 `--`（如 `DEFAULT 'a--b'`），会被误剥 ⇒ 判据**假红**。
 *    块注释 `/* *​/` 在字符串字面量里同样会被误剥（如 `'a/*b*​/c'` → `'a c'`）⇒ 与 `--` 同一条假红路径。
 *    假红比假绿安全（会有人来看），但那时正解应改成**结构式抽取**（先 `match` 出 `ALTER TABLE …;` 再逐字比），
 *    而不是继续在「剥注释」上打补丁。
 */
const flatSql = readFileSync(SQL_PATH, 'utf-8')
  .replace(/\r\n/g, '\n') // 归一 EOL：CRLF 会让行尾注释剥不掉，见 drizzle-migration-registration.test.ts 的 readSql() 长注
  .replace(/\/\*[\s\S]*?\*\//g, ' ')   // 块注释（可跨行）→ 先剥
  .split('\n')
  .map((l) => l.replace(/--.*$/, ''))  // 行尾/整行注释 → 再剥
  .join('\n')
  .replace(/\s+/g, ' ');

describe('内容侧 play_mode 的列名契约', () => {
  const cols = getTableColumns(pmsBuiWenlvProducts);

  it('schema 侧：列名 + 长度 + 非空 + 默认值（与 mode ↔ mode 并存）', () => {
    expect(cols.playMode.name).toBe('play_mode');
    // ⚠️ `columnType` 只有类型名，**不含长度**（实测返回 `'PgVarchar'`）⇒ 长度必须单独断 `.length`，
    //    否则 `varchar(10)` 改成 `varchar(20)` 是断不出来的。
    expect(cols.playMode.columnType).toBe('PgVarchar');
    expect((cols.playMode as { length?: number }).length).toBe(10);
    expect(cols.playMode.notNull).toBe(true);
    expect(cols.playMode.default).toBe('solo');
    expect(cols.mode.name).toBe('mode');
  });

  it('SQL 侧：0040 建的确实是这张表的这一列（防 schema↔SQL 漂移）', () => {
    expect(flatSql).toContain(
      "ALTER TABLE pms_bui_wenlv_products ADD COLUMN IF NOT EXISTS play_mode varchar(10) NOT NULL DEFAULT 'solo'",
    );
    // ⚠️ **存在性判据不够**：上面那条 `toContain` 在同一条正确子句**之后追加**一句
    //    `ALTER TABLE … DROP COLUMN play_mode;` 时**照样绿**（2026-09-25 复核实测）——
    //    而那正是它要防的漂移。补一条**计数**判据：该列在 0040 里只该出现这一次。
    expect(
      (flatSql.match(/play_mode/g) ?? []).length,
      '0040 里 play_mode 应当恰好出现 1 次：ADD 之外的任何一次提及，都意味着有人改过这条' +
        '已应用的迁移（追加 DROP / 二次 ADD 都能被这一条抓住，而 toContain 抓不住）。',
    ).toBe(1);
  });
});
