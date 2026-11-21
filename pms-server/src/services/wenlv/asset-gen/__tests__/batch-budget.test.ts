import { describe, it, expect, afterEach, vi } from 'vitest';
import { batchBudgetLimit, exceededBatchBudget } from '../batch-budget.js';

describe('批次花费上限', () => {
  afterEach(() => vi.unstubAllEnvs());
  it('未设 env → 用默认值', () => {
    expect(batchBudgetLimit()).toBe(20);
  });
  it('env 显式设置优先', () => {
    vi.stubEnv('WENLV_BATCH_BUDGET_YUAN', '5');
    expect(batchBudgetLimit()).toBe(5);
  });
  it('env 非法（0/负数/非数字/空白）→ 回落默认值', () => {
    // `'0'` 必须与 `'-1'` 同档：0 是**无效值**，不是「冻结本批」——
    // 若被当成显式上限，这个批次会一分钱都花不出去（急停有 WENLV_ASSET_GEN_PAUSED）。
    for (const v of ['0', '-1', 'abc', '   ']) {
      vi.stubEnv('WENLV_BATCH_BUDGET_YUAN', v);
      expect(batchBudgetLimit(), v).toBe(20);
    }
  });
  it('exceeded() 用 >= 判定 —— 正好等于上限即停', () => {
    expect(exceededBatchBudget(19.99, 20)).toBe(false);
    expect(exceededBatchBudget(20, 20)).toBe(true);
    expect(exceededBatchBudget(20.01, 20)).toBe(true);
  });
});
