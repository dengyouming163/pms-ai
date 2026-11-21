/** 计算佣金（分）= 订单金额(分) × 佣金比例(万分比) / 10000，向下取整 */
export function calcCommission(orderAmountFen: number, rate: number): number {
  return Math.floor(orderAmountFen * rate / 10000);
}

/** 可提现余额 = released - withdrawn - processing，不低于 0 */
export function calcWithdrawable(
  releasedTotal: number,
  withdrawnTotal: number,
  processingTotal: number,
): number {
  return Math.max(0, releasedTotal - withdrawnTotal - processingTotal);
}
