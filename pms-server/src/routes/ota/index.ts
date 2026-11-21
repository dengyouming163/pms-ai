// OTA 直连路由聚合入口
import { Hono } from 'hono';
import ordersRoute from './orders.js';
import clientRoute from './client.js';
import importRoute from './import.js';
import { otaAuthMiddleware } from '../../middleware/ota-auth.js';

const otaRoute = new Hono();

// 应用 store_key 鉴权 — 跳过 bind 和 config（客户端首次绑定无需认证）
// otaAuthMiddleware 捕获 sk- 前缀 token 走 store_key 鉴权，JWT 则透传给全局 authMiddleware
otaRoute.use('*', async (c, next) => {
  if (c.req.path === '/api/ota/client/bind' || c.req.path === '/api/ota/client/config') {
    await next();
    return;
  }
  await otaAuthMiddleware(c, next);
});

// OTA 路由聚合 — 客户端与 Web 端共用 JWT 鉴权（通过全局 authMiddleware）
// RPA 客户端使用员工 JWT token，Web 端复用现有登录态
otaRoute.route('/orders', ordersRoute);
otaRoute.route('/client', clientRoute);
otaRoute.route('/import', importRoute);

export default otaRoute;
