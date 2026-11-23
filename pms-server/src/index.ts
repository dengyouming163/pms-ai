import { OpenAPIHono, createRoute } from '@hono/zod-openapi';
import { db, pool } from './db/index.js';
import { desc, inArray, sql } from 'drizzle-orm';
import { cors } from 'hono/cors';
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { z } from 'zod';
import dashboardRoute from './routes/dashboard';
import brandsRoute from './routes/brands';
import storesRoute from './routes/stores';
import roomsRoute from './routes/rooms';
import ordersRoute from './routes/orders';
import pricingRoute from './routes/pricing';
import channelsRoute from './routes/channels';
import financeRoute from './routes/finance';
import customersRoute from './routes/customers';
import staffRoute from './routes/staff';
import settingsRoute from './routes/settings';
import dataCenterRoute from './routes/data-center';
import housekeepingRoute from './routes/housekeeping';
import notificationsRoute from './routes/notifications';
import authRoute from './routes/auth';
import uploadRoute from './routes/upload';
import aiChatRoute from './routes/ai/chat.js';
import aiInsightsRoute from './routes/ai/insights.js';
import aiModeRoute from './routes/ai/mode.js';
import aiActionsRoute from './routes/ai/actions.js';
import aiUsageRoute from './routes/ai/usage.js';
import aiModelConfigRoute from './routes/ai/model-config.js';
import videoScriptRoute from './routes/video-script.js';
import internalAiToolsRoute from './routes/internal/ai-tools.js';
import internalMiniAIToolsRoute from './routes/internal/ai-tools/mini.js';
import internalAgentToolsRoute from './routes/internal/agent-tools.js';
import internalMerchantInitRoute from './routes/internal/merchant-init.js';
import internalSmsRoute from './routes/internal/sms.js';
import internalNotifyRoute from './routes/internal/notify.js';
import internalStoreGuideRoute from './routes/internal/store-guide.js';
import internalStoresRoute from './routes/internal/stores.js';
import internalAssetsRoute from './routes/internal/assets.js';
import internalRoomTypesRoute from './routes/internal/room-types.js';
import internalPlatformOrdersRoute from './routes/internal/platform-orders.js';
import internalWenlvRefundRoute from './routes/internal/wenlv-refund.js';
import internalDistributionRoute from './routes/internal/distribution.js';
import internalDistributionCustomersRoute from './routes/internal/distribution-customers.js';
import competitorRoute from './routes/competitor.js';
import assetsRoute from './routes/assets.js';
import tasksRoute from './routes/tasks.js';
import taskRulesRoute from './routes/task-rules.js';
import videoRoute from './routes/video.js';
import videoPromoRoute from './routes/video-promo.js';
import voiceRoute from './routes/voice.js';
import mediakitRoute from './routes/mediakit-batch.js';
import xhsRoute from './routes/xhs.js';
import contentCalendarRoute from './routes/content-calendar.js';
import aiPricingRoute from './routes/ai-pricing.js';
import priceRobotRoute from './routes/price-robot.js';
import pricingCenterRoute from './routes/pricing-center.js';
import competitorPricesRoute from './routes/competitor-prices.js';
import inventoryRoute from './routes/inventory.js';
import hotTopicsRoute from './routes/hot-topics.js';
import creationHistoryRoute from './routes/creation-history.js';
import creationSessionsRoute from './routes/creation-sessions.js';
import miniAuthRoute from './routes/mini/auth.js';
import miniStoresRoute from './routes/mini/stores.js';
import miniRoomsRoute from './routes/mini/rooms.js';
import miniOrdersRoute from './routes/mini/orders.js';
import miniPayRoute from './routes/mini/pay.js';
import payProductRoute from './routes/mini/pay-product.js';
import payH5Route from './routes/mini/pay-h5.js';
import miniPackagesRoute from './routes/mini/packages.js';
import miniCouponsRoute from './routes/mini/coupons.js';
import miniPromoterRoute from './routes/mini/promoter.js';
import miniChatRoute from './routes/mini/chat.js';
import miniProductsRoute from './routes/mini/products.js';
import miniRegionsRoute from './routes/mini/regions.js';
import miniProductOrdersRoute from './routes/mini/product-orders.js';
import miniMessagesRoute from './routes/mini/messages.js';
import miniSubscribeRoute from './routes/mini/subscribe.js';
import miniSurveyRoute from './routes/mini/survey.js';
import miniKfRoute from './routes/mini/kf.js';
import miniWenlvRoute from './routes/mini/wenlv.js';
import miniWenlvTradeRoute from './routes/mini/wenlv-trade.js';
import unifiedOrdersRoute from './routes/mini/unified-orders.js';
import wenlvMyPlayRoute from './routes/mini/wenlv-my-play.js';
import wenlvMyRecordsRoute from './routes/mini/wenlv-my-records.js';
import miniWenlvDialogueRoute from './routes/mini/wenlv-dialogue.js';
import miniWenlvTriggerRoute from './routes/mini/wenlv-trigger.js';
import miniWenlvPhotoEvidenceRoute from './routes/mini/wenlv-photo-evidence.js';
import miniWenlvMerchRoute from './routes/mini/wenlv-merch.js';
import miniAsrRoute from './routes/mini/asr.js';
import miniAdminRoute from './routes/mini-admin.js';
import platformRoute from './routes/platform.js';
import platformConfigRoute from './routes/platform-config.js';
import storeProductOrdersRoute from './routes/store/product-orders.js';
import storeWenlvRoute from './routes/store/wenlv.js';
import otaRoute from './routes/ota/index.js';
import kbAiRoute from './routes/kb-ai.js';
import mpCallbackRoute from './routes/wechat/mp-callback.js';
import mpConfigRoute from './routes/admin/mp-config.js';
import wenlvAdminRoute from './routes/admin/wenlv.js';
import wenlvAiSessionsRoute from './routes/admin/wenlv-ai-sessions.js';
import wenlvResearchAdminRoute from './routes/admin/wenlv-research.js';
import wenlvAssetGenRoute from './routes/admin/wenlv-asset-gen.js';
import wenlvDesignRoute from './routes/admin/wenlv-design.js';
import kfStaffOauthRoute from './routes/kf-staff/oauth.js';
import kfStaffRoute from './routes/kf-staff/index.js';
import checkinH5Route from './routes/checkin-h5/index.js';
import checkinOrdersRoute from './routes/checkin-orders.js';
import { opLogMiddleware } from './middleware/op-log';
import { authMiddleware } from './middleware/auth';
import { tenantMiddleware } from './middleware/tenant';
import { rateLimitMiddleware } from './middleware/rate-limit';
import { modeGuardMiddleware } from './middleware/mode-guard.js';
import { internalAuthMiddleware } from './middleware/internal-auth.js';
import { platformGuard } from './middleware/platform-guard.js';
import { dataMaskMiddleware } from './middleware/data-mask.js';
import { miniAuthMiddleware } from './middleware/mini-auth.js';
import { serverError } from './lib/http-error.js';

