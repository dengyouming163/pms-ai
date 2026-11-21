import { describe, it, expect } from 'vitest';
import { buildStoreProductListQs } from '../product-orders.js';

describe('buildStoreProductListQs（员工端套餐订单列表转发参数）', () => {
  it('scope=pending → 透传 scope，不注入预约可见性', () => {
    const qs = buildStoreProductListQs({ storeId: 'store_1', scope: 'pending' });
    expect(qs.get('scope')).toBe('pending');
    expect(qs.get('reservationStatus')).toBe(null);
    expect(qs.get('storeId')).toBe('store_1');
  });
  it('scope=done → 透传 scope', () => {
    const qs = buildStoreProductListQs({ storeId: 'store_1', scope: 'done' });
    expect(qs.get('scope')).toBe('done');
    expect(qs.get('reservationStatus')).toBe(null);
  });
  it('未传 scope → 保持预约可见性（reservationStatus=confirmed|store_accepted）', () => {
    const qs = buildStoreProductListQs({ storeId: 'store_1' });
    expect(qs.get('scope')).toBe(null);
    expect(qs.get('reservationStatus')).toBe('confirmed|store_accepted');
  });
  it('未知 scope → 回退预约可见性', () => {
    const qs = buildStoreProductListQs({ storeId: 'store_1', scope: 'foo' });
    expect(qs.get('reservationStatus')).toBe('confirmed|store_accepted');
  });
});
