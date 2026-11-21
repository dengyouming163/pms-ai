// 入住订单平台端接口（规格 §7.1）：录入 / 历史补录 / 编辑 / 状态流转 / 流转日志 / 门店下拉。
// 挂载 /api/checkin-orders，JWT 鉴权（BFF 动态签发并携带真实操作人）。
// ⚠️ 既有 /api/checkin-h5/* 全部保持不动 —— 本文件只新增；状态机守卫只作用于本文件的
//    PATCH /:id/status（规格 §6「守卫作用范围」）。
import { Hono } from 'hono';
import { randomUUID } from 'crypto';
import { eq, and, or, like, gte, lte, desc, count, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiStores, pmsBuiCheckinOrders, pmsBuiCheckinOrderStatusLogs } from '../db/schema/index.js';
import { serverError } from '../lib/http-error.js';
import { generateOrderNo } from '../services/checkin-order/order-no.js';
import { toDateOrNull, nightsBetween } from '../services/checkin-order/date-normalize.js';
import {
  isCheckinOrderStatus, transitionError, requiredReasonField, CHECKIN_ORDER_STATUSES,
} from '../services/checkin-order/status-machine.js';
import type { AuthUser } from '../middleware/auth.js';

const route = new Hono<{ Variables: { authUser?: AuthUser } }>();

const SOURCE_VALUES = ['wechat', 'douyin', 'meituan', 'ctrip', 'xiaohongshu', 'private_mini', 'other'] as const;
const PAYMENT_VALUES = ['online', 'offline'] as const;

/** 操作人（审计用；权限全放开，此处仅留痕）。BFF 未带 name 时回落空串。 */
function operator(c: any): { id: string; name: string } {
  const u = c.get('authUser') as AuthUser | undefined;
  return { id: u?.userId || 'platform', name: u?.name || '' };
}

type AmountResult = { ok: true; value: string | null } | { ok: false; error: string };

/** 金额归一：空 → null；非数字或负数 → 错误（规格 §7.3） */
function parseAmount(v: unknown): AmountResult {
  if (v === undefined || v === null || v === '') return { ok: true, value: null };
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return { ok: false, error: '金额必须为非负数' };
  return { ok: true, value: n.toFixed(2) };
}

function parseCount(v: unknown, fallback: number, min: number): number | null {
  if (v === undefined || v === null || v === '') return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < min) return null;
  return n;
}

/** 写入日志（创建/补录/流转共用一处，避免三处各写一遍而漏字段） */
async function writeStatusLog(input: {
  orderId: string; fromStatus: string | null; toStatus: string;
  reason?: string | null; operatorId: string; operatorName: string; createdAt?: Date;
}) {
  await db.insert(pmsBuiCheckinOrderStatusLogs).values({
    id: `cksl_${randomUUID()}`,
    orderId: input.orderId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    reason: input.reason ?? null,
    operatorId: input.operatorId,
    operatorName: input.operatorName,
    ...(input.createdAt ? { createdAt: input.createdAt } : {}),
  });
}

// ============ GET /api/checkin-orders —— 列表 ============
route.get('/', async (c) => {
  try {
    const authUser = c.get('authUser');
    const merchantId = authUser?.merchantId || c.req.query().merchantId;
    const {
      keyword, storeId, status, source, createdChannel, isBackfill,
      startDate, endDate, limit: limitRaw, offset: offsetRaw,
    } = c.req.query();
    const limit = Math.min(Math.max(Number(limitRaw) || 20, 1), 200);
    const offset = Math.max(Number(offsetRaw) || 0, 0);

    const conditions: any[] = [];
    if (merchantId) conditions.push(eq(pmsBuiCheckinOrders.merchantId, merchantId));
    if (storeId) conditions.push(eq(pmsBuiCheckinOrders.storeId, String(storeId)));
    if (status) conditions.push(eq(pmsBuiCheckinOrders.status, String(status)));
    if (source) conditions.push(eq(pmsBuiCheckinOrders.source, String(source)));
    if (createdChannel) conditions.push(eq(pmsBuiCheckinOrders.createdChannel, String(createdChannel)));
    if (isBackfill === 'only') conditions.push(eq(pmsBuiCheckinOrders.isBackfill, true));
    if (isBackfill === 'exclude') conditions.push(eq(pmsBuiCheckinOrders.isBackfill, false));
    if (keyword) {
      conditions.push(or(
        like(pmsBuiCheckinOrders.guestName, `%${keyword}%`),
        like(pmsBuiCheckinOrders.guestPhone, `%${keyword}%`),
        like(pmsBuiCheckinOrders.orderNo, `%${keyword}%`),
      ));
    }
    if (startDate) conditions.push(gte(pmsBuiCheckinOrders.checkInDate, String(startDate)));
    if (endDate) conditions.push(lte(pmsBuiCheckinOrders.checkInDate, String(endDate)));

    const where = conditions.length ? and(...conditions) : undefined;
    const rows = await db.select().from(pmsBuiCheckinOrders)
      .where(where)
      .orderBy(desc(pmsBuiCheckinOrders.createdAt))
      .limit(limit).offset(offset);
    const [totalRow] = await db.select({ c: count() }).from(pmsBuiCheckinOrders).where(where);

    const storeIds = [...new Set(rows.map((r) => r.storeId).filter(Boolean))];
    let storeMap: Record<string, string> = {};
    if (storeIds.length) {
      const ss = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
        .from(pmsBuiStores).where(inArray(pmsBuiStores.id, storeIds));
      storeMap = Object.fromEntries(ss.map((s) => [s.id, s.name || s.id]));
    }
    const list = rows.map((r) => ({ ...r, storeName: storeMap[r.storeId] || r.storeId }));
    return c.json({ success: true, list, total: Number(totalRow?.c) || 0 });
  } catch (err: any) {
    return serverError(c, err, '订单查询失败');
  }
});

