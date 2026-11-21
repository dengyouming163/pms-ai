// 退款落定目标判别（纯函数，无任何 import —— 便于单测锁定「判别顺序」这一易错点）。
// 顺序有意：po_ 前缀（平台套餐单）必须排在 storeId 判别之前，否则套餐单会被文旅分支抢走。

export type RefundTarget = 'platform-product' | 'wenlv' | 'stay';

/** 判别一笔支付单的退款该由哪条落定路径处理。
 *  - 'platform-product'：平台套餐订单（orderId 以 po_ 开头）
 *  - 'wenlv'：文旅门票订单（wenlv-pay 建单时 storeId 独占占位 'platform'）
 *  - 'stay'：其余（住宿/门店订单）
 */
export function classifyRefundTarget(payment: { orderId: string; storeId?: string | null }): RefundTarget {
  if (payment.orderId.startsWith('po_')) return 'platform-product';
  if (payment.storeId === 'platform') return 'wenlv';
  return 'stay';
}
