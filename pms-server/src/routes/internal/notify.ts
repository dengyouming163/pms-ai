import { Hono } from 'hono';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiMiniUsers, pmsBuiSubscribeAuths, pmsBuiInboxMessages } from '../../db/schema/index.js';
import { sendSubscribeMessage } from '../../services/wechat-mini.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

/**
 * POST /api/internal/notify
 * C1/C2 共用内部通知接口（需 internalAuthMiddleware 校验 X-Internal-Service-Token）。
 *
 * 平台端触发场景：pay-confirm / reservation-approve 等 C1 事件需通知 C 端客人；
 * 通知能力（微信订阅消息 + 站内消息）位于 pms-server，故平台端经内部 HTTP 调用本接口。
 *
 * body:
 *   miniUserId  string   C端小程序用户 id（必填）
 *   orderId     string   关联订单 id（幂等键一部分，必填）
 *   type        string   消息类型，由调用方传，如 'guide' / 'survey' / 'order_status'（必填）
 *   title       string   站内消息标题（必填）
 *   content     string?  站内消息正文
 *   wechatData  Record<string, { value: string }>?  微信订阅消息模板字段（键须与微信后台模板一致）
 *   page        string?  点击微信消息跳转的小程序页面
 *
 * 双通道（均 best-effort，任一失败不阻断）：
 *   1) 微信订阅消息 —— 用户已登记订阅授权（pms_bui_subscribe_auths）+ WX_SUBSCRIBE_TEMPLATE_ID
 *      已配置时发送；openid 优先取授权记录（授权时绑定），回退取 pms_bui_mini_users.openid。
 *   2) 站内消息 —— 恒写 pms_bui_inbox_messages；唯一索引 (mini_user_id, order_id, type) +
 *      onConflictDoNothing 保证重复调用不重复投递站内（幂等）。
 *
 * 返回 { success, channel: 'wechat' | 'inbox', wechatErr? }
 *   channel  最终送达通道（wechat 发送成功则为 'wechat'，否则 'inbox' 兜底）
 *   wechatErr 微信通道降级原因（模板未配置 / 未授权 / 发送失败等），未尝试微信时不返回
 */
route.post('/', async (c) => {
  try {
    const body = (await c.req.json().catch(() => ({}))) as {
      miniUserId?: string;
      orderId?: string;
      type?: string;
      title?: string;
      content?: string;
      wechatData?: Record<string, { value: string }>;
      page?: string;
    };

    const { miniUserId, orderId, type, title, content, wechatData, page } = body;
    if (!miniUserId || !orderId || !type || !title) {
      return c.json({ success: false, error: '缺少必要参数: miniUserId/orderId/type/title' }, 400);
    }
    // 长度校验须在任何发送前完成：超长会让 inbox insert 报 500，而微信可能已发出 → 调用方重试时重复微信。
    // 长度与 pms_bui_inbox_messages 列定义对齐（mini_user_id/order_id VARCHAR(50)、type VARCHAR(20)、title VARCHAR(100)）。
    if (miniUserId.length > 50) return c.json({ success: false, error: 'miniUserId 长度不能超过 50' }, 400);
    if (orderId.length > 50) return c.json({ success: false, error: 'orderId 长度不能超过 50' }, 400);
    if (type.length > 20) return c.json({ success: false, error: 'type 长度不能超过 20' }, 400);
    if (title.length > 100) return c.json({ success: false, error: 'title 长度不能超过 100' }, 400);
    // wechatData 深层校验：显式拒绝数组，且逐项必须是 { value: string } 结构，防脏数据透传微信
    if (wechatData !== undefined) {
      if (typeof wechatData !== 'object' || wechatData === null || Array.isArray(wechatData)) {
        return c.json({ success: false, error: 'wechatData 必须为对象' }, 400);
      }
      for (const [key, item] of Object.entries(wechatData)) {
        if (typeof item !== 'object' || item === null || Array.isArray(item) || typeof (item as any).value !== 'string') {
          return c.json({ success: false, error: `wechatData.${key} 必须为 { value: string } 结构` }, 400);
        }
      }
    }

    let channel: 'wechat' | 'inbox' = 'inbox';
    let wechatErr: string | undefined;

    // 1) 查 C端小程序用户（含 openid）+ 订阅授权
    const [miniUser] = await db.select().from(pmsBuiMiniUsers)
      .where(eq(pmsBuiMiniUsers.id, miniUserId)).limit(1);

    const templateId = process.env.WX_SUBSCRIBE_TEMPLATE_ID || '';
    const [auth] = templateId && wechatData
      ? await db.select().from(pmsBuiSubscribeAuths)
          .where(and(
            eq(pmsBuiSubscribeAuths.miniUserId, miniUserId),
            eq(pmsBuiSubscribeAuths.templateId, templateId),
          )).limit(1)
      : [undefined];

    // 2) 微信订阅消息（best-effort，失败不阻断——站内消息兜底）
    if (auth) {
      const openid = auth.openid || miniUser?.openid;
      if (openid) {
        try {
          const res = await sendSubscribeMessage(
            openid,
            templateId,
            wechatData as Record<string, { value: string }>,
            page,
          );
          if (res.success) {
            channel = 'wechat';
          } else {
            wechatErr = res.errmsg || `errcode=${res.errcode ?? 'unknown'}`;
            console.warn(`[internal-notify] 微信订阅消息发送失败 miniUserId=${miniUserId} orderId=${orderId} errcode=${res.errcode} errmsg=${res.errmsg}（站内消息已兜底）`);
          }
        } catch (e: any) {
          wechatErr = String(e?.message || e);
          console.warn(`[internal-notify] 微信订阅消息异常 miniUserId=${miniUserId} orderId=${orderId}（站内消息已兜底）:`, e);
        }
      } else {
        wechatErr = '未找到 openid';
      }
    } else if (templateId && wechatData && !miniUser) {
      wechatErr = 'miniUserId 不存在';
    } else if (templateId && wechatData) {
      wechatErr = '未授权订阅消息';
    } else if (!templateId && wechatData) {
      wechatErr = 'WX_SUBSCRIBE_TEMPLATE_ID 未配置';
    }

    // 3) 站内消息（幂等：唯一索引 (miniUserId, orderId, type) + onConflictDoNothing）
    const [claimed] = await db.insert(pmsBuiInboxMessages).values({
      id: `ibx_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      miniUserId,
      orderId,
      type,
      title,
      content: content ?? null,
    }).onConflictDoNothing().returning({ id: pmsBuiInboxMessages.id });

    if (!claimed) {
      console.log(`[internal-notify] 站内消息已存在，跳过重复写入 miniUserId=${miniUserId} orderId=${orderId} type=${type}`);
    }

    return c.json({ success: true, channel, ...(wechatErr ? { wechatErr } : {}) });
  } catch (e: any) {
    return serverError(c, e, '通知发送失败');
  }
});

export default route;
