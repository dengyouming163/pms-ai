import { PLATFORM_SERVER_URL, INTERNAL_SERVICE_TOKEN } from '../constants.js';

// 校验用户在指定内容产品下是否有有效（未用/未过期）门票券。
// 三态：
//   valid:true            —— 确定有票
//   valid:false           —— 确定没有票（上游明确回了 valid:false）
//   valid:false + unknown —— **问不到**（上游不可用 / 非 2xx / 响应不合法）
// 后两者对**付费墙**是同一种（都拦），但对**入口页**必须分开：把「问不到」当成
// 「没票」，会让持票游客在 BFF 抖动时看到「你没买票 + 去购买」，于是重复购票。
export async function checkTicket(contentProductId: string, miniUserId: string): Promise<{ valid: boolean; ticketId?: string; unknown?: boolean }> {
  const url = `${PLATFORM_SERVER_URL}/api/wenlv/internal/tickets/check?contentProductId=${encodeURIComponent(contentProductId)}&miniUserId=${encodeURIComponent(miniUserId)}`;
  try {
    const res = await fetch(url, {
      headers: { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN },
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) return { valid: false, unknown: true };
    const json = await res.json().catch(() => ({})) as any;
    if (!json?.success) return { valid: false, unknown: true };
    return { valid: !!json.data?.valid, ticketId: json.data?.ticketId };
  } catch (err) {
    console.error('[wenlv] ticket check failed:', { contentProductId, miniUserId, err });
    return { valid: false, unknown: true };
  }
}