// ============ 校验共用：录入与补录的公共字段 ============
interface CommonFields {
  store: { id: string; merchantId: string | null };
  guestName: string; guestPhone: string;
  adultCount: number; childCount: number;
  roomType: string; roomNo: string | null; roomCount: number;
  checkInDate: string; checkOutDate: string; nights: number;
  totalAmount: string | null; depositAmount: string | null; settlementAmount: string | null;
  refundAmount: string | null; paymentMethod: string | null; source: string;
  channelOrderNo: string | null; staffName: string | null;
  contactName: string | null; contactPhone: string | null; remark: string | null;
  propertyId: string | null; customerPlatformId: string | null;
  checkInAt: Date | null; checkOutAt: Date | null;
}

type ParseResult = { ok: true; data: CommonFields } | { ok: false; error: string };

/** 规格 §7.3 的必填与边界校验，录入与补录共用一份 */
async function parseCommonFields(b: any): Promise<ParseResult> {
  const storeId = String(b?.storeId || '');
  if (!storeId) return { ok: false, error: '门店必填' };
  const [store] = await db
    .select({ id: pmsBuiStores.id, merchantId: pmsBuiStores.merchantId })
    .from(pmsBuiStores).where(eq(pmsBuiStores.id, storeId)).limit(1);
  if (!store) return { ok: false, error: '门店不存在' };

  const guestName = String(b?.guestName || '').trim();
  if (!guestName) return { ok: false, error: '入住人姓名必填' };
  const guestPhone = String(b?.guestPhone || '').trim();
  if (!guestPhone) return { ok: false, error: '联系电话必填' };

  const roomType = String(b?.roomType || '').trim();
  if (!roomType) return { ok: false, error: '房型必填' };

  const checkInDate = toDateOrNull(b?.checkInDate);
  if (!checkInDate) return { ok: false, error: '入住日期必填或格式非法' };
  const checkOutDate = toDateOrNull(b?.checkOutDate);
  if (!checkOutDate) return { ok: false, error: '退房日期必填或格式非法' };
  const nights = nightsBetween(checkInDate, checkOutDate);
  if (nights === null) return { ok: false, error: '退房日期不能早于入住日期' };

  const adultCount = parseCount(b?.adultCount, 1, 1);
  if (adultCount === null) return { ok: false, error: '成人数须为大于等于 1 的整数' };
  const childCount = parseCount(b?.childCount, 0, 0);
  if (childCount === null) return { ok: false, error: '儿童数须为大于等于 0 的整数' };
  const roomCount = parseCount(b?.roomCount, 1, 1);
  if (roomCount === null) return { ok: false, error: '房间数须为大于等于 1 的整数' };

  const total = parseAmount(b?.totalAmount);
  if (!total.ok) return { ok: false, error: total.error };
  const deposit = parseAmount(b?.depositAmount);
  if (!deposit.ok) return { ok: false, error: deposit.error };
  const settlement = parseAmount(b?.settlementAmount);
  if (!settlement.ok) return { ok: false, error: settlement.error };
  const refund = parseAmount(b?.refundAmount);
  if (!refund.ok) return { ok: false, error: refund.error };
  if (refund.value !== null && total.value !== null && Number(refund.value) > Number(total.value)) {
    return { ok: false, error: '退款金额不能大于订单总金额' };
  }

  const source = String(b?.source || 'wechat');
  if (!(SOURCE_VALUES as readonly string[]).includes(source)) return { ok: false, error: '非法的订单来源' };
  const paymentMethod = b?.paymentMethod ? String(b.paymentMethod) : null;
  if (paymentMethod && !(PAYMENT_VALUES as readonly string[]).includes(paymentMethod)) {
    return { ok: false, error: '非法的支付方式' };
  }

  const toDate = (v: unknown): Date | null => {
    if (v === undefined || v === null || v === '') return null;
    const d = new Date(String(v));
    return Number.isNaN(d.getTime()) ? null : d;
  };

  return {
    ok: true,
    data: {
      store: { id: store.id, merchantId: store.merchantId || 'default' },
      guestName, guestPhone, adultCount, childCount, roomType,
      roomNo: b?.roomNo ? String(b.roomNo) : null,
      roomCount, checkInDate, checkOutDate, nights,
      totalAmount: total.value, depositAmount: deposit.value, settlementAmount: settlement.value,
      refundAmount: refund.value, paymentMethod, source,
      channelOrderNo: b?.channelOrderNo ? String(b.channelOrderNo) : null,
      staffName: b?.staffName ? String(b.staffName) : null,
      contactName: b?.contactName ? String(b.contactName) : null,
      contactPhone: b?.contactPhone ? String(b.contactPhone) : null,
      remark: b?.remark ? String(b.remark) : null,
      propertyId: b?.propertyId ? String(b.propertyId) : null,
      customerPlatformId: b?.customerPlatformId ? String(b.customerPlatformId) : null,
      checkInAt: toDate(b?.checkInAt), checkOutAt: toDate(b?.checkOutAt),
    },
  };
}

