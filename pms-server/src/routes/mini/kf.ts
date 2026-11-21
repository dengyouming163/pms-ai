import { Hono } from 'hono';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';

const route = new Hono();

/**
 * 联系客服：返回门店绑定企微客服或平台兜底客服的企微链接（免登录公开）。
 * 代理 platform-server GET /api/internal/wecom-kf/contact。
 */
route.get('/contact', async (c) => {
  const storeId = String(c.req.query('storeId') || '').trim();
  if (!storeId) return c.json({ success: false, error: 'storeId 必填' }, 400);

  const engineUrl = process.env.PLATFORM_ENGINE_URL || 'http://platform-server:9092';
  const res = await fetch(
    `${engineUrl}/api/internal/wecom-kf/contact?storeId=${encodeURIComponent(storeId)}`,
    { headers: { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN }, signal: AbortSignal.timeout(10000) },
  ).catch((err) => {
    console.error('[mini/kf] contact 代理失败：无法连接 platform-server', err);
    return null;
  });

  if (!res) return c.json({ success: false, error: '客服服务暂不可用，请稍后重试' }, 502);

  const data = await res.json().catch(() => {
    console.error('[mini/kf] contact 上游响应异常', res.status);
    return { success: false, error: '客服服务响应异常' };
  });
  if (!data.success) {
    // 仅记录 5xx 上游错误（404「客服未配置」是业务态，不打错误日志）
    if (!res.ok && res.status >= 500) console.error('[mini/kf] contact 上游非 2xx:', res.status, data);
    return c.json({ success: false, error: data.error || '客服服务暂不可用' }, res.status === 404 ? 404 : 502);
  }
  return c.json({ success: true, data: data.data });
});

export default route;
