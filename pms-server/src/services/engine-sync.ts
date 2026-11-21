// AI 客服引擎（platform-server）内部接口客户端
// 用途：套餐支付成功后，订单回写平台 CDP（order-sync），让客服工作台客户 360 可见历史订单。
// 鉴权：X-Internal-Token（与 platform-server 内部路由约定一致）。
// 地址：PLATFORM_ENGINE_URL 指向 platform-server（与 PLATFORM_SERVER_URL= pms-platform-server 区分）。

import { INTERNAL_SERVICE_TOKEN } from '../constants.js';

const ENGINE_URL = process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092';

export interface OrderSyncPayload {
  platformOrderNo: string;
  customerPhone?: string;
  miniUserId?: string;
  openid?: string;
  amountFen?: number;
  storeId?: string;
  status?: string;
  paidAt?: string;
}

/**
 * 通知 platform-server 订单回写 CDP（fire-and-forget，失败只记日志不阻断支付回调）
 */
export async function syncOrderToEngine(payload: OrderSyncPayload): Promise<void> {
  try {
    const res = await fetch(`${ENGINE_URL}/api/internal/order-sync`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Token': INTERNAL_SERVICE_TOKEN,
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      console.error('[engine-sync] order-sync 失败 order=' + payload.platformOrderNo, res.status, (data as any)?.error || '');
    }
  } catch (err) {
    console.error('[engine-sync] order-sync 通知异常 order=' + payload.platformOrderNo + ' url=' + ENGINE_URL + '（不阻断支付）:', err);
  }
}
