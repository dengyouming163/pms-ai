// 入住订单状态机（规格 §6）。
// 之所以做成纯函数模块而不是写在路由里：既有 /api/checkin-h5 的 PATCH 语义本轮**不收紧**
// （保护员工 H5 与既有页面），流转守卫只作用于新接口 —— 放在独立模块里，
// 「哪些接口受约束」由调用方决定，规则本身只有一份。

export const CHECKIN_ORDER_STATUSES = [
  'booked', 'checked_in', 'checked_out', 'completed', 'cancelled', 'refunded',
] as const;

export type CheckinOrderStatus = (typeof CHECKIN_ORDER_STATUSES)[number];

export const STATUS_LABELS: Record<CheckinOrderStatus, string> = {
  booked: '待入住',
  checked_in: '已入住',
  checked_out: '已离店',
  completed: '已结算',
  cancelled: '已取消',
  refunded: '有退款',
};

/** 合法流转表（规格 §6）；表外一律拒绝，cancelled / refunded 为终态 */
export const ALLOWED_TRANSITIONS: Record<CheckinOrderStatus, readonly CheckinOrderStatus[]> = {
  booked: ['checked_in', 'cancelled'],
  checked_in: ['checked_out', 'cancelled'],
  checked_out: ['completed', 'cancelled'],
  completed: ['refunded'],
  cancelled: [],
  refunded: [],
};

export function isCheckinOrderStatus(v: unknown): v is CheckinOrderStatus {
  return typeof v === 'string' && (CHECKIN_ORDER_STATUSES as readonly string[]).includes(v);
}

/**
 * 流转守卫。
 * @returns null = 允许流转；否则返回**可直接展示给用户**的中文原因（路由层以 400 返回）
 */
export function transitionError(from: string, to: CheckinOrderStatus): string | null {
  if (!isCheckinOrderStatus(from)) return `未知的当前状态「${from}」`;
  if (from === to) return `订单已处于「${STATUS_LABELS[to]}」`;
  if (!ALLOWED_TRANSITIONS[from].includes(to)) {
    return `「${STATUS_LABELS[from]}」不能变更为「${STATUS_LABELS[to]}」`;
  }
  return null;
}

/** 转入该状态时必填的原因字段（订单表列名）；null 表示不需要原因 */
export function requiredReasonField(to: CheckinOrderStatus): 'cancelReason' | 'refundReason' | null {
  if (to === 'cancelled') return 'cancelReason';
  if (to === 'refunded') return 'refundReason';
  return null;
}
