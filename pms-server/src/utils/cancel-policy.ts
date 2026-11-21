export interface CancelPolicy {
  freeHours: number; // 入住日 00:00 前多少小时外可免费取消
  feeRate: number;   // 免费期内取消的手续费百分比（0-100）
}

/**
 * 计算已支付订单的可退金额（元）
 * - 入住日 00:00（东八区）前 freeHours 小时外：全额退
 * - 之内：按 feeRate% 扣手续费
 * - 入住日 00:00 及之后：不退
 */
export function calcRefundAmount(
  totalPrice: number,
  checkIn: string,
  now: Date,
  policy: CancelPolicy,
): number {
  const checkInStart = new Date(`${checkIn}T00:00:00+08:00`).getTime();
  const nowMs = now.getTime();
  if (nowMs >= checkInStart) return 0;
  const hoursLeft = (checkInStart - nowMs) / 3600000;
  if (hoursLeft >= policy.freeHours) return totalPrice;
  return Math.floor(totalPrice * (100 - policy.feeRate) / 100);
}
