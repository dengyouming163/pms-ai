import crypto from 'node:crypto';
import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import type Redis from 'ioredis';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiMiniUsers } from '../../db/schema/index.js';
import { code2Session as wxCode2Session, code2SessionMp, getPhoneNumber as wxGetPhoneNumber } from '../../services/wechat-mini.js';
import { code2Session as dyCode2Session, getPhoneNumber as dyGetPhoneNumber } from '../../services/douyin-mini.js';
import { getRedis } from '../../services/redis.js';
import { sendSmsCode } from '../../services/sms.js';
import { requireEnv, MINI_TOKEN_EXPIRES } from '../../constants.js';
import { getMiniUser, MINI_JWT_AUDIENCE, type MiniAuthUser } from '../../middleware/mini-auth.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

/** 同步用户到 CDP（非阻塞，失败不影响登录） */
async function syncToCDP(data: { openid: string; unionid?: string | null; phone?: string | null; nickname?: string | null; avatar?: string | null; platform?: string }) {
  try {
    const token = process.env.INTERNAL_SERVICE_TOKEN || '';
    await fetch('http://pms-platform-server:9092/api/internal/customer/sync', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Token': token },
      body: JSON.stringify({ ...data, source: 'mini_program' }),
      signal: AbortSignal.timeout(5000),
    });
  } catch { /* 非关键，静默失败 */ }
}

/** h5（普通浏览器手机号验证码）用户的 openid 占位前缀：满足 openid NOT NULL + (platform, openid) 复合唯一 */
const H5_OPENID_PREFIX = 'h5_';

