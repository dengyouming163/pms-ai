// order-feed 的第三类形状（套餐产品单）与文旅侧新增的 leaderCode。
// 纯函数层，无需 DB ⇒ 本文件不加 RUN_DB 闸。
import { describe, it, expect } from 'vitest';
import { toUnifiedProduct, toUnifiedWenlv, toUnifiedLodging, sortUnified } from '../order-feed.js';

/** 平台 pms_platform_product_orders 的一行（列名照 db/schema/product-orders.ts）。
 *  ⚠️ 两个状态列**刻意取不同值**（`platform_approved` / `paid`）：同值 ⇒ 把 mapper 里这两列写反也照样绿。
 *  末尾四列是平台行里**真有**的敏感列 —— 夹具不带它们，「`{ ...row }` 把整行捎出去」这种泄漏
 *  在任何断言里都看不见（同 `order-feed.test.ts` 头部「判别力寄存在夹具默认值上」那条的理由）。 */
const productRow = {
  id: 'po-1', orderNo: 'PRD-1', productName: '黔村院子·两日解谜套餐', storeId: 'st-1',
  totalAmount: '1088.00', status: 'platform_approved', paymentStatus: 'paid',
  createdAt: '2026-09-20T02:00:00.000Z', payDeadline: null,
  reservationStatus: 'confirmed', roomNights: 2, quantity: 1, reservationDate: '2026-10-01',
  mode: 'A', depositAmount: '288.00',
  miniUserId: 'mu-9', guestPhone: '13800000000', verifyCode: '135790', transactionId: 'tx-1',
};

describe('toUnifiedProduct', () => {
  it('顶层字段按表映射，金额是字符串（本层绝不做算术）', () => {
    const o = toUnifiedProduct(productRow);
    expect(o.type).toBe('product');
    expect(o.id).toBe('po-1');
    expect(o.orderNo).toBe('PRD-1');
    expect(o.title).toBe('黔村院子·两日解谜套餐');
    expect(o.amount).toBe('1088.00');
    expect(o.status).toBe('platform_approved');
    expect(o.paymentStatus).toBe('paid');
    expect(o.createdAt).toBe('2026-09-20T02:00:00.000Z');
    expect(o.payDeadline).toBeNull();
  });

  it('🔴 与另外两类一样是**显式投影**：顶层与 extra 的键集合都必须精确', () => {
    const o = toUnifiedProduct(productRow);
    expect(Object.keys(o).sort(), '顶层多出键 ⇒ `{ ...row }` 式写法把 miniUserId / guestPhone / verifyCode / transactionId 带出去了')
      .toEqual(['type', 'id', 'orderNo', 'title', 'amount', 'status', 'paymentStatus', 'createdAt', 'payDeadline', 'extra'].sort());
    expect(Object.keys(o.extra).sort(), 'extra 多出键 ⇒ 敏感列被具名带出去了')
      .toEqual(['storeId', 'reservationStatus', 'roomNights', 'quantity', 'reservationDate', 'mode', 'depositAmount'].sort());
  });

  it('extra 带上 C 端要用的全部键（缺一个 ⇒ 新订单页上那个动作静默消失）', () => {
    const o = toUnifiedProduct(productRow);
    expect(o.extra).toMatchObject({
      storeId: 'st-1',                 // 入住指南的入参
      reservationStatus: 'confirmed',  // 预约标识 / 去预约按钮
      roomNights: 2, quantity: 1,      // 日期行 N晚 / ×N
      reservationDate: '2026-10-01',
      mode: 'A', depositAmount: '288.00', // 订单行金额显示「订金 ¥x」与「订金锁定」标识
    });
  });

  it('productName 缺失 ⇒ 标题兜底（照 toUnifiedWenlv 的写法）', () => {
    expect(toUnifiedProduct({ ...productRow, productName: null }).title).toBe('套餐订单');
  });

  it('可选列缺失 ⇒ 落 null，不落 undefined（undefined 过不了 JSON，会静默丢键）', () => {
    const o = toUnifiedProduct({ id: 'po-2', orderNo: 'PRD-2' } as any);
    expect(o.extra.storeId).toBeNull();
    expect(o.extra.reservationStatus).toBeNull();
    expect(o.extra.depositAmount).toBeNull();
  });
});

describe('toUnifiedWenlv 补 leaderCode', () => {
  it('有码 ⇒ 原样带出；无码 ⇒ null（能力码，缺失必须是显式 null）', () => {
    expect(toUnifiedWenlv({ id: 'w-1', orderNo: 'W-1', leaderCode: 'LK-9F2A' }).extra.leaderCode).toBe('LK-9F2A');
    expect(toUnifiedWenlv({ id: 'w-1', orderNo: 'W-1' }).extra.leaderCode).toBeNull();
  });

  it('既有三个键一个都不能少（只增键的契约）', () => {
    expect(toUnifiedWenlv({ id: 'w-1', orderNo: 'W-1', quantity: 2, seatCount: 3, slotId: 's1' }).extra)
      .toMatchObject({ quantity: 2, seatCount: 3, slotId: 's1' });
  });
});

describe('房型侧一个新键都不加', () => {
  it('extra 仍恰是那四个键', () => {
    const o = toUnifiedLodging({ id: 'l-1', orderNo: 'L-1', roomType: '大床房' }, '某客栈');
    expect(Object.keys(o.extra).sort()).toEqual(['checkIn', 'checkOut', 'guestName', 'nights']);
  });
});

describe('三类混排仍按 createdAt 降序', () => {
  it('product / lodging / wenlv 同排，时间解析不出的行仍在最后', () => {
    const list = sortUnified([
      toUnifiedLodging({ id: 'l', orderNo: 'L', createdAt: new Date('2026-09-22T00:00:00Z') }, null),
      toUnifiedWenlv({ id: 'w', orderNo: 'W', createdAt: '2026-09-23T00:00:00Z' }),
      toUnifiedProduct({ id: 'p', orderNo: 'P', createdAt: '2026-09-21T00:00:00Z' }),
      toUnifiedProduct({ id: 'bad', orderNo: 'BAD', createdAt: '不是时间' }),
    ]);
    expect(list.map((o) => o.id)).toEqual(['w', 'l', 'p', 'bad']);
  });
});
