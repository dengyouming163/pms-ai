// 文旅 NPC 表（0043）· 简化列契约：只断 schema 侧的列键与 lines 默认。
// 模型与「两半都断」的完整先例见同目录 `wenlv-characters.columns.test.ts`；本文件按 Task 1
// 计划的简化版落地（仅 schema 半，SQL 半的逐项相等已由 0042 的同构 NPC 迁移文件保证）。
//
// ⚠️ 两个 import 陷阱（与 `wenlv-characters.columns.test.ts:7-13` 同源，已实测）：
//    `getTableColumns` 在 **'drizzle-orm'**；`getTableConfig`/`PgDialect` **只在** 'drizzle-orm/pg-core'。
//    互换模块说明符后，本仓跑者报的是**调用点** `TypeError: getTableColumns is not a function`（收集期即失败、`0 test`）。
// ⚠️ `.default([])` 的 `.default` 是 **SQL 对象**（同 `.defaultNow()`，串化成 `[object Object]`）⇒
//    只能断 `hasDefault`，不能断值 —— 见 `wenlv-characters.columns.test.ts:6,73` 的同款注释。
//    计划草稿里的 `defaultConfig` 在 drizzle-orm 0.45.2 的 column 上**不存在**（`column.d.ts` 实测：
//    只有 `default` / `defaultFn` / `hasDefault`）⇒ 改用 `hasDefault`，与同目录先例一致。
import { describe, it, expect } from 'vitest';
import { getTableColumns } from 'drizzle-orm';
import { pmsBuiWenlvNpcs } from '../wenlv.js';

describe('pms_bui_wenlv_npcs columns', () => {
  const cols = getTableColumns(pmsBuiWenlvNpcs) as Record<string, {
    name: string; getSQLType: () => string; notNull: boolean; hasDefault: boolean;
  }>;

  it('has id/product_id/order/name/character_id/portrait_url/portrait_prompt/voice_id/description/role/lines', () => {
    const keys = Object.keys(cols);
    for (const k of ['id','productId','orderId','name','characterId','portraitUrl','portraitPrompt','voiceId','description','role','lines','createdAt','updatedAt']) {
      expect(keys, `npcs.${k} 不在 schema 里`).toContain(k);
    }
  });

  it('lines is jsonb with $type WenlvNpcLine[] default []', () => {
    expect(cols.lines.name).toBe('lines');
    expect(cols.lines.getSQLType()).toBe('jsonb');
    expect(cols.lines.notNull).toBe(true);
    // `.default([])` 的 `.default` 是 SQL 对象 ⇒ 只能断 hasDefault（同 characters.skills 的口径）
    expect(cols.lines.hasDefault).toBe(true);
  });
});
