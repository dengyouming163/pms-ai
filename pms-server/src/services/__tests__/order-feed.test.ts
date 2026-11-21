// 合并列表的规范化：纯函数，无库。
// 🔴 夹具刻意让**两个来源的金额类型不同**（住宿 integer / 文旅 decimal-string）与
//    **状态词表不同**（pending_confirm vs refunding）—— 若夹具两边一样，
//    「有没有做映射/转换」这件事在任何判据里都看不见。
import { describe, it, expect } from 'vitest';
import { toUnifiedLodging, toUnifiedWenlv, sortUnified } from '../order-feed.js';

// 🔴 显式投影的夹具：上游 `GET /api/wenlv/orders` 返回的是**整行**订单 ——
//    pms-platform/pms-platform-server/src/routes/wenlv.ts:502 逐字是
//    `({ ...o, productName: nameMap.get(o.productId) ?? null })`（本仓根是 pms-server/，
//    该文件在兄弟目录下），而 pms_platform_wenlv_orders 行内含 leaderCode（= 核销凭据）、
//    miniUserId、transactionId。夹具**必须**带这些列 —— 否则「`{ ...row }` 把整行捎给 C 端」
//    这种泄漏在任何断言里都看不见（判别力寄存在夹具默认值上）。
const WENLV_ROW_FULL = {
  id: 'w-full', orderNo: 'WENLV-FULL', productName: '龙门谜案', totalAmount: '88.00',
  quantity: 1, seatCount: 2, slotId: 's1', status: 'paid', paymentStatus: 'paid',
  createdAt: '2026-09-26T07:00:00Z', payDeadline: null,
  leaderCode: 'LC-SECRET-1', miniUserId: 'u-1', transactionId: 'txn-1',
};
const LODGING_ROW_FULL = {
  id: 'o-full', orderNo: 'BUI-FULL', roomType: '大床房', checkIn: '2026-10-01', checkOut: '2026-10-03',
  nights: 2, totalPrice: 120, status: 'pending_confirm', paymentStatus: 'unpaid', guestName: '张三',
  payDeadline: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:00:00Z'),
  leaderCode: 'LC-SECRET-2', miniUserId: 'u-1', transactionId: 'txn-2',
};
// 统一形状顶层的**精确**键集合。任何 `{ ...row }` 式写法都会在这里多出键 ⇒ 红。
const UNIFIED_KEYS = ['type', 'id', 'orderNo', 'title', 'amount', 'status', 'paymentStatus', 'createdAt', 'payDeadline', 'extra'];