// ============ POST /api/checkin-orders —— 订单录入 ============
// 默认落 booked（可显式指定）；orderNo 由当日序号派生，唯一冲突重试最多 3 次。
route.post('/', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = await parseCommonFields(body);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const f = parsed.data;

    const status = body?.status === undefined || body?.status === '' ? 'booked' : String(body.status);
    if (!isCheckinOrderStatus(status)) return c.json({ success: false, error: '非法的订单状态' }, 400);

    const op = operator(c);
    const now = new Date();
    let id = '';
    let lastErr: unknown = null;
    // 唯一索引兜底：捕获冲突后重新取序号，最多 3 次
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const orderNo = await generateOrderNo(now);
      id = `checkin_${randomUUID()}`;
      try {
        await db.insert(pmsBuiCheckinOrders).values({
          id, orderNo,
          createdChannel: 'platform', createdBy: op.id, createdByName: op.name, isBackfill: false,
          merchantId: f.store.merchantId || 'default', storeId: f.store.id,
          guestName: f.guestName, guestPhone: f.guestPhone,
          adultCount: f.adultCount, childCount: f.childCount,
          roomType: f.roomType, roomNo: f.roomNo, roomCount: f.roomCount,
          checkInDate: f.checkInDate, checkOutDate: f.checkOutDate, nights: f.nights,
          checkInAt: f.checkInAt, checkOutAt: f.checkOutAt,
          totalAmount: f.totalAmount, depositAmount: f.depositAmount,
          settlementAmount: f.settlementAmount, refundAmount: f.refundAmount,
          paymentMethod: f.paymentMethod, source: f.source,
          channelOrderNo: f.channelOrderNo, staffName: f.staffName,
          contactName: f.contactName, contactPhone: f.contactPhone, remark: f.remark,
          propertyId: f.propertyId, customerPlatformId: f.customerPlatformId,
          status, createdAt: now, updatedAt: now,
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as any)?.cause?.code ?? (err as any)?.code;
        if (code !== '23505') throw err; // 只重试唯一冲突，其余错误直接上抛
      }
    }
    if (lastErr) return serverError(c, lastErr, '订单号生成冲突，请重试');

    await writeStatusLog({
      orderId: id, fromStatus: null, toStatus: status,
      operatorId: op.id, operatorName: op.name, createdAt: now,
    });
    const [created] = await db
      .select({ orderNo: pmsBuiCheckinOrders.orderNo })
      .from(pmsBuiCheckinOrders).where(eq(pmsBuiCheckinOrders.id, id)).limit(1);
    return c.json({ success: true, id, orderNo: created?.orderNo || null });
  } catch (err: any) {
    return serverError(c, err, '订单录入失败');
  }
});

