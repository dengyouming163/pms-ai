import { describe, it, expect } from 'vitest';
import { payableFen, PayOrderError } from '../pay-order.js';
import { parseOrderTimeout } from '../../routes/mini/pay-h5.js';

// ============================================================
// pay-order.ts / pay-h5.ts 纯函数单测（不触库：payableFen / parseOrderTimeout 均为纯函数）
// 金额口径与取价位置对齐支付流程：服务端取价，0 分/负值必须被拒绝（微信拒收 0 分单）
// ============================================================

describe('payableFen', () => {
  it('模式A 付订金（元→分）', () => {
    expect(payableFen({ mode: 'A', depositAmount: 100, totalAmount: 200 })).toBe(10000);
  });
  it('模式B 付全款', () => {
    expect(payableFen({ mode: 'B', totalAmount: 200 })).toBe(20000);
  });
  it('模式B 小数金额四舍五入到分', () => {
    expect(payableFen({ mode: 'B', totalAmount: 99.9 })).toBe(9990);
  });
  it('模式A 订金缺失 → 回退全款金额（与 pay-product 口径一致）', () => {
    expect(payableFen({ mode: 'A', totalAmount: 200 })).toBe(20000);
  });
  it('订金为 0 → 抛 400「订金金额无效」（防 0 分单）', () => {
    let err: any;
    try { payableFen({ mode: 'A', depositAmount: 0, totalAmount: 200 }); } catch (e) { err = e; }
    expect(err?.constructor).toBe(PayOrderError);
    expect(err?.status).toBe(400);
    expect(err?.message).toBe('订金金额无效');
  });
  it('全款为 0 → 抛 400「订单金额无效」', () => {
    let err: any;
    try { payableFen({ mode: 'B', totalAmount: 0 }); } catch (e) { err = e; }
    expect(err?.constructor).toBe(PayOrderError);
    expect(err?.status).toBe(400);
    expect(err?.message).toBe('订单金额无效');
  });
  it('负值 → 抛 400「订单金额无效」', () => {
    let err: any;
    try { payableFen({ mode: 'B', totalAmount: -5 }); } catch (e) { err = e; }
    expect(err?.constructor).toBe(PayOrderError);
    expect(err?.status).toBe(400);
  });
});

describe('parseOrderTimeout', () => {
  it('Date 输入原样返回（同一时刻）', () => {
    const d = new Date('2026-07-15T10:00:00.000Z');
    const r = parseOrderTimeout({ otaTimeout: d });
    expect(r?.constructor).toBe(Date);
    expect(r?.getTime()).toBe(d.getTime());
  });
  it('ISO 字符串（payDeadline）→ 解析为 Date', () => {
    const r = parseOrderTimeout({ payDeadline: '2026-07-15T10:00:00.000Z' });
    expect(r?.getTime()).toBe(new Date('2026-07-15T10:00:00.000Z').getTime());
  });
  it('naive 字符串 → 可解析为 Date', () => {
    expect(parseOrderTimeout({ payDeadline: '2026-07-15 10:00:00' })?.constructor).toBe(Date);
  });
  it('无效时间 → undefined（NaN 兜底）', () => {
    expect(parseOrderTimeout({ otaTimeout: 'not-a-date' })).toBe(undefined);
  });
  it('无超时字段 → undefined', () => {
    expect(parseOrderTimeout({})).toBe(undefined);
  });
  it('otaTimeout 优先于 payDeadline', () => {
    const d = new Date('2026-07-15T10:00:00.000Z');
    const r = parseOrderTimeout({ otaTimeout: d, payDeadline: '2026-07-15T11:00:00.000Z' });
    expect(r?.getTime()).toBe(d.getTime());
  });
});
