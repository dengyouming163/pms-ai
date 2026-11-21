import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiPromoters, pmsBuiReferralBindings, pmsBuiCommissionRecords, pmsBuiDistributionConfig, pmsBuiCustomers } from '../db/schema/index.js';
import { calcCommission } from '../utils/commission.js';

// ============================================================
// 二级分销引擎：下单即分销 / 二级绑定 / 佣金冻结与回收
// 佣金率单位：万分比（500 = 5%）
// ============================================================

/** 分销配置行（读全表取 id='default' 单行） */
export interface DistConfig {
  enabled: boolean;
  defaultLv1Rate: number;
  defaultLv2Rate: number;
}

/** 套餐分销配置（来自 products.extraAttrs.distributionConfig） */
export interface ProductDistConfig {
  enabled?: boolean;
  lv1Rate?: number;
  lv2Rate?: number;
}

/** 解析每层佣金率（万分比）。返回 null 表示不产生佣金 */
export function resolveDistRates(
  cfg: DistConfig,
  product: { distributionConfig?: ProductDistConfig | null },
): { lv1: number; lv2: number } | null {
  if (!cfg.enabled) return null;
  const pc = product?.distributionConfig;
  if (pc && pc.enabled === false) return null;
  return {
    lv1: (pc?.lv1Rate ?? cfg.defaultLv1Rate),
    lv2: (pc?.lv2Rate ?? cfg.defaultLv2Rate),
  };
}

/** 按万分比算佣金（分），向下取整 */
export function calcDistCommission(orderAmountFen: number, rateWan: number): number {
  return calcCommission(orderAmountFen, rateWan);
}

/** 读取平台级分销配置（id='default'），无记录返回默认 */
export async function getDistConfig(): Promise<DistConfig> {
  const [cfg] = await db.select().from(pmsBuiDistributionConfig).where(eq(pmsBuiDistributionConfig.id, 'default')).limit(1);
  return cfg ?? { enabled: true, defaultLv1Rate: 500, defaultLv2Rate: 200 };
}

/** 生成唯一推广码 */
export function genPromoCode(): string {
  return `P${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}

/**
 * 下单即分销：确保用户在该门店存在 promoter（无则创建 level=1、status=active）。
 * 返回 promoter（含新建）。
 */
export async function ensurePromoter(miniUserId: string, storeId: string) {
  const [existing] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.storeId, storeId), eq(pmsBuiPromoters.miniUserId, miniUserId))).limit(1);
  if (existing) return existing;

  const [created] = await db.insert(pmsBuiPromoters).values({
    id: `pro_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    merchantId: 'default',
    storeId,
    miniUserId,
    status: 'active',
    level: 1,
    promoCode: genPromoCode(),
  }).returning();
  return created;
}

/**
 * 按推广码绑定上级（下单时调用）。先到先得 + 30 天保护期，不覆盖既有绑定。
 * 返回绑定到的上级 promoter，未绑定返回 null。
 */
