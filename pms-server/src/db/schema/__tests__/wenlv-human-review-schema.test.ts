import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { sql } from 'drizzle-orm';
import { db } from '../../index.js';
import { pmsBuiWenlvDesignAssets } from '../wenlv.js';

/**
 * 迁移 0035（design_assets 的人工评审列族）—— schema ↔ SQL 一致性 + **纯幂等**。
 *
 * ## 为什么「幂等」必须真跑而不是读文件判断
 *
 * `0035` 进了 `Dockerfile` 的 CMD 迁移清单，**容器每次启动都重跑整份清单**。
 * 于是「它不是幂等的」这件事的表现不是「部署失败」，而是**每次重启静默改写现网数据**
 * —— 前例：`0031` 的回填会把人类显式设的 `priority = 0` 盖掉，而 psql 的
 * 语句级报错**不炸容器**（CMD 的 psql 不带 `ON_ERROR_STOP`，RC 恒 0）。
 * 光读一眼 SQL 看不出这类问题，只有连跑两遍才知道第二遍会不会报错。
 *
 * ⚠️ 本用例连跑的是**本地开发库**（`vitest.local.config.ts` 的回环硬闸兜着），
 *    不是生产。生产那份由 `drizzle/0035_*.sql` 经部署流程执行。
 *    两遍都是「列已存在」的状态 —— 这**正是**重启时的真实情形，是本用例要钉的东西。
 */
const SQL_PATH = new URL('../../../../drizzle/0035_wenlv_human_review.sql', import.meta.url);
/** 去掉整行注释后再取语句。**必须先剥注释**：注释里出现了 `UPDATE`/`CREATE TABLE`
 *  这些词（「无 UPDATE 回填」），不剥就会把说明文字当成语句。 */
const statementsOf = (text: string): string[] =>
  text.split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

const sqlText = readFileSync(SQL_PATH, 'utf-8');
const statements = statementsOf(sqlText);

describe('design_assets 人工评审列族（0035 迁移）', () => {
  it('schema 声明的四个列名与 SQL 逐字一致（防 schema↔SQL 漂移）', () => {
    expect(pmsBuiWenlvDesignAssets.humanReviewScore.name).toBe('human_review_score');
    expect(pmsBuiWenlvDesignAssets.humanReviewDetail.name).toBe('human_review_detail');
    expect(pmsBuiWenlvDesignAssets.humanReviewedAt.name).toBe('human_reviewed_at');
    expect(pmsBuiWenlvDesignAssets.isRejected.name).toBe('is_rejected');
    for (const col of [
      'human_review_score', 'human_review_detail', 'human_reviewed_at', 'is_rejected',
    ]) {
      expect(sqlText).toContain(col);
    }
  });

  it('SQL 里没有非幂等语句（裸 CREATE TABLE / CREATE INDEX / UPDATE / DROP）', () => {
    // 与上面那条**成对**：这条是静态检查（能编译但语义危险），
    // 下面那条是真跑。少任何一条，另一条都可能被绕过。
    expect(/\bCREATE\s+TABLE\b/i.test(statements.join(';'))).toBe(false);
    expect(/\bCREATE\s+(UNIQUE\s+)?INDEX\b/i.test(statements.join(';'))).toBe(false);
    expect(/\bUPDATE\b/i.test(statements.join(';'))).toBe(false);
    expect(/\bDROP\b/i.test(statements.join(';'))).toBe(false);
    // 四条 ALTER，各自带 IF NOT EXISTS。**写 == 而不写 >=**（本仓禁止 `>=` 数量型契约）。
    expect(statements.length).toBe(4);
    for (const s of statements) {
      expect(s.startsWith('ALTER TABLE pms_bui_wenlv_design_assets')).toBe(true);
      expect(s).toContain('ADD COLUMN IF NOT EXISTS');
    }
  });

  // DB 用例按 RUN_DB 门控（与其余 *.db.test.ts 同款）。`vitest.local.config.ts` 里
  // `RUN_DB: '1'` 是写在 env 里的 ⇒ 用那个 config 跑时本用例**必然真跑**。
  describe.skipIf(!process.env.RUN_DB)('真跑两遍（本地库）', () => {
    it('连跑两遍都不报错，且第二遍不产生 ERROR', async () => {
      // 两遍都 await 到完，任何一遍抛错（SQLSTATE / 语法 / 唯一约束）都会让本用例红。
      // ⚠️ 这里**不能**用「只在第二遍 assert 不抛」的写法：第一遍抛错会被吞成
      //    一条无关的失败。两遍都跑、都不接异常才是「幂等」的原话。
      for (let pass = 0; pass < 2; pass++) {
        for (const stmt of statements) {
          await db.execute(sql.raw(stmt));
        }
      }
      // 跑完之后四列必须**都还在**（幂等不是「把列删掉再建」）。
      const cols = await db.execute(sql`
        SELECT column_name FROM information_schema.columns
        WHERE table_name = 'pms_bui_wenlv_design_assets'
          AND column_name IN ('human_review_score','human_review_detail','human_reviewed_at','is_rejected')
      `);
      expect((cols as unknown as { rows: unknown[] }).rows.length).toBe(4);
    });
  });
});
