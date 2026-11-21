import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { pmsBuiOrders } from '../orders.js';

describe('pms_bui_orders 平台订单字段（0017 迁移）', () => {
  it('含 platform_order_id / platform_order_no / verify_code 三列', () => {
    expect(pmsBuiOrders.platformOrderId.name).toBe('platform_order_id');
    expect(pmsBuiOrders.platformOrderNo.name).toBe('platform_order_no');
    expect(pmsBuiOrders.verifyCode.name).toBe('verify_code');
  });

  it('迁移 SQL 与 schema 保持一致（防 schema↔SQL 漂移）', () => {
    const sqlText = readFileSync(
      new URL('../../../../drizzle/0017_add_platform_order_fields.sql', import.meta.url),
      'utf-8',
    );
    expect(sqlText).toContain('platform_order_id');
    expect(sqlText).toContain('platform_order_no');
    expect(sqlText).toContain('verify_code');
    expect(sqlText).toContain('uq_orders_platform_order');
    expect(sqlText).toContain('WHERE "platform_order_id" IS NOT NULL');
  });
});
