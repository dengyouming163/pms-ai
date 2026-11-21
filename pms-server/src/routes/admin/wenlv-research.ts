// 场地网络调研（采风前 AI 调研）admin API：报告的唯一属主在这里。
//
// 谁调它：
//   · pms-platform-server（BFF）—— 建行与读行（经 X-Internal-Service-Token 转发）；
//   · pms-agent —— **只调 PATCH**，每完成一节回写一次（它不碰数据库）。
// 鉴权与本目录其它 admin 端点逐字同款：X-Internal-Service-Token === INTERNAL_SERVICE_TOKEN。
//
// 判定逻辑（看门狗 / 并发保护 / 逐节状态）**不在这里**，在 services/wenlv-research.ts。
// 理由见那个文件的头注：DB 用例默认整块跳过，判定留在路由里等于静默零覆盖。
import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { INTERNAL_SERVICE_TOKEN } from '../../constants.js';
import { pmsBuiWenlvVenues, pmsBuiWenlvVenueResearch } from '../../db/schema/index.js';
import { decideResearchStart } from '../../services/wenlv-research.js';

const route = new Hono();

route.use('*', async (c, next) => {
  if (c.req.header('X-Internal-Service-Token') !== INTERNAL_SERVICE_TOKEN) {
    return c.json({ error: '禁止访问：内部服务认证失败' }, 403);
  }
  return next();
});

/** 读取发起人（平台用户 id）。同 admin/wenlv.ts 的 platformUserIdFrom：
 *  **仅审计归属，绝不是权限边界** —— 本服务同时接受内部 token 直连，
 *  「头存在」不等于「来自某个真实平台用户」。 */
function platformUserIdFrom(c: any): string | null {
  const raw = c.req.header('X-Platform-User-Id');
  if (typeof raw !== 'string') return null;
  const v = raw.trim();
  return v ? v.slice(0, 50) : null;
}

const anchorSchema = z.object({
  name: z.string().min(1).max(200),
  region: z.string().max(200),
  one_liner: z.string().max(500),
  source_urls: z.array(z.string().max(500)).max(20),
  confidence: z.enum(['high', 'medium', 'low']),
  why: z.string().max(500),
});

/** POST 入参。`anchor` 可省：允许「先建行、后补锚」的调用形态（BFF 目前总是带上）。
 *  `id` 由**客户端**给（幂等键），缺失才由服务端生成 —— 断网重试必须能对上同一行。 */
const startSchema = z.object({
  id: z.string().min(1).max(50).optional(),
  anchor: anchorSchema.optional(),
});

/** PATCH 入参。**每个键都是整体替换**（不是 jsonb 深合并）—— ai-crew 回写的是
 *  **累积快照**，不是增量。深合并的语义说不清楚（数组怎么并？被删的元素去哪？），
 *  而累积快照只有一个含义。 */
const patchSchema = z.object({
  status: z.enum(['running', 'ready', 'partial', 'failed']).optional(),
  anchor: anchorSchema.optional(),
  candidates: z.array(z.any()).optional(),
  report: z.any().optional(),
  progress: z.any().optional(),
  search_log: z.array(z.any()).optional(),
  error: z.string().max(1000).nullable().optional(),
  finished_at: z.coerce.date().nullable().optional(),
});

/** 场地不存在 → 404；存在 → 行。同 admin/wenlv.ts 的 getVenueOr404。 */
async function getVenueOr404(c: any, id: string) {
  const [row] = await db.select().from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, id)).limit(1);
  if (!row) return c.json({ success: false, error: '场地不存在' }, 404);
  return row;
}

