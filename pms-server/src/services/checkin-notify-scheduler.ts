/**
 * 入住前 24 小时提醒调度器（D3，Task5）
 *
 * 触发条件：套餐订单（平台库 pms_platform_product_orders）预约已确认
 *  （reservationStatus='confirmed'）且入住日期（reservationDate）= 明天（北京时区）。
 * 投递通道（降级链）：
 *  1) 主通道：微信订阅消息 —— 用户已登记授权 + WX_SUBSCRIBE_TEMPLATE_ID 已配置 → sendSubscribeMessage；
 *  2) 降级通道：站内消息（pms_bui_inbox_messages）—— 未授权 / 模板未配置 / 微信发送失败时兜底。
 *
 * 数据访问边界：平台订单在平台库（跨 schema 禁止直查），按项目规范经 pms-platform-server
 *  内部接口（X-Internal-Token）分页拉取 confirmed 订单，再在本地按「入住日期=明天（北京时区）」筛选。
 *  当前平台列表接口不支持按 reservationDate 服务端过滤，故用分页全量拉取 + 本地筛选（MVP 量级足够；
 *  若订单量上涨，后续可在平台侧为列表接口增加 reservationDate 查询参数）。
 *
 * 幂等：以站内消息表为台账 —— 每个 (miniUserId, orderId, type='remind') 只投递一次；
 *  每次投递（无论是否走微信成功）都写一条 remind 站内消息，已存在则跳过，
 *  避免每 60s 一轮 tick 对同一订单重复推送。
 */
import { eq, and } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiSubscribeAuths, pmsBuiInboxMessages } from '../db/schema/index.js';
import { sendSubscribeMessage } from './wechat-mini.js';
import { listConfirmedProductOrders } from './platform-client.js';

/** 北京时区（UTC+8）明天日期 YYYY-MM-DD：UTC 时刻 +8h 再 +24h，取 UTC 日期即北京日历日期 */
function beijingTomorrow(): string {
  return new Date(Date.now() + 8 * 3600 * 1000 + 86400000).toISOString().slice(0, 10);
}

/**
 * 组装订阅消息模板 data。
 * 字段键（thing1/date2/thing3）须与微信后台 WX_SUBSCRIBE_TEMPLATE_ID 模板的字段定义一致；
 * 实际模板字段不同时需在此同步调整（字段缺失/多传微信会返回 errcode）。
 * 微信字段上限：thing 类 ≤20 字符、date 类 ≤10 字符，超长返回 47003，故统一截断兜底。
 */
function buildTemplateData(order: any): Record<string, { value: string }> {
  const clip = (s: string, n: number) => String(s).slice(0, n);
  return {
    thing1: { value: clip(order.orderNo || order.id, 20) },  // 订单号
    date2: { value: clip(order.reservationDate, 10) },       // 入住日期
    thing3: { value: clip('明天入住，请到店出示核销码', 20) }, // 提醒内容（≤20）
  };
}

/**
 * 对单个「明天入住 + 已确认」订单投递提醒。
 * @returns 'wechat' 微信发送成功 / 'inbox' 降级站内消息 / 'skipped' 已通知过
 */
async function notifyOrder(order: any): Promise<'wechat' | 'inbox' | 'skipped'> {
  const content = `您预订的套餐将于明天（${order.reservationDate}）入住，请准时到店，到店出示核销码即可办理入住。`;

  // 幂等闸门：先插入站内消息台账（onConflictDoNothing + returning）——
  // 唯一键 (mini_user_id, order_id, type) 保证同一订单提醒只被抢到一次；
  // returning 为空 = 台账已存在（其他 tick/实例已投递）→ 跳过，杜绝 check-then-insert 竞态导致重复推送。
  const [claimed] = await db.insert(pmsBuiInboxMessages).values({
    id: `ibx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    miniUserId: order.miniUserId,
    orderId: order.id,
    type: 'remind',
    title: '入住提醒',
    content,
  }).onConflictDoNothing().returning({ id: pmsBuiInboxMessages.id });
  if (!claimed) return 'skipped';

  // 主通道：微信订阅消息（best-effort，失败不阻断——站内消息已落库即降级兜底）
  let wechatSent = false;
  const templateId = process.env.WX_SUBSCRIBE_TEMPLATE_ID || '';
  if (templateId) {
    const [auth] = await db.select().from(pmsBuiSubscribeAuths)
      .where(and(
        eq(pmsBuiSubscribeAuths.miniUserId, order.miniUserId),
        eq(pmsBuiSubscribeAuths.templateId, templateId),
      ))
      .limit(1);
    if (auth) {
      try {
        const result = await sendSubscribeMessage(auth.openid, templateId, buildTemplateData(order));
        wechatSent = result.success;
        if (!wechatSent) {
          console.warn(`[checkin-notify] 微信订阅消息发送失败 order=${order.id} errcode=${result.errcode} errmsg=${result.errmsg}（站内消息已兜底）`);
        }
      } catch (err) {
        console.warn(`[checkin-notify] 微信订阅消息异常 order=${order.id}（站内消息已兜底）:`, err);
      }
    }
  }

  return wechatSent ? 'wechat' : 'inbox';
}

/** 扫描一次：明天（北京时区）入住且预约已确认的订单 → 投递提醒。返回投递/跳过计数 */
export async function runCheckinNotifyScan(): Promise<{ candidates: number; notified: number; skipped: number }> {
  const tomorrow = beijingTomorrow();
  const orders = await listConfirmedProductOrders();
  // 仅预约已确认（reservationStatus=confirmed）且入住=明天；排除已取消/退款/已核销
  const candidates = (orders || []).filter((o) =>
    o && o.miniUserId && o.reservationStatus === 'confirmed' && o.reservationDate === tomorrow
      && !['cancelled', 'refunded', 'used'].includes(o.status),
  );

  let notified = 0;
  let skipped = 0;
  for (const o of candidates) {
    const result = await notifyOrder(o);
    if (result === 'skipped') skipped++;
    else notified++;
  }
  if (candidates.length > 0) {
    console.log(`[checkin-notify] 明天入住 confirmed 订单 ${candidates.length} 笔（confirmed 总量 ${orders?.length ?? 0}），投递 ${notified}，已通知跳过 ${skipped}`);
  }
  return { candidates: candidates.length, notified, skipped };
}

/** 启动入住前 24h 提醒调度器（server.ts 调用一次）；启动即扫描一次，之后每 intervalMs 扫描 */
export function startCheckinNotifyScheduler(intervalMs = 60_000): void {
  setInterval(async () => {
    try {
      await runCheckinNotifyScan();
    } catch (err) {
      console.error('[checkin-notify] 扫描失败:', err);
    }
  }, intervalMs);
  // 启动即扫一次，部署后无需等待首个 interval 即可补投
  runCheckinNotifyScan().catch((err) => console.error('[checkin-notify] 首次扫描失败:', err));
  console.log(`[checkin-notify] 已启动（每 ${intervalMs / 1000}s 检查入住前 24h 提醒）`);
}
