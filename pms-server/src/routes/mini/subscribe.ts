import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { pmsBuiSubscribeAuths } from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

const subscribeSchema = z.object({
  templateId: z.string().min(1).max(64),
});

/**
 * POST /api/mini/subscribe — 登记微信订阅消息授权（需登录）
 * body: { templateId }；miniUserId/openid 均取 JWT（登录时 code2Session 绑定，JWT 恒含 openid；
 * 不信任 body openid，杜绝代他人登记授权）。同 (miniUserId, templateId) 幂等 upsert。
 * 仅微信小程序适用（抖音端无微信订阅消息通道）。
 */
route.post('/', async (c) => {
  try {
    const miniUser = getMiniUser(c);
    const parsed = subscribeSchema.safeParse(await c.req.json().catch(() => ({})));
    if (!parsed.success) {
      return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
    }

    // 抖音端不支持微信订阅消息，登记无意义
    if (miniUser.platform && miniUser.platform !== 'wx') {
      return c.json({ success: false, error: '该平台暂不支持微信订阅消息' }, 400);
    }

    const { templateId } = parsed.data;
    const openid = miniUser.openid;

    const id = `sba_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    await db.insert(pmsBuiSubscribeAuths)
      .values({ id, miniUserId: miniUser.miniUserId, openid, templateId })
      .onConflictDoUpdate({
        target: [pmsBuiSubscribeAuths.miniUserId, pmsBuiSubscribeAuths.templateId],
        set: { openid, authorizedAt: new Date() },
      });

    return c.json({ success: true, data: { templateId } });
  } catch (e: any) {
    return serverError(c, e, '登记失败');
  }
});

export default route;