const app = new OpenAPIHono();

// 全局错误处理 — 未捕获异常返回 JSON 而非裸 500
app.onError((err, c) => {
  // 传对象而非 message —— 否则丢堆栈，线上无从排查
  console.error('[pms-server] 未捕获异常:', err);
  // 生产/测试一律不把 err.message 回给客户端（drizzle 的 message 含完整 SQL 与参数）。
  // 开发态保留原文便于排查：仅当显式 NODE_ENV=development 时透出。
  const dev = process.env.NODE_ENV === 'development';
  return c.json({ success: false, error: dev ? err.message : '服务器内部错误' }, 500);
});

// CORS中间件 - 允许前端跨域访问
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Merchant-Id', 'X-Store-Id', 'X-Internal-Service-Token'],
}));

// 速率限制 - 每个IP每分钟最多60次写操作
app.use('/api/*', rateLimitMiddleware(60));

// 统一的JWT认证中间件（/api/auth/login等公开路径自动跳过）
app.use('*', authMiddleware);

// C端小程序认证（独立于员工认证）
app.use('/api/mini/*', miniAuthMiddleware);

// 模式守卫 — 拦截未开启 AI 模式的租户请求
app.use('/api/ai/*', modeGuardMiddleware);

// 平台状态/套餐权限校验（在 tenant 隔离之前）
app.use('/api/*', platformGuard);

