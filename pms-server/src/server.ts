import { serve } from '@hono/node-server';
import app from './index';
import { initRedis } from './services/redis.js';
import { startMiniScheduler } from './services/mini-scheduler.js';
import { startCommissionScheduler } from './services/commission-scheduler.js';
import { startPriceRobotScheduler, startDailyRitual } from './services/price-robot-scheduler.js';
import { startAssetTaskScheduler } from './services/asset-task-scheduler.js';
import { startCheckinNotifyScheduler } from './services/checkin-notify-scheduler.js';
import { startSatisfactionScheduler } from './services/satisfaction-scheduler.js';
import { startWenlvAssetGenScheduler } from './services/wenlv-asset-gen-scheduler.js';
import { startNpcGenScheduler } from './services/wenlv/npc-gen/npc-gen-scheduler.js';
import { startPlatformOrderSyncScheduler } from './services/platform-order-sync-scheduler.js';

// 初始化 Redis（优雅降级，不可用时继续运行）
await initRedis();

// 私域小程序后台任务（预订单超时释放）
startMiniScheduler();

// 分销佣金解冻调度（离店 T+1 解冻）
startCommissionScheduler();

// 自动收益管家 — 17/19/21 时点（北京时间）生成改价任务（stale 清理 + 每日仪式的宿主）
startPriceRobotScheduler();

// 定价中心 v1：每日 8:00（北京时间）出卡仪式（预计算 + 有变化留痕）
startDailyRitual();

// 自动收益管家 二期 — 未来 14 天计划已被定价中心 v1 砍掉，停用（代码保留以便日后启用）
// startPriceRobotPlanner();

// 自动化打卡任务 — 扫描到期规则并幂等生成当日任务
startAssetTaskScheduler();

// 入住前 24 小时提醒 — 明天入住的已确认套餐订单 → 微信订阅消息（未授权/未配置降级站内消息）
startCheckinNotifyScheduler();

// 平台订单转化补偿（回调丢失兜底，60s 轮询）
startPlatformOrderSyncScheduler();

// C2 差评预检 — 离店 1h 回访问卷（满意度 + 差评发补偿券）
startSatisfactionScheduler();

// 文旅素材生成（S3）— 60s 推进：超时收口 → 先领锚图 → 再领其余 → 同步生成 → 落库回写
startWenlvAssetGenScheduler();

// 文旅 NPC 生成/优化 — 10s 轮询：领取 pending job → 调 AI crew → 写库 → 标记状态
startNpcGenScheduler();

const port = Number(process.env.PORT) || 20002;

console.log(`[pms-server] Starting server on port ${port}...`);

serve({
  fetch: app.fetch,
  port,
});

console.log(`[pms-server] Server is running on http://localhost:${port}`);
