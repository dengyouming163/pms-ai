import { Hono } from 'hono';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';
import { db } from '../../db/index.js';
import { pmsBuiMpConfig } from '../../db/schema/index.js';
import { getMpConfig, getEffectiveConfig, clearMpConfigCache, buildSeedConfig, type MpConfig } from '../../services/mp-reply.js';
import { createMenu } from '../../services/wechat-mp.js';
import { serverError } from '../../lib/http-error.js';

// ============================================================
// 公众号运营配置内部 API（pms-platform-web 后台调用）
//
// 鉴权：内部服务 Token（X-Internal-Service-Token == INTERNAL_SERVICE_TOKEN）。
// 全局 authMiddleware 已跳过 /api/admin/*（不要求平台/员工 JWT），本路由内自行校验。
// 菜单/自动回复配置在 pms-server 落库，平台后台读写；回调（handleMpMessage）与同步菜单读 DB。
// ============================================================

const route = new Hono();

/** 内部服务 Token 校验（复用 /api/internal/* 同款鉴权约定） */
route.use('*', async (c, next) => {
  if (c.req.header('X-Internal-Service-Token') !== INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: '禁止访问：内部服务认证失败' }, 403);
  }
  return next();
});

/** 配置写入校验（全部字段可选：PUT 为整体覆盖式，缺省字段回落到种子默认） */
const mpConfigSchema = z.object({
  menu: z.any().optional(),
  welcome: z.string().max(5000).optional(),
  keywordReplies: z.array(z.object({ keywords: z.array(z.string().min(1)).min(1), reply: z.string().min(1).max(2000) })).optional(),
  defaultReply: z.string().max(2000).optional(),
});

// GET /api/admin/mp-config → 查 id=1；无则用种子默认（mp-menu.ts/mp-reply.ts）初始化并返回
route.get('/', async (c) => {
  const [row] = await db.select().from(pmsBuiMpConfig).where(eq(pmsBuiMpConfig.id, 1)).limit(1);
  const config = getEffectiveConfig(row);
  return c.json({ success: true, data: config });
});

// PUT /api/admin/mp-config → upsert id=1（menu/welcome/keywordReplies/defaultReply），返回更新后配置
route.put('/', async (c) => {
  const parsed = mpConfigSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：' + parsed.error.issues[0].message }, 400);

  const [existing] = await db.select().from(pmsBuiMpConfig).where(eq(pmsBuiMpConfig.id, 1)).limit(1);
  if (existing) {
    await db.update(pmsBuiMpConfig).set({ ...parsed.data, updatedAt: new Date() }).where(eq(pmsBuiMpConfig.id, 1));
  } else {
    // 首次写入以种子为基底，只覆盖传入字段，避免其余字段变空
    const base: MpConfig = buildSeedConfig();
    await db.insert(pmsBuiMpConfig).values({ id: 1, ...base, ...parsed.data });
  }
  // 新配置立即生效（回调/同步菜单读缓存）
  clearMpConfigCache();

  const [row] = await db.select().from(pmsBuiMpConfig).where(eq(pmsBuiMpConfig.id, 1)).limit(1);
  return c.json({ success: true, data: getEffectiveConfig(row) });
});

// POST /api/admin/mp-config/sync-menu → 读 DB menu → createMenu 同步到微信
route.post('/sync-menu', async (c) => {
  const config = await getMpConfig();
  if (!config.menu?.button?.length) return c.json({ success: false, error: '未配置菜单' }, 400);
  try {
    await createMenu(config.menu);
    return c.json({ success: true, message: '菜单同步成功' });
  } catch (e: any) {
    return serverError(c, e, '菜单同步失败', 502);
  }
});

export default route;