// 租户隔离中间件 — 提取商户/门店上下文并验证门店权限（在 auth 之后注册）
app.use('/api/*', tenantMiddleware);

// 操作日志中间件 - 自动记录POST写操作
app.use('/api/*', opLogMiddleware);

// 健康检查（含数据库连通性）
app.get('/health', async (c) => {
  let dbOk = false;
  try {
    await pool.query('SELECT 1');
    dbOk = true;
  } catch {}
  return c.json({
    status: dbOk ? 'ok' : 'degraded',
    db: dbOk ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

// 运维面板：OTA 设备状态（公开接口）
app.get('/api/ota/devices', async (c) => {
  try {
    const { pmsOtaClients } = await import('./db/schema/ota.js');
    const { pmsBuiStores } = await import('./db/schema/brands.js');
    const clients = await db.select().from(pmsOtaClients).orderBy(desc(pmsOtaClients.lastHeartbeatAt));
    // 查门店名称
    const storeIds = [...new Set(clients.map(cl => cl.storeId))];
    const stores = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
      .from(pmsBuiStores).where(inArray(pmsBuiStores.id, storeIds));
    const nameMap: Record<string, string> = {};
    for (const s of stores) { nameMap[s.id] = s.name || s.id; }

    return c.json({ clients: clients.map(cl => ({
      storeId: cl.storeId, storeName: nameMap[cl.storeId] || cl.storeId,
      platform: cl.platform, deviceId: cl.deviceId,
      status: cl.status, sessionValid: cl.sessionValid,
      lastCaptureAt: cl.lastCaptureAt?.toISOString() || null,
      lastHeartbeatAt: cl.lastHeartbeatAt?.toISOString() || null,
    })) });
  } catch (e: any) { return serverError(c, e, '获取设备列表失败'); }
});

// ============================================================
// 注册业务路由（普通 Hono 路由 - 处理实际请求）
// ============================================================
app.route('/api/dashboard', dashboardRoute);
app.route('/api/brands', brandsRoute);
app.route('/api/stores', storesRoute);
app.route('/api/rooms', roomsRoute);
app.route('/api/orders', ordersRoute);
app.route('/api/pricing', pricingRoute);
app.route('/api/channels', channelsRoute);
app.route('/api/finance', financeRoute);
app.route('/api/customers', customersRoute);
app.route('/api/staff', staffRoute);
app.route('/api/settings', settingsRoute);
app.route('/api/data-center', dataCenterRoute);
app.route('/api/housekeeping', housekeepingRoute);
app.route('/api/notifications', notificationsRoute);
app.route('/api/auth', authRoute);
app.route('/api/upload', uploadRoute);
app.route('/api/video', videoRoute);
app.route('/api/video', videoPromoRoute);
app.route('/api/voice', voiceRoute);
app.route('/api/xhs', xhsRoute);
app.route('/api/content', contentCalendarRoute);
app.route('/api/ai-pricing', aiPricingRoute);
app.route('/api/price-robot', priceRobotRoute);
app.route('/api/pricing-center', pricingCenterRoute);
app.route('/api/competitor-prices', competitorPricesRoute);
app.route('/api/inventory', inventoryRoute);
app.route('/api/hot-topics', hotTopicsRoute);
app.route('/api/creation-records', creationHistoryRoute);
app.route('/api/creation-sessions', creationSessionsRoute);
app.route('/api/ai/chat', aiChatRoute);
app.route('/api/ai/insights', aiInsightsRoute);
app.route('/api/ai/mode', aiModeRoute);
app.route('/api/ai/actions', aiActionsRoute);
app.route('/api/ai/usage', aiUsageRoute);
app.route('/api/ai/model-config', aiModelConfigRoute);
app.route('/api/video-script', videoScriptRoute);
app.route('/api/competitor', competitorRoute);
app.route('/api/assets', assetsRoute);
app.route('/api/tasks', tasksRoute);
app.route('/api/task-rules', taskRulesRoute);
app.route('/api/mediakit', mediakitRoute);

// C端小程序路由
app.route('/api/mini/auth', miniAuthRoute);
app.route('/api/mini/stores', miniStoresRoute);
app.route('/api/mini/rooms', miniRoomsRoute);
// 合并订单列表。🔴 **必须先于**下面 `app.route('/api/mini/orders', …)` 注册：窄前缀先注册，
// 顺序才是**显式契约**，而不是「依赖 /api/mini/orders 的子路由恰好没有 /unified 段」的隐式耦合。
// 同款手法与理由：pms-platform/pms-platform-server/src/index.ts 的 /api/wenlv/slots、/api/wenlv/packages。
app.route('/api/mini/orders/unified', unifiedOrdersRoute);
app.route('/api/mini/orders', miniOrdersRoute);
app.route('/api/mini/pay', miniPayRoute);
// H5 支付（公众号 JSAPI + MWEB + JSSDK 签名）— 子路径 /wxmp-jsapi、/h5-mweb、/jssdk-config 与既有 /jsapi、/dy-jsapi 不冲突
app.route('/api/mini/pay', payH5Route);
app.route('/api/mini/pay-product', payProductRoute);
app.route('/api/mini/packages', miniPackagesRoute);
app.route('/api/mini/coupons', miniCouponsRoute);
app.route('/api/mini/promoter', miniPromoterRoute);
app.route('/api/mini/chat', miniChatRoute);
app.route('/api/mini/products', miniProductsRoute);
app.route('/api/mini/regions', miniRegionsRoute);
app.route('/api/mini/product-orders', miniProductOrdersRoute);
app.route('/api/mini/messages', miniMessagesRoute);
app.route('/api/mini/subscribe', miniSubscribeRoute);
app.route('/api/mini/survey', miniSurveyRoute);
app.route('/api/mini/kf', miniKfRoute);
// 「继续玩」聚合读口。🔴 **必须先于**下一行 `app.route('/api/mini/wenlv', …)` 注册：
// 窄前缀先注册，顺序才是显式契约 —— mini/wenlv.ts 里有 `route.get('/:id')`，
// 后注册的话 'my-play' 会被当成产品 id（恒 404）。同款手法见上面 /api/mini/orders/unified。
app.route('/api/mini/wenlv/my-play', wenlvMyPlayRoute);
app.route('/api/mini/wenlv/my-records', wenlvMyRecordsRoute);
// NPC 驱动章节对话。必须在 /api/mini/wenlv 之前注册（/:id 会吞掉 'dialogue'）。
app.route('/api/mini/wenlv/dialogue', miniWenlvDialogueRoute);
// 扫码拆封 / BLE 信标触发：实体-对话双驱动解锁。必须在 /api/mini/wenlv 之前注册（/:id 会吞掉 'trigger'）。
app.route('/api/mini/wenlv/trigger', miniWenlvTriggerRoute);
// P3-C Task 3：拍照取证——视觉 LLM 识别现场照片中的线索。必须在 /api/mini/wenlv 之前注册（/:id 会吞掉 'photo-evidence'）。
app.route('/api/mini/wenlv/photo-evidence', miniWenlvPhotoEvidenceRoute);
// 文创商品兑换闭环（C端兑换 + B端核销/发货/收货）。必须在 /api/mini/wenlv 之前注册（/:id 会吞掉 'merch'）。
app.route('/api/mini/wenlv/merch', miniWenlvMerchRoute);
app.route('/api/mini/wenlv', miniWenlvRoute);
app.route('/api/mini/wenlv-trade', miniWenlvTradeRoute);
// C端语音转文字（NPC 对话输入：玩家按住麦克风录音 → 转文字填入输入框）
app.route('/api/mini/asr', miniAsrRoute);

// B端商家私域管理（门店装修 + 进件）与平台运营（进件审核）
app.route('/api/mini-admin', miniAdminRoute);
// 平台端配置代理（预订模式/取消政策/协议价）— 门店归属 storeId 在代理内强制（先于 /api/platform 注册，避免被 tenant 守卫拦截）
app.route('/api/platform/config', platformConfigRoute);
app.route('/api/platform', platformRoute);

// 员工成交工作台（企微自定义应用 H5；OAuth 公开端点已在 auth PUBLIC_PATHS 放行）
app.route('/api/kf-staff/oauth', kfStaffOauthRoute);
app.route('/api/kf-staff', kfStaffRoute);

// 微信入住订单智能录入 H5（员工端公开 /parse、/orders POST 已由 auth 方法感知白名单放行）
app.route('/api/checkin-h5', checkinH5Route);

// 入住订单平台端接口（录入/补录/编辑/状态流转/流转日志；BFF 动态签发 pms JWT 并携带真实操作人）
// 鉴权：authMiddleware 全局生效（路径不在 PUBLIC_PATHS 白名单内 ⇒ 必须带 Bearer）
app.route('/api/checkin-orders', checkinOrdersRoute);

// B端商家（store 员工）平台套餐订单 — 接单/拒单/补尾款/核销（员工 JWT 鉴权，转发 pms-platform）
app.route('/api/store/product-orders', storeProductOrdersRoute);

// B端商家（store 员工）文旅到店核销 — LY 领奖码直写本库 / W 门票代理（员工 JWT 鉴权，转发 pms-platform）
app.route('/api/store/wenlv', storeWenlvRoute);

// OTA 直连（RPA 客户端订单上报/心跳/配置 — 复用员工 JWT 鉴权）
app.route('/api/ota', otaRoute);

// 知识库：AI 生成 + 周边推荐 CRUD
app.route('/api/kb', kbAiRoute);

// 公众号消息回调（服务器配置验签 + 消息/事件接收，明文模式；公开路径已加入 auth PUBLIC_PATHS）
app.route('/api/wechat/mp', mpCallbackRoute);

// 公众号运营配置内部 API（平台后台读写菜单/自动回复；内部 Token 鉴权，见 routes/admin/mp-config.ts）
app.route('/api/admin/mp-config', mpConfigRoute);

// 文旅内容层 admin（创作台代理读写内容 8 表；内部 token 守卫见 routes/admin/wenlv.ts）
app.route('/api/admin/wenlv', wenlvAdminRoute);

// 文旅素材生成（S3）：生成明细/进度/迭代；自带内部 token 守卫
app.route('/api/admin/wenlv-asset-gen', wenlvAssetGenRoute);

// 文旅设计系统 admin（创作台代理读写设计模板/资产；内部 token 守卫见 routes/admin/wenlv-design.ts）
app.route('/api/admin/wenlv-design', wenlvDesignRoute);

// 场地网络调研（采风前 AI 调研）：BFF 建行/读行；pms-agent 只调 PATCH 逐节回写。
// ⚠️ 独立挂载点是刻意的（**不是** /api/admin/wenlv/*）—— 它有自己的路由文件与守卫实例。
app.route('/api/admin/wenlv-research', wenlvResearchAdminRoute);

// AI 协作 DIY 会话 / 七步向导落盘（0079）：pms-agent 与 BFF 经内部 token 调用；
// 草案只存 ai_sessions，POST .../adopt 事务才落 room/chapters/scenes/flows/npcs。
app.route('/api/admin/wenlv-ai-sessions', wenlvAiSessionsRoute);

// 内部 Tool Hub（需 internalAuth + dataMask 中间件）
app.use('/api/internal/*', internalAuthMiddleware);
app.use('/api/internal/*', dataMaskMiddleware);
app.route('/api/internal/ai-tools', internalAiToolsRoute);
app.route('/api/internal/ai-tools/mini', internalMiniAIToolsRoute);
// Agent 只读工具端点（价格日历/入住率/竞对价/渠道表现/财务汇总），供 pms-agent 经内部 Token 调用
app.route('/api/internal/agent-tools', internalAgentToolsRoute);
app.route('/api/internal/merchants', internalMerchantInitRoute);
app.route('/api/internal/sms', internalSmsRoute);
app.route('/api/internal/notify', internalNotifyRoute);
app.route('/api/internal/store-guide', internalStoreGuideRoute);
app.route('/api/internal/stores', internalStoresRoute);
app.route('/api/internal/assets', internalAssetsRoute);
app.route('/api/internal/room-types', internalRoomTypesRoute);
app.route('/api/internal/platform/order', internalPlatformOrdersRoute);
app.route('/api/internal/wenlv', internalWenlvRefundRoute);
app.route('/api/internal/distribution', internalDistributionRoute);
app.route('/api/internal/distribution', internalDistributionCustomersRoute);

// 静态文件服务 — 上传的文件（路径遍历保护）
const UPLOADS_DIR = resolve(import.meta.dirname, '..', 'uploads');
app.get('/uploads/:filename', async (c) => {
  const filename = c.req.param('filename');
  const safePath = resolve(UPLOADS_DIR, filename);
  // 确保解析后的路径在 uploads 目录内，防止..\路径遍历
  if (!safePath.startsWith(UPLOADS_DIR)) {
    return c.json({ error: '禁止访问' }, 403);
  }
  try {
    const file = readFileSync(safePath);
    const ext = filename.split('.').pop()?.toLowerCase();
    const mimeTypes: Record<string, string> = {
      png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg',
      webp: 'image/webp', svg: 'image/svg+xml',
      mp4: 'video/mp4', mov: 'video/quicktime',
      webm: 'video/webm', mkv: 'video/x-matroska',
    };
    return new Response(file, {
      headers: { 'Content-Type': mimeTypes[ext || ''] || 'application/octet-stream' },
    });
  } catch {
    return c.json({ error: '文件不存在' }, 404);
  }
});

// ============================================================
// OpenAPI 契约注册（仅用于文档生成，不影响路由处理）
// ============================================================

// 通用响应Schema - 各接口返回具体结构不同，用z.any()占位
const AnyResponse = z.any().describe('接口响应数据');

// --- Dashboard ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/dashboard',
  tags: ['工作台'],
  summary: '获取工作台数据',
  description: '返回KPI统计、待办事项、经营趋势、房态速览等数据',
  responses: { 200: { description: '工作台数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Brands ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/brands',
  tags: ['品牌管理'],
  summary: '获取品牌列表',
  description: '返回所有品牌及其门店信息',
  responses: { 200: { description: '品牌列表', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/brands',
  tags: ['品牌管理'],
  summary: '创建/更新/删除品牌',
  description: '通过action字段区分操作类型',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Stores ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/stores',
  tags: ['门店管理'],
  summary: '获取门店/房型/房间/设备',
  description: '通过type参数区分：默认返回门店列表，roomTypes=房型，rooms=房间，devices=设备，storeDetail=门店详情',
  request: { query: z.object({ type: z.enum(['roomTypes', 'rooms', 'devices', 'storeDetail']).optional(), storeId: z.string().optional() }) },
  responses: { 200: { description: '门店相关数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Rooms ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/rooms',
  tags: ['房态管理'],
  summary: '获取日房态/月房态/预订',
  description: '通过type参数区分：daily=日房态，monthly=月房态，bookings=预订',
  request: { query: z.object({ type: z.enum(['daily', 'monthly', 'bookings']), date: z.string().optional(), year: z.string().optional(), month: z.string().optional() }) },
  responses: { 200: { description: '房态数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/rooms',
  tags: ['房态管理'],
  summary: '创建预订',
  description: '提交新预订信息',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'put',
  path: '/api/rooms',
  tags: ['房态管理'],
  summary: '更新房态',
  description: '修改房间状态、批量操作等',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Orders ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/orders',
  tags: ['订单管理'],
  summary: '获取订单/统计/渠道待处理/详情',
  description: '通过type参数区分：list=订单列表，stats=统计，channel-pending=渠道待处理，detail=订单详情',
  request: { query: z.object({ type: z.enum(['list', 'stats', 'channel-pending', 'detail']).optional(), id: z.string().optional(), channel: z.string().optional(), status: z.string().optional(), keyword: z.string().optional() }) },
  responses: { 200: { description: '订单数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/orders',
  tags: ['订单管理'],
  summary: '创建/确认/取消订单',
  description: '通过action字段区分操作类型',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'put',
  path: '/api/orders',
  tags: ['订单管理'],
  summary: '批量确认/取消订单',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'delete',
  path: '/api/orders',
  tags: ['订单管理'],
  summary: '删除订单',
  request: { body: { content: { 'application/json': { schema: z.object({ id: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Pricing ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/pricing',
  tags: ['价格管理'],
  summary: '获取价格日历/基础房价/限时特价/AI定价',
  description: '通过type参数区分：默认=基础房价+促销，calendar=价格日历，rules=价格规则，channel-pricing=渠道价格，promotions=促销，ai=AI定价',
  request: { query: z.object({ type: z.enum(['calendar', 'rules', 'channel-pricing', 'promotions', 'ai']).optional() }) },
  responses: { 200: { description: '价格数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/pricing',
  tags: ['价格管理'],
  summary: '修改价格/应用AI建议',
  description: '通过action字段区分操作类型',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Channels ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/channels',
  tags: ['渠道管理'],
  summary: '获取渠道列表/评价/同步状态',
  description: '通过type参数区分：默认=渠道列表+汇总，mappings=渠道映射，sync=同步状态，inventory=库存，reviews=评价',
  request: { query: z.object({ type: z.enum(['mappings', 'sync', 'inventory', 'reviews']).optional() }) },
  responses: { 200: { description: '渠道数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/channels',
  tags: ['渠道管理'],
  summary: '同步库存/回复评价',
  description: '通过action字段区分操作类型',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Finance ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/finance',
  tags: ['收支明细'],
  summary: '获取收支流水/对账提醒/报表',
  description: '通过type参数区分：transactions=收支流水，reconciliation=对账提醒，report=报表',
  request: { query: z.object({ type: z.enum(['transactions', 'reconciliation', 'report']) }) },
  responses: { 200: { description: '财务数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Customers ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/customers',
  tags: ['客户管理'],
  summary: '获取客户/标签/统计/关怀',
  description: '通过type参数区分：list=客户列表，tags=标签，stats=统计，detail=详情，care=关怀，auto-rules=自动标签规则',
  request: { query: z.object({ type: z.enum(['list', 'tags', 'stats', 'detail', 'care', 'auto-rules']).optional(), id: z.string().optional(), keyword: z.string().optional(), tag: z.string().optional(), level: z.string().optional() }) },
  responses: { 200: { description: '客户数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/customers',
  tags: ['客户管理'],
  summary: '添加客户/编辑标签/管理关怀',
  description: '通过action字段区分操作类型',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Staff ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/staff',
  tags: ['团队管理'],
  summary: '获取员工/角色/操作日志',
  description: '默认返回员工列表+统计+角色+日志，type=roles仅角色，type=logs仅日志',
  request: { query: z.object({ type: z.enum(['roles', 'logs']).optional(), module: z.string().optional(), operator: z.string().optional() }) },
  responses: { 200: { description: '团队数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/staff',
  tags: ['团队管理'],
  summary: '添加员工/角色',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'put',
  path: '/api/staff',
  tags: ['团队管理'],
  summary: '编辑员工/角色',
  request: { body: { content: { 'application/json': { schema: z.object({ action: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'delete',
  path: '/api/staff',
  tags: ['团队管理'],
  summary: '删除员工/角色',
  request: { body: { content: { 'application/json': { schema: z.object({ id: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- Settings ---
app.openapi(createRoute({
  method: 'get',
  path: '/api/settings',
  tags: ['系统设置'],
  summary: '获取系统设置',
  description: '通过type参数区分：basic=基础信息，business=业务参数，subscription=订阅管理，security=安全设置',
  request: { query: z.object({ type: z.enum(['basic', 'business', 'subscription', 'security']) }) },
  responses: { 200: { description: '设置数据', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

app.openapi(createRoute({
  method: 'post',
  path: '/api/settings',
  tags: ['系统设置'],
  summary: '更新系统设置',
  description: '通过type字段区分设置类型',
  request: { body: { content: { 'application/json': { schema: z.object({ type: z.string() }) } } } },
  responses: { 200: { description: '操作结果', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- AI Chat ---
app.openapi(createRoute({
  method: 'post', path: '/api/ai/chat', tags: ['AI助手'],
  summary: 'AI 流式对话', description: 'SSE 流式返回 AI 分析结果',
  request: { body: { content: { 'application/json': { schema: z.object({ message: z.string(), history: z.array(z.any()).optional() }) } } } },
  responses: { 200: { description: 'SSE 流式事件', content: { 'text/event-stream': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- AI Insights ---
app.openapi(createRoute({
  method: 'get', path: '/api/ai/insights', tags: ['AI助手'],
  summary: '获取 AI 洞察列表', description: '返回活跃的 AI 洞察和建议',
  responses: { 200: { description: '洞察列表', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// --- AI Mode ---
app.openapi(createRoute({
  method: 'get', path: '/api/ai/mode', tags: ['AI助手'],
  summary: '获取 AI 模式配置', description: '返回当前租户的 AI 模式状态和模块开关',
  responses: { 200: { description: '模式配置', content: { 'application/json': { schema: AnyResponse } } } },
}), (c) => c.json({}));

// ============================================================
// OpenAPI 文档端点
// ============================================================
app.doc('/api/doc', {
  openapi: '3.0.0',
  info: {
    title: '酒店PMS管理后台 API',
    version: '1.0.0',
    description: '酒店PMS商家管理后台 OpenAPI 契约文档 - 前后端分仓架构的接口契约层。AI 助手能力由 pms-agent 服务提供（/api/ai/chat、/api/video-script、/api/model 等）',
  },
  servers: [
    { url: 'http://localhost:9090', description: '开发环境' },
  ],
  tags: [
    { name: '工作台', description: 'Dashboard KPI数据' },
    { name: '品牌管理', description: '品牌CRUD' },
    { name: '门店管理', description: '门店/房型/房间/设备' },
    { name: '房态管理', description: '日房态/月房态/预订' },
    { name: '订单管理', description: '订单CRUD/渠道待处理' },
    { name: '价格管理', description: '价格日历/基础房价/限时特价/AI定价' },
    { name: '渠道管理', description: '渠道直连/评价管理' },
    { name: '收支明细', description: '收支流水/对账提醒' },
    { name: '客户管理', description: '客户列表/标签/关怀' },
    { name: '团队管理', description: '员工/角色/操作日志' },
    { name: '系统设置', description: '基础信息/业务参数/订阅/安全' },
    { name: 'AI助手', description: 'AI 对话/洞察/模式管理' },
    { name: 'OTA直连', description: 'OTA RPA 客户端订单上报/心跳/配置' },
  ],
});

// Swagger UI 静态资源（本地化，不再依赖CDN）
app.get('/api/swagger-ui.css', () => {
  const css = readFileSync(join(import.meta.dirname, '..', 'node_modules', 'swagger-ui-dist', 'swagger-ui.css'), 'utf-8');
  return new Response(css, { headers: { 'Content-Type': 'text/css; charset=utf-8' } });
});

app.get('/api/swagger-ui-bundle.js', () => {
  const js = readFileSync(join(import.meta.dirname, '..', 'node_modules', 'swagger-ui-dist', 'swagger-ui-bundle.js'), 'utf-8');
  return new Response(js, { headers: { 'Content-Type': 'application/javascript; charset=utf-8' } });
});

// Swagger UI
app.get('/api/swagger', (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>酒店PMS API 文档</title>
  <link rel="stylesheet" href="/api/swagger-ui.css" />
  <style>
    body { margin: 0; background: #fafafa; }
    .swagger-ui .topbar { display: none; }
    .swagger-ui .info .title { font-size: 28px; }
  </style>
</head>
<body>
  <div id="swagger-ui"></div>
  <script src="/api/swagger-ui-bundle.js"></script>
  <script>
    SwaggerUIBundle({
      url: '/api/doc',
      dom_id: '#swagger-ui',
      presets: [
        SwaggerUIBundle.presets.apis,
        SwaggerUIBundle.SwaggerUIStandalonePreset
      ],
      layout: "BaseLayout",
    });
  </script>
</body>
</html>`);
});

export default app;
