import { describe, it, expect } from 'vitest';
import { sql, getTableColumns } from 'drizzle-orm';
import { db } from '../index.js';
import { pmsBuiWenlvAssetJobs, pmsBuiWenlvBeacons } from '../schema/index.js';

const run = !!process.env.RUN_DB;

// 迁移与 schema 是两处独立真相：代码里加了字段但迁移没跑，TypeScript 全绿而
// 线上读接口 42703 全黑。这个文件就是钉死「两边都做了」的那颗钉子。
/**
 * drizzle 表对象 → 它声明的列名。用来把断言的**两侧**都钉死（见下方说明）。
 * 必须走 `getTableColumns` 而不是 `Object.values(table)`：后者会把 drizzle 0.45
 * 挂在表对象上的**非列**属性（`enableRLS` 等 builder 方法）也算成列名，
 * 于是断言恒真失败（库里永远不会有叫 enableRLS 的列），迁移跑对了也绿不了。
 */
const declaredCols = (table: object): string[] =>
  Object.values(getTableColumns(table as any)).map((c: any) => c.name);

describe.skipIf(!run)('wenlv 迁移落地校验', () => {
  const colsOf = async (table: string): Promise<string[]> => {
    const r: any = await db.execute(sql`
      SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${table} ORDER BY column_name`);
    return (r.rows ?? r).map((x: any) => x.column_name);
  };

  // 断言两侧：**库里有的** ⊇ **drizzle 声明的**。只硬编码字面量列名会漏掉镜像方向的错
  // （比如代码把 style_anchor_url 写成 style_anchor —— TS 绿、字面量断言绿，
  //  线上 select 才炸）。用 `expect(missing).toEqual([])` 一次报出**全部**缺失列，
  //  而不是第一条就中断。
  const expectDeclared = async (table: object, pgName: string) => {
    const cols = await colsOf(pgName);
    const missing = declaredCols(table).filter(c => !cols.includes(c));
    // 不传 `expect` 的第二参（失败消息）：这里不需要它 —— 缺失列以数组整体报出，
    // 失败时仍能看到**全部**缺哪些列，诊断力不靠那句消息。
    // ⚠️ 2026-09-19 更正：原注释给的理由（「桩只声明了单参 `expect(actual)`，两参重载
    //    过不了 ts-check」）**不成立** —— 桩里 `expect` 一直带 `message?: string` 第二参，
    //    两参调用不报错。
    expect(missing).toEqual([]);
  };

  it('新表 pms_bui_wenlv_asset_jobs 与 schema 声明一致', async () => {
    await expectDeclared(pmsBuiWenlvAssetJobs, 'pms_bui_wenlv_asset_jobs');
  });

  it('design_assets 有 venue_id', async () => {
    expect(await colsOf('pms_bui_wenlv_design_assets')).toContain('venue_id');
  });

  it('scenes 有 narration_url', async () => {
    expect(await colsOf('pms_bui_wenlv_scenes')).toContain('narration_url');
  });

  it('products 有 style_bible', async () => {
    expect(await colsOf('pms_bui_wenlv_products')).toContain('style_bible');
  });

  it('products 有 style_anchor_url', async () => {
    expect(await colsOf('pms_bui_wenlv_products')).toContain('style_anchor_url');
  });

  it('新表 pms_bui_wenlv_beacons 与 schema 声明一致', async () => {
    await expectDeclared(pmsBuiWenlvBeacons, 'pms_bui_wenlv_beacons');
  });
});
