import { describe, it, expect } from 'vitest';
import { classifyRefundTarget } from '../refund-target.js';

describe('classifyRefundTarget', () => {
  it('po_ 前缀 → 平台套餐单', () => {
    expect(classifyRefundTarget({ orderId: 'po_abc', storeId: 'platform' })).toBe('platform-product');
  });

  it('po_ 前缀优先于 storeId（防套餐单被文旅分支抢走）', () => {
    // 若这条挂了，说明有人把顺序写反了 —— 套餐单会被当文旅单退，落定必然错
    expect(classifyRefundTarget({ orderId: 'po_xyz', storeId: 'platform' })).not.toBe('wenlv');
  });

  it('storeId=platform 且非 po_ → 文旅门票单', () => {
    expect(classifyRefundTarget({ orderId: '3f1a-uuid', storeId: 'platform' })).toBe('wenlv');
  });

  it('门店订单 → 住宿单', () => {
    expect(classifyRefundTarget({ orderId: 'SO123', storeId: 's1' })).toBe('stay');
    expect(classifyRefundTarget({ orderId: 'SO123', storeId: null })).toBe('stay');
    expect(classifyRefundTarget({ orderId: 'SO123' })).toBe('stay');
  });
});