describe('统一订单形状', () => {
  it('住宿 → 统一形状：金额 String 化（integer → "120"），标题 = 门店名 · 房型', () => {
    const row = {
      id: 'o1', orderNo: 'BUI1', roomType: '大床房', checkIn: '2026-10-01', checkOut: '2026-10-03',
      nights: 2, totalPrice: 120, status: 'pending_confirm', paymentStatus: 'unpaid',
      guestName: '张三', payDeadline: new Date('2026-09-26T10:00:00Z'), createdAt: new Date('2026-09-26T09:00:00Z'),
    };
    const u = toUnifiedLodging(row, '龙门客栈');
    expect(u.type).toBe('lodging');
    expect(u.title).toBe('龙门客栈 · 大床房');
    expect(u.amount, 'amount 必须是字符串口径（与文旅侧一致）').toBe('120');
    expect(typeof u.amount).toBe('string');
    // 🔴 状态**原样透传**：住宿的 pending_confirm 不得被映射成文旅的某个词
    expect(u.status).toBe('pending_confirm');
    expect(u.createdAt).toBe('2026-09-26T09:00:00.000Z');
    expect(u.payDeadline).toBe('2026-09-26T10:00:00.000Z');
    expect(u.extra).toMatchObject({ checkIn: '2026-10-01', checkOut: '2026-10-03', nights: 2 });
  });

  it('住宿 → 门店名缺失时退回房型，房型也缺失时给兜底文案（不产出 "null · null"）', () => {
    const base = { id: 'o2', orderNo: 'BUI2', roomType: '标间', checkIn: 'x', checkOut: 'y', nights: 1, totalPrice: 50, status: 'confirmed', paymentStatus: 'paid', guestName: '李四', payDeadline: null, createdAt: '2026-09-26T08:00:00Z' };
    expect(toUnifiedLodging(base, null).title).toBe('标间');
    expect(toUnifiedLodging({ ...base, roomType: null }, null).title).toBe('住宿订单');
    expect(toUnifiedLodging(base, null).payDeadline).toBeNull();
  });

  it('文旅 → 统一形状：decimal 字符串原样保留（不 Number 化），标题 = 产品名', () => {
    const u = toUnifiedWenlv({
      id: 'w1', orderNo: 'WENLV1', productName: '龙门谜案', totalAmount: '120.00', quantity: 1, seatCount: 2,
      status: 'refunded', paymentStatus: 'refunded', slotId: 's1', createdAt: '2026-09-26T07:00:00Z', payDeadline: null,
    });
    expect(u.type).toBe('wenlv');
    expect(u.title).toBe('龙门谜案');
    // 🔴 不得写成 Number(u.amount)：`'120.00'` → `120` 会丢格式，而金额是 decimal 字符串口径
    expect(u.amount).toBe('120.00');
    expect(u.status).toBe('refunded');
    expect(u.extra).toMatchObject({ quantity: 1, seatCount: 2, slotId: 's1' });
  });

  it('文旅 → 产品名缺失时兜底', () => {
    expect(toUnifiedWenlv({ id: 'w2', orderNo: 'W', productName: null, totalAmount: '10.00', createdAt: '2026-09-26T07:00:00Z' }).title).toBe('文旅订单');
  });

  it('🔴 文旅侧是**显式投影**：顶层键集合精确（leaderCode 不得在顶层），extra 恰为四键（含 spec §4.2 故意加的 leaderCode）', () => {
    const u = toUnifiedWenlv(WENLV_ROW_FULL);
    expect(Object.keys(u).sort(), '顶层多出键 ⇒ 上游整行（含 leaderCode）被捎给了 C 端').toEqual([...UNIFIED_KEYS].sort());
    expect(Object.keys(u.extra).sort(), 'extra 键集合必须精确 ⇒ 多一个少一个都是投影漂移').toEqual(['leaderCode', 'quantity', 'seatCount', 'slotId'].sort());
    // 显式点名：leaderCode 是核销凭据，**只**准许出现在 extra、**绝不**在顶层 —— 顶层是整行展开的现形处
    expect(Object.keys(u), 'leaderCode 不得出现在顶层').not.toContain('leaderCode');
    expect(u.extra.leaderCode, 'extra.leaderCode 必须是本行的值（不是 undefined、不是被顺手剥掉）').toBe('LC-SECRET-1');
  });

  it('🔴 住宿侧同样是显式投影：键集合精确（db 行的其它列不许捎出去）', () => {
    const u = toUnifiedLodging(LODGING_ROW_FULL, '龙门客栈');
    expect(Object.keys(u).sort()).toEqual([...UNIFIED_KEYS].sort());
    expect(Object.keys(u.extra).sort()).toEqual(['checkIn', 'checkOut', 'guestName', 'nights'].sort());
    expect(Object.keys(u)).not.toContain('leaderCode');
  });

  it('🔴 createdAt 非法/缺失 ⇒ 空串，**不抛**（一条坏数据不该让整页 500）', () => {
    for (const bad of ['不是时间', '', null, undefined]) {
      const row = { id: 'w-bad', orderNo: 'N', productName: 'P', totalAmount: '1.00', createdAt: bad };
      expect(() => toUnifiedWenlv(row), `createdAt=${String(bad)} 时不得抛`).not.toThrow();
      expect(toUnifiedWenlv(row).createdAt, `createdAt=${String(bad)} 该落成空串`).toBe('');
    }
    const lodging = {
      id: 'o-bad', orderNo: 'N', roomType: 'R', checkIn: '', checkOut: '', nights: 1,
      totalPrice: 1, status: 'x', paymentStatus: 'y', guestName: 'G', createdAt: '不是时间',
    };
    expect(() => toUnifiedLodging(lodging, 'S')).not.toThrow();
    expect(toUnifiedLodging(lodging, 'S').createdAt).toBe('');
  });

  it('🔴 排序：两个来源按 createdAt 归并降序（不是「先文旅后住宿」）', () => {
    const mk = (type: 'wenlv' | 'lodging', at: string) => (type === 'wenlv'
      ? toUnifiedWenlv({ id: type + at, orderNo: 'N', productName: 'P', totalAmount: '1.00', createdAt: at })
      : toUnifiedLodging({ id: type + at, orderNo: 'N', roomType: 'R', checkIn: '', checkOut: '', nights: 1, totalPrice: 1, status: 'x', paymentStatus: 'y', guestName: 'G', payDeadline: null, createdAt: at }, 'S'));
    const rows = [
      mk('lodging', '2026-09-26T05:00:00Z'),
      mk('wenlv', '2026-09-26T09:00:00Z'),
      mk('lodging', '2026-09-26T07:00:00Z'),
    ];
    expect(sortUnified(rows).map((r) => r.createdAt)).toEqual([
      '2026-09-26T09:00:00.000Z', '2026-09-26T07:00:00.000Z', '2026-09-26T05:00:00.000Z',
    ]);
  });

  it('排序不对输入数组就地改写（返回新数组）', () => {
    const a = toUnifiedWenlv({ id: '1', orderNo: 'N', productName: 'P', totalAmount: '1.00', createdAt: '2026-09-26T01:00:00Z' });
    const b = toUnifiedWenlv({ id: '2', orderNo: 'N', productName: 'P', totalAmount: '1.00', createdAt: '2026-09-26T02:00:00Z' });
    const input = [a, b];
    expect(sortUnified(input).map((r) => r.id)).toEqual(['2', '1']);
    expect(input.map((r) => r.id), '原数组被就地 sort ⇒ 调用方的变量顺序被偷偷改掉').toEqual(['1', '2']);
  });

  it('🔴 时间解析不出来的行排**最后**（哨兵写反 ⇒ 坏数据霸榜最前）', () => {
    const good = toUnifiedWenlv({ id: 'good', orderNo: 'N', productName: 'P', totalAmount: '1.00', createdAt: '2026-09-26T01:00:00Z' });
    const bad = toUnifiedWenlv({ id: 'bad', orderNo: 'N', productName: 'P', totalAmount: '1.00', createdAt: '不是时间' });
    expect(bad.createdAt, '夹具前提：非法时间确实落成空串（否则本判据判别不到坏行）').toBe('');
    expect(sortUnified([bad, good]).map((r) => r.id), '坏行必须排在合法行之后').toEqual(['good', 'bad']);
    expect(sortUnified([good, bad]).map((r) => r.id), '名次与输入位置无关').toEqual(['good', 'bad']);
  });

  it('🔴 时间解析不出来的行排**任何**可解析行之后（含 pre-1970 的负 epoch 行）', () => {
    // 去掉这条用例，哨兵写回 `-1` 就重新变成**不可判**：上面那条用例的夹具只有 1970 之后的
    // 行，`-1` 恰好比它们都小 ⇒ 它照样绿。而「坏行排最后」这条声明要无条件成立，就必须让
    // 哨兵是**下确界**；`-1` 不是下确界 —— pre-1970 的合法时间戳是负值，比 `-1` 还小，
    // 坏行会被插到那种行**前面**。（pre-1970 那一行写的是**字面 ISO 日期串**
    // `'1960-01-01T00:00:00.000Z'`，不是 `Date.now() - N` 之类的算术拼法 ——
    // 负 epoch 由 `expect(Date.parse(old.createdAt), …)` 那句算出，**文件里不存在负数字面量**。）
    const mk = (id: string, at: string | Date) => toUnifiedWenlv({ id, orderNo: 'N', productName: 'P', totalAmount: '1.00', createdAt: at });
    const modern = mk('modern-2026', '2026-09-26T01:00:00Z');
    const old = mk('old-1960', new Date('1960-01-01T00:00:00.000Z'));
    const bad = mk('bad', '不是时间');
    expect(Date.parse(old.createdAt), '夹具前提：pre-1970 行的 epoch 必须是负数，否则本判据构造上到不了那一支').toBeLessThan(0);
    expect(bad.createdAt, '夹具前提：非法时间确实落成空串（否则本判据判别不到坏行）').toBe('');
    // 判别力分工（两条都别删）：O1 = `sortUnified([bad, old, modern])` 那条，是承重的
    // （「好行不排序 / 只排一趟」这类退化只有它抓得到）；O2 = `sortUnified([modern, bad, old])` 那条，
    // 抓的是另一条轴（输入位置依赖）—— O1 绿而 O2 红的那种退化只有它挡得住。
    expect(sortUnified([bad, old, modern]).map((r) => r.id), '坏行必须排在 pre-1970 行**之后**，不能只排在 1970 之后的行之后').toEqual(['modern-2026', 'old-1960', 'bad']);
    expect(sortUnified([modern, bad, old]).map((r) => r.id), '名次与输入位置无关').toEqual(['modern-2026', 'old-1960', 'bad']);
  });
});