/** upsert 迷你用户（platform + openid 复合唯一），返回用户行 */
async function upsertMiniUser(platform: string, openid: string, extra?: { phone?: string; unionid?: string | null }): Promise<any> {
  let [user] = await db.select().from(pmsBuiMiniUsers)
    .where(and(eq(pmsBuiMiniUsers.platform, platform), eq(pmsBuiMiniUsers.openid, openid))).limit(1);
  if (!user) {
    const id = `mnu_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    [user] = await db.insert(pmsBuiMiniUsers).values({
      id,
      platform,
      openid,
      ...(extra?.phone ? { phone: extra.phone } : {}),
      ...(extra?.unionid ? { unionid: extra.unionid } : {}),
    }).onConflictDoNothing().returning();
    // 并发首登竞态：冲突时 returning 为空，重查已存在的记录
    if (!user) {
      [user] = await db.select().from(pmsBuiMiniUsers)
        .where(and(eq(pmsBuiMiniUsers.platform, platform), eq(pmsBuiMiniUsers.openid, openid))).limit(1);
    }
  }
  return user;
}

/** 签发 C 端 JWT */
function issueMiniToken(user: any, platform: string): string {
  const payload: MiniAuthUser = { miniUserId: user.id, openid: user.openid, platform };
  return jwt.sign(payload, requireEnv('MINI_JWT_SECRET'), { expiresIn: MINI_TOKEN_EXPIRES, audience: MINI_JWT_AUDIENCE });
}

const loginSchema = z.object({
  code: z.string().min(1),
  platform: z.enum(['wx', 'douyin', 'wx_mp']).optional().default('wx'),
});

// 平台静默登录：code → openid → upsert 用户 → 签发 C端 JWT（platform 区分微信/公众号/抖音）
route.post('/login', async (c) => {
  const parsed = loginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);
  const { code, platform } = parsed.data;

  // 平台侧失败（code 无效/appid 配置错误）以 JSON 返回，避免裸 500
  let session;
  try {
    session = platform === 'douyin'
      ? await dyCode2Session(code)
      : platform === 'wx_mp'
        ? await code2SessionMp(code)
        : await wxCode2Session(code);
  } catch (e) {
    return serverError(c, e, '登录失败', 502);
  }

  // 按 (platform, openid) upsert 用户
  const user = await upsertMiniUser(platform, session.openid, { unionid: session.unionid });
  if (!user) return c.json({ success: false, error: '登录失败，请稍后重试' }, 500);
  if (user.status !== 'active') return c.json({ success: false, error: '账号已被禁用' }, 403);

  const token = issueMiniToken(user, platform);

  // 同步到 CDP（非阻塞）
  syncToCDP({ openid: user.openid, unionid: user.unionid, phone: user.phone, nickname: user.nickname, avatar: user.avatar, platform });

  return c.json({
    success: true,
    data: { token, user: { id: user.id, platform, phone: user.phone, nickname: user.nickname, avatar: user.avatar } },
  });
});

const bindPhoneSchema = z.object({ code: z.string().min(1) });

// 手机号授权绑定（需登录；按 JWT 内 platform 走对应平台的手机号接口）
route.post('/bind-phone', async (c) => {
  const miniUser = getMiniUser(c);
  const parsed = bindPhoneSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);

  // 平台侧失败以 JSON 返回，避免裸 500
  let phone;
  try {
    phone = miniUser.platform === 'douyin'
      ? await dyGetPhoneNumber(parsed.data.code)
      : await wxGetPhoneNumber(parsed.data.code);
  } catch (e) {
    return serverError(c, e, '获取手机号失败', 502);
  }
  await db.update(pmsBuiMiniUsers)
    .set({ phone, updatedAt: new Date() })
    .where(eq(pmsBuiMiniUsers.id, miniUser.miniUserId));

  // 同步手机号到 CDP
  syncToCDP({ openid: miniUser.openid, phone, platform: miniUser.platform });

  return c.json({ success: true, data: { phone } });
});

const sendCodeSchema = z.object({ phone: z.string().regex(/^1\d{10}$/) });
const phoneLoginSchema = z.object({ phone: z.string().regex(/^1\d{10}$/), code: z.string().regex(/^\d{6}$/) });
const bindPhoneCodeSchema = z.object({ phone: z.string().regex(/^1\d{10}$/), code: z.string().regex(/^\d{6}$/) });

// 发送验证码（原子 60s 节流 + 每手机号每日上限 + 每 IP 每分钟上限；验证码存 redis 5 分钟）
route.post('/send-code', async (c) => {
  const parsed = sendCodeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '手机号格式不正确' }, 400);
  const phone = parsed.data.phone;
  const redis = getRedis();
  if (!redis) return c.json({ success: false, error: '验证码服务暂不可用' }, 500);

  // 原子 60s 节流（NX 锁，防并发双发）
  const lockKey = `sms:mini:${phone}:lock`;
  const locked = await redis.set(lockKey, '1', 'EX', 60, 'NX');
  if (!locked) return c.json({ success: false, error: '验证码发送过于频繁，请稍后再试' }, 429);
  // 每手机号每日上限（10次）
  const dayKey = `sms:mini:${phone}:day`;
  const dayCount = await redis.incr(dayKey);
  if (dayCount === 1) await redis.expire(dayKey, 86400);
  if (dayCount > 10) {
    await redis.del(lockKey);
    return c.json({ success: false, error: '今日发送次数已达上限' }, 429);
  }
  // 每 IP 每分钟上限（5次）
  const ip = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  const ipKey = `sms:mini:ip:${ip}`;
  const ipCount = await redis.incr(ipKey);
  if (ipCount === 1) await redis.expire(ipKey, 60);
  if (ipCount > 5) {
    await redis.del(lockKey);
    return c.json({ success: false, error: '发送过于频繁，请稍后再试' }, 429);
  }

  const code = crypto.randomInt(100000, 1000000).toString();
  await redis.set(`sms:mini:${phone}`, JSON.stringify({ code, t: Date.now(), attempts: 0 }), 'EX', 300);
  // 发送失败时回滚计数并清除验证码，保持「失败可重试」语义
  try {
    await sendSmsCode(phone, code);
  } catch (e) {
    await redis.del(`sms:mini:${phone}`);
    await redis.del(lockKey);
    await redis.decr(dayKey);
    await redis.decr(ipKey);
    return serverError(c, e, '验证码发送失败', 502);
  }
  return c.json({ success: true });
});

/**
 * 校验短信验证码（复用 send-code 存的 redis 记录 `sms:mini:{phone}`）。
 * 成功则删除验证码并返回 null；失败返回 { status, error }（调用方直接透传响应）。
 * 语义与 phone-login 保持一致：5 分钟过期作废 + 连续错 5 次作废防爆破。
 */
async function verifySmsCode(redis: Redis, phone: string, code: string): Promise<{ status: 400 | 429; error: string } | null> {
  const key = `sms:mini:${phone}`;
  const stored = await redis.get(key);
  if (!stored) return { status: 400, error: '验证码已过期，请重新获取' };
  const rec = JSON.parse(stored) as { code: string; t: number; attempts?: number };
  // 超过 5 分钟即作废并删除，防止残留
  if (Date.now() - rec.t > 300_000) {
    await redis.del(key);
    return { status: 400, error: '验证码已过期，请重新获取' };
  }
  // 防爆破：连续错 5 次作废并删除
  if (rec.code !== code) {
    const attempts = (rec.attempts || 0) + 1;
    if (attempts >= 5) {
      await redis.del(key);
      return { status: 429, error: '尝试次数过多，请重新获取验证码' };
    }
    await redis.set(key, JSON.stringify({ ...rec, attempts }), 'EX', 300);
    return { status: 400, error: '验证码错误' };
  }
  await redis.del(key);
  return null;
}

// 手机号验证码登录（普通浏览器 H5；platform='h5'，openid 用 h5_手机号 占位以满足 NOT NULL + (platform, openid) 复合唯一）
route.post('/phone-login', async (c) => {
  const parsed = phoneLoginSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误' }, 400);
  const redis = getRedis();
  if (!redis) return c.json({ success: false, error: '验证码服务暂不可用' }, 500);
  const phone = parsed.data.phone;
  // 校验验证码（复用 send-code 存的记录，含 5 分钟过期 + 防爆破）
  const verifyError = await verifySmsCode(redis, phone, parsed.data.code);
  if (verifyError) return c.json({ success: false, error: verifyError.error }, verifyError.status);
  // upsert 用户（platform='h5'，openid 用 h5_手机号 占位以满足 NOT NULL + 复合唯一）
  const user = await upsertMiniUser('h5', H5_OPENID_PREFIX + phone, { phone });
  if (!user) return c.json({ success: false, error: '登录失败，请稍后重试' }, 500);
  if (user.status !== 'active') return c.json({ success: false, error: '账号已被禁用' }, 403);

  const token = issueMiniToken(user, 'h5');

  // 同步到 CDP（非阻塞）
  syncToCDP({ openid: user.openid, phone: user.phone, platform: 'h5' });

  return c.json({ success: true, data: { token, user: { id: user.id, platform: 'h5', phone: user.phone } } });
});

// 手机号+验证码绑定到当前登录用户（公众号 H5 场景，区别于 phone-login 新建 h5 用户；需登录）
route.post('/bind-phone-code', async (c) => {
  const miniUser = getMiniUser(c);
  const parsed = bindPhoneCodeSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误' }, 400);
  const redis = getRedis();
  if (!redis) return c.json({ success: false, error: '验证码服务暂不可用' }, 500);
  const { phone, code } = parsed.data;
  // 校验验证码（复用 send-code 存的记录，含 5 分钟过期 + 防爆破）
  const verifyError = await verifySmsCode(redis, phone, code);
  if (verifyError) return c.json({ success: false, error: verifyError.error }, verifyError.status);
  // 更新当前用户的手机号（不动 openid/platform，保留登录身份）
  await db.update(pmsBuiMiniUsers)
    .set({ phone, updatedAt: new Date() })
    .where(eq(pmsBuiMiniUsers.id, miniUser.miniUserId));
  // 同步手机号到 CDP（与 bind-phone 一致，非阻塞）
  syncToCDP({ openid: miniUser.openid, phone, platform: miniUser.platform });
  return c.json({ success: true, data: { phone } });
});

// 当前登录用户信息
route.get('/me', async (c) => {
  const miniUser = getMiniUser(c);
  const [user] = await db.select().from(pmsBuiMiniUsers).where(eq(pmsBuiMiniUsers.id, miniUser.miniUserId)).limit(1);
  if (!user) return c.json({ success: false, error: '用户不存在' }, 404);
  // lastGuest: 客人信息持久化 — 下单后保存，下次打开小程序直接回显
  const lastGuest = (user as any).guestName
    ? { name: (user as any).guestName, phone: (user as any).guestPhone }
    : null;
  return c.json({ success: true, data: { id: user.id, phone: user.phone, nickname: user.nickname, avatar: user.avatar, lastGuest } });
});

export default route;
