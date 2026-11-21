/** 从门店配置中取某会员等级的折扣率（百分数，如 95 即 95 折），未配置返回 100（无折扣） */
export function getDiscountRate(
  memberLevel: string,
  discounts?: Record<string, number> | null,
): number {
  if (!discounts) return 100;
  return discounts[memberLevel] ?? 100;
}

/** 按折扣率折算逐晚价格（向下取整到元） */
export function applyMemberDiscount(
  nightly: { date: string; price: number }[],
  discountRate: number,
): { date: string; price: number }[] {
  if (discountRate >= 100) return nightly;
  return nightly.map(n => ({ ...n, price: Math.floor(n.price * discountRate / 100) }));
}
