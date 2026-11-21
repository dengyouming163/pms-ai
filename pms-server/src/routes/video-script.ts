import { Hono } from 'hono';
import { AGENT_API_URL } from '../constants.js';

/**
 * 短视频脚本生产代理 — 转发到 pms-agent 的 /video-script/* 端点。
 * 前端经 pms-server 鉴权（authMiddleware + tenantMiddleware）后，透传 method / path / body，
 * 并注入 X-Merchant-Id / X-Store-Id 身份头作为 pms-agent 端租户隔离依据（门店归属键，见 spec §5.1）。
 * 响应体含 CONFIRM1_WAIT / COMPLETED 等业务状态字段（业务状态走 200 body，非 HTTP 码）。
 * 与 /api/ai/model-config 同为 BFF 代理职责，网关无独立 Nginx 转发层。
 */

const videoScript = new Hono();

const FORWARD_TIMEOUT_MS = 180_000; // 阶段①/② 同步生成可能 >60s（uni.request 默认上限），双向放宽

/** 通用转发：透传 method + path + body + 真实门店/商户身份，返回 AI 引擎 JSON 响应 */
async function forward(c: any, suffix: string) {
  const method = c.req.method;
  const target = `${AGENT_API_URL}/video-script${suffix}`;
  // authMiddleware 已将 JWT payload 注入 c.set('authUser')；真实门店从入站 X-Store-Id 读取
  // （pms-mobile request.ts 恒带真实门店头），缺省回退 homeStoreId。
  const authUser = (c.get('authUser') || {}) as Record<string, any>;
  const inboundStore = c.req.header('X-Store-Id');
  // 门店为空（无入站头且无 homeStoreId）时拒绝转发——否则 pms-agent 侧空串回落 "local"，
  // 会把无门店上下文的调用与本地 dev 态混淆（潜在跨店可见），此处显式封死。
  const storeId = inboundStore ?? authUser.homeStoreId ?? '';
  if (!storeId) {
    return c.json({ success: false, error: '缺少门店上下文，无法访问短视频脚本' }, 400);
  }
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'X-Merchant-Id': authUser.merchantId ?? '',
    'X-Store-Id': storeId,
  };
  const init: RequestInit = { method, headers };
  if (method === 'POST') {
    init.body = JSON.stringify(await c.req.json());
  }
  try {
    const res = await fetch(target, { ...init, signal: AbortSignal.timeout(FORWARD_TIMEOUT_MS) });
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      return c.json({ success: false, error: `短视频脚本服务错误 ${res.status}` }, 502);
    }
    return c.json(data);
  } catch {
    return c.json({ success: false, error: '短视频脚本服务暂不可用' }, 502);
  }
}

// 注意：/history/list 须先于 /:project_id 注册，避免被参数路由吞掉
videoScript.post('/start', (c) => forward(c, '/start'));
videoScript.post('/confirm', (c) => forward(c, '/confirm'));
videoScript.get('/history/list', (c) => forward(c, '/history/list'));
videoScript.get('/:project_id', (c) => forward(c, `/${c.req.param('project_id')}`));

export default videoScript;
