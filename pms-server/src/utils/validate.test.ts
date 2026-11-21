import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { validateBody } from './validate';

const orderSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('confirm'), orderId: z.string().min(1) }),
  z.object({ action: z.literal('cancel'), orderId: z.string().min(1), reason: z.string().optional() }),
]);

describe('validateBody', () => {
  it('校验通过的合法数据应返回success', async () => {
    const result = await validateBody({ action: 'confirm', orderId: 'order-1' }, orderSchema);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.action).toBe('confirm');
      expect(result.data.orderId).toBe('order-1');
    }
  });

  it('缺少必填字段应返回校验失败', async () => {
    const result = await validateBody({ action: 'confirm' }, orderSchema);
    expect(result.success).toBe(false);
  });

  it('非法action值应返回校验失败', async () => {
    const result = await validateBody({ action: 'invalid' }, orderSchema);
    expect(result.success).toBe(false);
  });

  it('可选字段不传应正常通过', async () => {
    const result = await validateBody({ action: 'cancel', orderId: 'order-2' }, orderSchema);
    expect(result.success).toBe(true);
  });
});