// ============ POST /api/checkin-orders/backfill —— 历史补录 ============
// 必传 status + createdAt（可回填历史业务时间）；创建时可直接落在任意状态，但同样写一条初始日志。
route.post('/backfill', async (c) => {
  try {
    const body = await c.req.json().catch(() => ({}));
    const parsed = await parseCommonFields(body);
    if (!parsed.ok) return c.json({ success: false, error: parsed.error }, 400);
    const f = parsed.data;

    const status = String(body?.status || '');
    if (!isCheckinOrderStatus(status)) return c.json({ success: false, error: '补录必须指定合法的订单状态' }, 400);

    const createdAtRaw = body?.createdAt;
    const createdAt = createdAtRaw ? new Date(String(createdAtRaw)) : null;
    if (!createdAt || Number.isNaN(createdAt.getTime())) {
      return c.json({ success: false, error: '补录必须指定录入时间' }, 400);
    }

    const op = operator(c);
    let id = '';
    let orderNo = '';
    let lastErr: unknown = null;
    // 唯一索引兜底：与 POST / 同一策略（规格 §6「捕获唯一冲突后重试，最多 3 次」）。
    // 补录同样按 createdAt 派生录入日，历史补录并发时同样可能撞号，故不省这段。
    for (let attempt = 0; attempt < 3; attempt += 1) {
      orderNo = await generateOrderNo(createdAt);
      id = `checkin_${randomUUID()}`;
      try {
        await db.insert(pmsBuiCheckinOrders).values({
          id, orderNo,
          createdChannel: 'backfill', createdBy: op.id, createdByName: op.name, isBackfill: true,
          merchantId: f.store.merchantId || 'default', storeId: f.store.id,
          guestName: f.guestName, guestPhone: f.guestPhone,
          adultCount: f.adultCount, childCount: f.childCount,
          roomType: f.roomType, roomNo: f.roomNo, roomCount: f.roomCount,
          checkInDate: f.checkInDate, checkOutDate: f.checkOutDate, nights: f.nights,
          checkInAt: f.checkInAt, checkOutAt: f.checkOutAt,
          totalAmount: f.totalAmount, depositAmount: f.depositAmount,
          settlementAmount: f.settlementAmount, refundAmount: f.refundAmount,
          paymentMethod: f.paymentMethod, source: f.source,
          channelOrderNo: f.channelOrderNo, staffName: f.staffName,
          contactName: f.contactName, contactPhone: f.contactPhone, remark: f.remark,
          propertyId: f.propertyId, customerPlatformId: f.customerPlatformId,
          status, createdAt, updatedAt: new Date(),
        });
        lastErr = null;
        break;
      } catch (err) {
        lastErr = err;
        const code = (err as any)?.cause?.code ?? (err as any)?.code;
        if (code !== '23505') throw err; // 只重试唯一冲突，其余错误直接上抛
      }
    }
    if (lastErr) return serverError(c, lastErr, '订单号生成冲突，请重试');

    await writeStatusLog({
      orderId: id, fromStatus: null, toStatus: status,
      reason: f.remark, operatorId: op.id, operatorName: op.name, createdAt,
    });
    return c.json({ success: true, id, orderNo });
  } catch (err: any) {
    return serverError(c, err, '历史补录失败');
  }
});

// ============ GET /api/checkin-orders/stores —— 门店下拉 ============
route.get('/stores', async (c) => {
  try {
    const authUser = c.get('authUser');
    const merchantId = authUser?.merchantId || c.req.query().merchantId;
    const conditions: any[] = [];
    if (merchantId) conditions.push(eq(pmsBuiStores.merchantId, merchantId));
    const list = await db
      .select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
      .from(pmsBuiStores)
      .where(conditions.length ? and(...conditions) : undefined)
      .orderBy(desc(pmsBuiStores.createdAt))
      .limit(500);
    return c.json({ success: true, list });
  } catch (err: any) {
    return serverError(c, err, '门店查询失败');
  }
});

// ============ GET /api/checkin-orders/:id/logs —— 流转日志（时间轴）============
route.get('/:id/logs', async (c) => {
  try {
    const id = c.req.param('id');
    const list = await db
      .select()
      .from(pmsBuiCheckinOrderStatusLogs)
      .where(eq(pmsBuiCheckinOrderStatusLogs.orderId, id))
      .orderBy(desc(pmsBuiCheckinOrderStatusLogs.createdAt));
    return c.json({ success: true, list });
  } catch (err: any) {
    return serverError(c, err, '流转日志查询失败');
  }
});

