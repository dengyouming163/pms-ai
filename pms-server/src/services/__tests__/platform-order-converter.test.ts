import { describe, it, expect } from 'vitest';
import { addDays, resolvePlatformRoomType, buildPlatformStayOrder, shouldUpdateStayStatus, pickConfirmedForConversion } from '../platform-order-converter.js';

function makeOrder(over: Record<string, any> = {}) {
  return {
    id: 'po_1', orderNo: 'PROD202608110001', storeId: 'store_1', productId: 'prod_1',
    miniUserId: 'mini_1', guestName: '张三', guestPhone: '13800000001',
    productName: '豪华大床房套餐', roomNights: 2, quantity: 1,
    totalAmount: '299', reservationDate: '2026-08-20', verifyCode: '123456',
    status: 'platform_approved', reservationStatus: 'confirmed',
    ...over,
  };
}

describe('addDays（北京时区日期加法）', () => {
  it('普通跨天', () => expect(addDays('2026-08-20', 2)).toBe('2026-08-22'));
  it('跨月', () => expect(addDays('2026-08-31', 1)).toBe('2026-09-01'));
  it('跨年', () => expect(addDays('2026-12-31', 2)).toBe('2027-01-02'));
});

describe('resolvePlatformRoomType（房型解析三路径）', () => {
  const roomTypes = [
    { id: 'rt_a', name: '豪华大床房', basePrice: 600, status: 'active' },
    { id: 'rt_b', name: '双床房', basePrice: 400, status: 'active' },
  ];
  it('路径1：商品关联房型取第一个有效', () => {
    const r = resolvePlatformRoomType(['rt_b', 'rt_missing'], roomTypes, '任意');
    expect(r?.roomTypeId).toBe('rt_b');
    expect(r?.basePrice).toBe(400);
  });
  it('路径2：无关联时按 productName 精确匹配房型名', () => {
    const r = resolvePlatformRoomType([], roomTypes, '双床房');
    expect(r?.roomTypeId).toBe('rt_b');
    expect(r?.roomTypeName).toBe('双床房');
  });
  it('路径3：均无 → null', () => {
    const r = resolvePlatformRoomType([], roomTypes, '未知房型');
    expect(r).toBe(null);
  });
});

describe('buildPlatformStayOrder（金额双记 + 日期 + 字段）', () => {
  it('金额双记：totalPrice=实付，originalAmount=门市价×nights，discount 记差额', () => {
    const v = buildPlatformStayOrder(makeOrder(), { roomTypeId: 'rt_a', roomTypeName: '豪华大床房', basePrice: 600 });
    expect(v.totalPrice).toBe(299);
    expect(v.originalAmount).toBe(1200); // 600 × 2
    expect(v.discount).toContain('901');
    expect(v.status).toBe('confirmed');
    expect(v.source).toBe('platform');
    expect(v.paymentStatus).toBe('paid');
    expect(v.channel).toBe('私域平台');
  });
  it('日期：checkOut = reservationDate + roomNights', () => {
    const v = buildPlatformStayOrder(makeOrder(), null);
    expect(v.checkIn).toBe('2026-08-20');
    expect(v.checkOut).toBe('2026-08-22');
    expect(v.nights).toBe(2);
  });
  it('未映射房型：roomTypeId=null，roomType 用 productName，originalAmount=0', () => {
    const v = buildPlatformStayOrder(makeOrder({ roomNights: 1 }), null);
    expect(v.roomTypeId).toBe(null);
    expect(v.roomType).toBe('豪华大床房套餐');
    expect(v.originalAmount).toBe(0);
  });
  it('核销码透传 + remark 携带产品名与核销码', () => {
    const v = buildPlatformStayOrder(makeOrder(), null);
    expect(v.verifyCode).toBe('123456');
    expect(v.remark).toContain('豪华大床房套餐');
    expect(v.remark).toContain('123456');
  });
  it('追溯字段：platformOrderId=平台订单 id，channelOrderId=平台订单号', () => {
    const v = buildPlatformStayOrder(makeOrder(), null);
    expect(v.platformOrderId).toBe('po_1');
    expect(v.channelOrderId).toBe('PROD202608110001');
  });
  it('initialStatus 覆盖（核销联动场景：初始即 checked_in）', () => {
    const v = buildPlatformStayOrder(makeOrder(), null, { initialStatus: 'checked_in' });
    expect(v.status).toBe('checked_in');
  });
});

describe('shouldUpdateStayStatus（状态联动更新判定）', () => {
  it('相同状态不更新', () => expect(shouldUpdateStayStatus('checked_in', 'checked_in')).toBe(false));
  it('终态（cancelled/checked_out）不回退', () => {
    expect(shouldUpdateStayStatus('cancelled', 'checked_in')).toBe(false);
    expect(shouldUpdateStayStatus('checked_out', 'cancelled')).toBe(false);
  });
  it('confirmed → checked_in 可更新（核销联动）', () => expect(shouldUpdateStayStatus('confirmed', 'checked_in')).toBe(true));
  it('checked_in → cancelled 可更新（安全网）', () => expect(shouldUpdateStayStatus('checked_in', 'cancelled')).toBe(true));
});

describe('pickConfirmedForConversion（轮询补偿候选筛选）', () => {
  it('仅选 reservationStatus=confirmed 且 status 可转化（paid/platform_approved/store_accepted）', () => {
    const orders = [
      { id: 'a', status: 'paid', reservationStatus: 'confirmed' },
      { id: 'b', status: 'used', reservationStatus: 'confirmed' },
      { id: 'c', status: 'pending', reservationStatus: 'none' },
      { id: 'd', status: 'store_accepted', reservationStatus: 'confirmed' },
      { id: 'e', status: 'refunded', reservationStatus: 'confirmed' },
      { id: null },
    ];
    expect(pickConfirmedForConversion(orders).map((o: any) => o.id)).toEqual(['a', 'd']);
  });
});