// 读场地调研行。**没有行 ⇒ 200 + data: null，不是 404** —— 与同目录「不存在一律 404」的惯例
// 有意不同，理由有二：
//   ① 「这个场地还没做过调研」是**正常业务态**，App 要专门渲染「未做」这一屏；
//      回 404 的话客户端只能读错误文案来判态，而 ops-app 的 request-core 把 404 抛成
//      「请求失败（404）」—— 一线人员会把它读成故障，而不是「还没做」。
//   ② 真正的错误（场地不存在）仍然 404，由上面的 getVenueOr404 表达 ⇒ 两者语义没有混。
route.get('/venues/:id/research', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;
  const [row] = await db.select().from(pmsBuiWenlvVenueResearch)
    .where(eq(pmsBuiWenlvVenueResearch.venueId, venueId)).limit(1);
  return c.json({ success: true, data: row ?? null });
});

// 建行（或重跑覆盖）。判定全在 decideResearchStart（纯函数，已单测）。
route.post('/venues/:id/research', async (c) => {
  const venueId = c.req.param('id');
  const venue = await getVenueOr404(c, venueId);
  if (venue instanceof Response) return venue;

  const parsed = startSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;

  const [existing] = await db.select().from(pmsBuiWenlvVenueResearch)
    .where(eq(pmsBuiWenlvVenueResearch.venueId, venueId)).limit(1);
  const now = new Date();
  const decision = decideResearchStart(existing ?? null, d.id, now);

  if (decision.action === 'conflict') {
    // 名字取自发起人；为空时**不编一个名字出来**
    const who = existing?.startedBy ? `「${existing.startedBy}」` : '有人';
    return c.json({ success: false, error: `${who}正在调研这个场地，请稍后再试` }, 409);
  }

  if (decision.action === 'insert') {
    const [row] = await db.insert(pmsBuiWenlvVenueResearch).values({
      id: d.id || randomUUID(),
      venueId,
      status: 'running',
      anchor: d.anchor ?? null,
      startedBy: platformUserIdFrom(c),
      startedAt: now,
    }).returning();
    return c.json({ success: true, data: row });
  }

  // reset：**同一行**（id 不变），清空上一轮的全部产出。
  // 连 candidates 也清：候选是「这一轮当时看到的世界」，留着上一轮的候选会让排查
  // 「锚为什么错了」时读到过期证据 —— 比没有更糟。
  const [row] = await db.update(pmsBuiWenlvVenueResearch).set({
    status: 'running',
    anchor: d.anchor ?? null,
    candidates: null,
    report: null,
    progress: null,
    searchLog: null,
    error: null,
    finishedAt: null,
    startedBy: platformUserIdFrom(c),
    startedAt: now,
    updatedAt: now,
  }).where(eq(pmsBuiWenlvVenueResearch.id, decision.id)).returning();
  return c.json({ success: true, data: row });
});

// ai-crew 的逐节回写入口。**只有它调**（BFF 不代理这个）。
route.patch('/research/:id', async (c) => {
  const researchId = c.req.param('id');
  const parsed = patchSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  const d = parsed.data;

  // 逐键赋值（只写**提供了**的键）：`.set(patch)` 的键类型没法从 zod 推导，
  // 而这里每个键的列名映射（snake_case 入参 → camelCase 列）必须显式写出来。
  // 用 $inferInsert 而不是 any —— 列名写错要能被 ts-check 拦下。
  const patch: Partial<typeof pmsBuiWenlvVenueResearch.$inferInsert> = { updatedAt: new Date() };
  if (d.status !== undefined) patch.status = d.status;
  if (d.anchor !== undefined) patch.anchor = d.anchor;
  if (d.candidates !== undefined) patch.candidates = d.candidates;
  if (d.report !== undefined) patch.report = d.report;
  if (d.progress !== undefined) patch.progress = d.progress;
  if (d.search_log !== undefined) patch.searchLog = d.search_log;
  if (d.error !== undefined) patch.error = d.error;
  if (d.finished_at !== undefined) patch.finishedAt = d.finished_at;

  const [row] = await db.update(pmsBuiWenlvVenueResearch).set(patch)
    .where(eq(pmsBuiWenlvVenueResearch.id, researchId)).returning();
  if (!row) return c.json({ success: false, error: '调研记录不存在' }, 404);
  return c.json({ success: true, data: row });
});

export default route;
