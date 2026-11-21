import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

describe('0071 rewards stock sku migration', () => {
  it('迁移文件存在且含文创商品字段', () => {
    const sql = readFileSync(join(__dirname, '../../../../drizzle/0071_wenlv_rewards_stock_sku.sql'), 'utf8');
    expect(sql).toContain('stock_limit');
    expect(sql).toContain('stock_used');
    expect(sql).toContain('merchandise_sku');
    expect(sql).toContain('pickup_enabled');
    expect(sql).toContain('delivery_enabled');
  });
  it('Dockerfile CMD 含 0071', () => {
    const dockerfile = readFileSync(join(__dirname, '../../../../Dockerfile'), 'utf8');
    expect(dockerfile).toContain('0071_wenlv_rewards_stock_sku.sql');
  });
});