// ============ PATCH /api/checkin-orders/:id —— 编辑（仅非状态字段）============
route.patch('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const [order] = await db.select().from(pmsBuiCheckinOrders)
      .where(eq(pmsBuiCheckinOrders.id, id)).limit(1);
    if (!order) return c.json({ success: false, error: '订单不存在' }, 404);

    const updates: Record<string, any> = { updatedAt: new Date() };

    // 录入时间：显式传入时校验合法性，非法返回 400；不传则保持原值
    if (body?.createdAt !== undefined) {
      const t = new Date(String(body.createdAt));
      if (isNaN(t.getTime())) return c.json({ success: false, error: '录入时间格式不正确' }, 400);
      updates.createdAt = t;
    }
    // 最后更新时间：显式传入时覆盖默认 now，非法返回 400
    if (body?.updatedAt !== undefined) {
      const t = new Date(String(body.updatedAt));
      if (isNaN(t.getTime())) return c.json({ success: false, error: '最后更新时间格式不正确' }, 400);
      updates.updatedAt = t;
    }

    // 必填字段（§7.3）：录入时硬校验，编辑时同样不允许被清空（否则绕过必填约束）
    if (body?.guestName !== undefined) {
      const v = String(body.guestName || '').trim();
      if (!v) return c.json({ success: false, error: '入住人姓名必填' }, 400);
      updates.guestName = v;
    }
    if (body?.guestPhone !== undefined) {
      const v = String(body.guestPhone || '').trim();
      if (!v) return c.json({ success: false, error: '联系电话必填' }, 400);
      updates.guestPhone = v;
    }
    if (body?.roomType !== undefined) {
      const v = String(body.roomType || '').trim();
      if (!v) return c.json({ success: false, error: '房型必填' }, 400);
      updates.roomType = v;
    }
    if (body?.roomNo !== undefined) updates.roomNo = body.roomNo ? String(body.roomNo) : null;
    if (body?.staffName !== undefined) updates.staffName = body.staffName ? String(body.staffName) : null;
    if (body?.contactName !== undefined) updates.contactName = body.contactName ? String(body.contactName) : null;
    if (body?.contactPhone !== undefined) updates.contactPhone = body.contactPhone ? String(body.contactPhone) : null;
    if (body?.remark !== undefined) updates.remark = body.remark ? String(body.remark) : null;
    if (body?.channelOrderNo !== undefined) updates.channelOrderNo = body.channelOrderNo ? String(body.channelOrderNo) : null;
    if (body?.propertyId !== undefined) updates.propertyId = body.propertyId ? String(body.propertyId) : null;
    if (body?.customerPlatformId !== undefined) updates.customerPlatformId = body.customerPlatformId ? String(body.customerPlatformId) : null;

    if (body?.adultCount !== undefined) {
      const n = parseCount(body.adultCount, 1, 1);
      if (n === null) return c.json({ success: false, error: '成人数须为大于等于 1 的整数' }, 400);
      updates.adultCount = n;
    }
    if (body?.childCount !== undefined) {
      const n = parseCount(body.childCount, 0, 0);
      if (n === null) return c.json({ success: false, error: '儿童数须为大于等于 0 的整数' }, 400);
      updates.childCount = n;
    }
    if (body?.roomCount !== undefined) {
      const n = parseCount(body.roomCount, 1, 1);
      if (n === null) return c.json({ success: false, error: '房间数须为大于等于 1 的整数' }, 400);
      updates.roomCount = n;
    }

    // 日期：改动其一即按新值对重算 nights；两者都为空则 nights 保持原值
    if (body?.checkInDate !== undefined || body?.checkOutDate !== undefined) {
      const inD = body?.checkInDate !== undefined ? toDateOrNull(body.checkInDate) : order.checkInDate;
      const outD = body?.checkOutDate !== undefined ? toDateOrNull(body.checkOutDate) : order.checkOutDate;
      if (!inD || !outD) return c.json({ success: false, error: '入住与退房日期均须为合法日期' }, 400);
      const n = nightsBetween(inD, outD);
      if (n === null) return c.json({ success: false, error: '退房日期不能早于入住日期' }, 400);
      updates.checkInDate = inD;
      updates.checkOutDate = outD;
      updates.nights = n;
    }

    const amounts: [string, unknown][] = [
      ['totalAmount', body?.totalAmount], ['depositAmount', body?.depositAmount],
      ['settlementAmount', body?.settlementAmount], ['refundAmount', body?.refundAmount],
    ];
    for (const [key, value] of amounts) {
      if (body?.[key] === undefined) continue;
      const r = parseAmount(value);
      if (!r.ok) return c.json({ success: false, error: r.error }, 400);
      updates[key] = r.value;
    }
    // 退款金额 ≤ 总金额（用生效值比对：改了就用新值，没改就用库里现值）
    const effTotal = updates.totalAmount !== undefined ? updates.totalAmount : order.totalAmount;
    const effRefund = updates.refundAmount !== undefined ? updates.refundAmount : order.refundAmount;
    if (effRefund !== null && effRefund !== undefined && effTotal !== null && effTotal !== undefined
        && Number(effRefund) > Number(effTotal)) {
      return c.json({ success: false, error: '退款金额不能大于订单总金额' }, 400);
    }

    if (body?.source !== undefined && body.source !== '' && body.source !== null) {
      if (!(SOURCE_VALUES as readonly string[]).includes(String(body.source))) {
        return c.json({ success: false, error: '非法的订单来源' }, 400);
      }
      updates.source = String(body.source);
    }
    if (body?.paymentMethod !== undefined) {
      if (body.paymentMethod !== '' && body.paymentMethod !== null
          && !(PAYMENT_VALUES as readonly string[]).includes(String(body.paymentMethod))) {
        return c.json({ success: false, error: '非法的支付方式' }, 400);
      }
      updates.paymentMethod = body.paymentMethod === '' || body.paymentMethod === null ? null : String(body.paymentMethod);
    }
    const toDateTime = (v: unknown): Date | null => {
      if (v === undefined || v === null || v === '') return null;
      const d = new Date(String(v));
      return Number.isNaN(d.getTime()) ? null : d;
    };
    if (body?.checkInAt !== undefined) updates.checkInAt = toDateTime(body.checkInAt);
    if (body?.checkOutAt !== undefined) updates.checkOutAt = toDateTime(body.checkOutAt);

    // 显式拒绝通过本端点改状态：状态只能走 PATCH /:id/status（规格 §6）
    if (body?.status !== undefined) {
      return c.json({ success: false, error: '状态变更请使用状态流转接口' }, 400);
    }

    await db.update(pmsBuiCheckinOrders).set(updates).where(eq(pmsBuiCheckinOrders.id, id));
    return c.json({ success: true });
  } catch (err: any) {
    return serverError(c, err, '订单更新失败');
  }
});

