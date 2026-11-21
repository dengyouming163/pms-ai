import { get, post } from '../request'

/** 文旅到店核销 —— LY 领奖码 / W 门票券（员工 JWT + X-Store-Id 由 request 自动注入；服务端 /api/store/wenlv） */

export interface WenlvClaimByCode {
  id: string
  code: string
  status: 'claimed' | 'redeemed' | 'cancelled'
  productId: string
  productTitle: string | null
  productMode: string | null
  tierId: string
  tierName: string | null
  tierOrder: number | null
  rewardId: string | null
  rewardName: string | null
  rewardType: string | null
  rewardValue: string | null
  claimedAt: string
  redeemedAt: string | null
  redeemedBy: string | null
  redeemedStoreId: string | null
}

export interface WenlvTicketByCode {
  id: string
  code: string
  status: string
  productId: string
  productName: string | null
  orderNo: string | null
  expiresAt: string | null
  usedAt: string | null
  verifyStoreId: string | null
  createdAt: string
}

/** 领奖码核销返回的已核销行（脱敏：与 by-code 同口径，不下发 miniUserId 等敏感字段）。
 *  request 层 resolve 的是响应体的 data，故类型即 data 行本身，非 { success } 包装。 */
export interface WenlvClaimRedeemResult {
  id: string
  code: string
  status: string
  redeemedAt: string | null
  redeemedBy: string | null
  redeemedStoreId: string | null
}

/** 验票核销返回的平台券行（pms_platform_wenlv_tickets 原始行；此处仅标注前端关注字段）。
 *  request 层 resolve 的是响应体的 data，故类型即 data 行本身，非 { success } 包装。 */
export interface WenlvTicketConsumeResult {
  id: string
  code: string
  status: string
  expiresAt: string | null
  usedAt: string | null
  verifyStoreId: string | null
}

/** 预览领奖码 —— GET /api/store/wenlv/claims/by-code/:code（查无 404 静默，交页面展示未找到态） */
export function getWenlvClaimByCode(code: string): Promise<WenlvClaimByCode> {
  return get(`/api/store/wenlv/claims/by-code/${encodeURIComponent(code)}`, undefined, { showError: false })
}

/** 核销领奖码 —— POST /api/store/wenlv/claims/:id/redeem（409 业务文案走响应 error；resolve 被脱敏的已核销行） */
export function redeemWenlvClaim(id: string): Promise<WenlvClaimRedeemResult> {
  return post(`/api/store/wenlv/claims/${encodeURIComponent(id)}/redeem`, {})
}

/** 预览门票券 —— GET /api/store/wenlv/tickets/by-code/:code（同 404 静默） */
export function getWenlvTicketByCode(code: string): Promise<WenlvTicketByCode> {
  return get(`/api/store/wenlv/tickets/by-code/${encodeURIComponent(code)}`, undefined, { showError: false })
}

/** 验票核销 —— POST /api/store/wenlv/tickets/consume { code }（storeId 服务端解析注入；resolve 平台券行） */
export function consumeWenlvTicket(code: string): Promise<WenlvTicketConsumeResult> {
  return post('/api/store/wenlv/tickets/consume', { code })
}
