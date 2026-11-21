export interface OrderAmount {
  originalTotal: number;
  memberTotal: number;
  nights: number;
}

export interface CouponDef {
  type: string;
  value: number;
  minAmount: number;
}

export function calcCouponDiscount(
  amount: OrderAmount,
  coupon: CouponDef,
): { discount: number; finalTotal: number } {
  const base = amount.memberTotal;
  if (coupon.minAmount > 0 && base < coupon.minAmount) {
    return { discount: 0, finalTotal: base };
  }
  let discount = 0;
  switch (coupon.type) {
    case 'full_reduce':
      discount = Math.min(coupon.value, base);
      break;
    case 'discount':
      discount = Math.floor(base * (100 - coupon.value) / 100);
      break;
    case 'newcomer':
      discount = Math.min(coupon.value, base);
      break;
  }
  const finalTotal = Math.max(0, base - discount);
  return { discount, finalTotal };
}