export async function bindByPromoCode(miniUserId: string, storeId: string, promoCode: string) {
  const [parent] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.promoCode, promoCode), eq(pmsBuiPromoters.status, 'active'))).limit(1);
  if (!parent) return null;
  if (parent.miniUserId === miniUserId) return null; // 禁止自我推荐

  const [existing] = await db.select().from(pmsBuiReferralBindings)
    .where(and(eq(pmsBuiReferralBindings.storeId, storeId), eq(pmsBuiReferralBindings.miniUserId, miniUserId))).limit(1);
  if (existing) return parent;

  const protectedUntil = new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10);
  await db.insert(pmsBuiReferralBindings).values({
    id: `rb_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    promoterId: parent.id,
    miniUserId,
    storeId,
    protectedUntil,
  });
  return parent;
}

/** 绑定后回填 promoter 的上级关系（二级分销 + 团队树用）。幂等：已有 parentPromoterId 不覆盖 */
export async function applyParentBinding(miniUserId: string, storeId: string): Promise<void> {
  const [binding] = await db.select().from(pmsBuiReferralBindings)
    .where(and(eq(pmsBuiReferralBindings.miniUserId, miniUserId), eq(pmsBuiReferralBindings.storeId, storeId))).limit(1);
  if (!binding) return;

  const [me] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.storeId, storeId), eq(pmsBuiPromoters.miniUserId, miniUserId))).limit(1);
  if (!me || me.parentPromoterId) return; // 已有上级则不覆盖（先到先得）

  await db.update(pmsBuiPromoters)
    .set({ parentPromoterId: binding.promoterId, level: 2, updatedAt: new Date() })
    .where(eq(pmsBuiPromoters.id, me.id));
}

/**
 * 冻结佣金（下单支付成功后调用）。
 * 自购不返佣：下单人 U 本人不入账，佣金沿推荐链向上分配 —— U 的直接上级 P 赚 lv1，P 的上级 Q 赚 lv2。
 * 返回冻结的佣金记录数。
 */
export async function freezeDistCommission(input: {
  orderId: string;
  orderNo: string;
  storeId: string;
  miniUserId: string;
  productId?: string | null;
  productName?: string | null;
  amountFen: number;
  rates: { lv1: number; lv2: number } | null;
}): Promise<number> {
  if (!input.rates) return 0;

  const [binding] = await db.select().from(pmsBuiReferralBindings)
    .where(and(
      eq(pmsBuiReferralBindings.miniUserId, input.miniUserId),
      eq(pmsBuiReferralBindings.storeId, input.storeId),
    )).limit(1);
  if (!binding) return 0;

  const [parent] = await db.select().from(pmsBuiPromoters)
    .where(and(eq(pmsBuiPromoters.id, binding.promoterId), eq(pmsBuiPromoters.status, 'active'))).limit(1);
  if (!parent) return 0;

  let created = 0;
  const insert = async (promoterId: string, type: 'direct' | 'team', rate: number) => {
    const amount = calcDistCommission(input.amountFen, rate);
    if (amount <= 0) return;
    const r = await db.insert(pmsBuiCommissionRecords).values({
      id: `cm_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      promoterId,
      orderId: input.orderId,
      orderNo: input.orderNo,
      amount,
      rate,
      type,
      productId: input.productId ?? null,
      productName: input.productName ?? null,
      status: 'frozen',
    }).onConflictDoNothing().returning({ id: pmsBuiCommissionRecords.id });
    if (r.length > 0) created++;
  };

  await insert(parent.id, 'direct', input.rates.lv1);
  if (parent.parentPromoterId) {
    const [grand] = await db.select().from(pmsBuiPromoters)
      .where(and(eq(pmsBuiPromoters.id, parent.parentPromoterId), eq(pmsBuiPromoters.status, 'active'))).limit(1);
    if (grand) await insert(grand.id, 'team', input.rates.lv2);
  }
  return created;
}

/** 退款回收：将订单对应的 frozen/released 佣金记录置为 cancelled（从可提现汇总中移除） */
export async function cancelCommissionByOrder(orderId: string): Promise<number> {
  const result = await db.update(pmsBuiCommissionRecords)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(pmsBuiCommissionRecords.orderId, orderId),
      eq(pmsBuiCommissionRecords.status, 'frozen'),
    ));
  const released = await db.update(pmsBuiCommissionRecords)
    .set({ status: 'cancelled', updatedAt: new Date() })
    .where(and(
      eq(pmsBuiCommissionRecords.orderId, orderId),
      eq(pmsBuiCommissionRecords.status, 'released'),
    ));
  return (result.rowCount ?? 0) + (released.rowCount ?? 0);
}

/** 下单支付成功后打通门店客户表（D9）：写入来源 + 来源推广员 + 消费累计 */
export async function syncCustomerFromOrder(input: {
  storeId: string;
  miniUserId: string;
  guestName: string;
  guestPhone: string;
  amountFen: number;
}): Promise<void> {
  const { storeId, miniUserId, guestName, guestPhone, amountFen } = input;
  const [binding] = await db.select().from(pmsBuiReferralBindings)
    .where(and(eq(pmsBuiReferralBindings.miniUserId, miniUserId), eq(pmsBuiReferralBindings.storeId, storeId))).limit(1);

  const [existing] = await db.select().from(pmsBuiCustomers)
    .where(and(eq(pmsBuiCustomers.storeId, storeId), eq(pmsBuiCustomers.miniUserId, miniUserId))).limit(1);

  if (existing) {
    await db.update(pmsBuiCustomers).set({
      source: binding ? 'promoter' : 'natural',
      referrerPromoterId: binding?.promoterId ?? null,
      totalSpent: existing.totalSpent + amountFen,
      updatedAt: new Date(),
    }).where(eq(pmsBuiCustomers.id, existing.id));
  } else {
    await db.insert(pmsBuiCustomers).values({
      id: `cu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId: 'default',
      storeId,
      miniUserId,
      name: guestName || '微信用户',
      phone: guestPhone || '',
      source: binding ? 'promoter' : 'natural',
      referrerPromoterId: binding?.promoterId ?? null,
      totalSpent: amountFen,
    });
  }
}