// ============ PATCH /api/checkin-orders/:id/status —— 状态流转（守卫 + 日志）============
route.patch('/:id/status', async (c) => {
  try {
    const id = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const to = String(body?.status || '');
    if (!isCheckinOrderStatus(to)) return c.json({ success: false, error: '非法的订单状态' }, 400);

    const [order] = await db.select().from(pmsBuiCheckinOrders)
      .where(eq(pmsBuiCheckinOrders.id, id)).limit(1);
    if (!order) return c.json({ success: false, error: '订单不存在' }, 404);

    const err = transitionError(order.status, to);
    if (err) return c.json({ success: false, error: err }, 400);

    const reasonField = requiredReasonField(to);
    const reason = body?.reason ? String(body.reason).trim() : '';
    if (reasonField && !reason) {
      return c.json({ success: false, error: to === 'cancelled' ? '请填写取消原因' : '请填写退款原因' }, 400);
    }

    const op = operator(c);
    const now = new Date();
    const updates: Record<string, any> = { status: to, updatedAt: now };
    if (reasonField) updates[reasonField] = reason;
    // 实际时刻打点：转入 checked_in / checked_out 时若未记录则自动补当前时间（规格 §5.1 的 check_in_at / check_out_at）
    if (to === 'checked_in' && !order.checkInAt) updates.checkInAt = now;
    if (to === 'checked_out' && !order.checkOutAt) updates.checkOutAt = now;

    await db.update(pmsBuiCheckinOrders).set(updates).where(eq(pmsBuiCheckinOrders.id, id));
    await writeStatusLog({
      orderId: id, fromStatus: order.status, toStatus: to,
      reason: reason || null, operatorId: op.id, operatorName: op.name, createdAt: now,
    });
    return c.json({ success: true });
  } catch (err: any) {
    return serverError(c, err, '状态流转失败');
  }
});

export default route;
export { CHECKIN_ORDER_STATUSES };
