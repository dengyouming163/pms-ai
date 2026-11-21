import { Hono } from 'hono';
import { eq, desc } from 'drizzle-orm';
import { db } from '../db/index';
import { pmsBuiHotTopics } from '../db/schema/promotion';

const route = new Hono();

// GET /api/hot-topics/today — 今日最新热点（不分场景，由定时任务每天 00:05 采集）
route.get('/today', async (c) => {
  const today = new Date().toISOString().split('T')[0];

  const topics = await db
    .select()
    .from(pmsBuiHotTopics)
    .where(eq(pmsBuiHotTopics.date, today))
    .orderBy(pmsBuiHotTopics.sortOrder);

  if (topics.length > 0) {
    const data = topics.map(t => ({ label: t.label, icon: t.icon, prompt: t.prompt }));
    return c.json({ success: true, data, date: today });
  }

  // 无今日数据回退到最新一天
  const latest = await db
    .select()
    .from(pmsBuiHotTopics)
    .orderBy(desc(pmsBuiHotTopics.date))
    .limit(36);

  const data = latest.map(t => ({ label: t.label, icon: t.icon, prompt: t.prompt }));
  return c.json({ success: true, data, date: latest[0]?.date || today, fallback: true });
});

// GET /api/hot-topics?date=2026-07-12 — 按日期查询
route.get('/', async (c) => {
  const date = c.req.query('date') || new Date().toISOString().split('T')[0];

  const topics = await db
    .select()
    .from(pmsBuiHotTopics)
    .where(eq(pmsBuiHotTopics.date, date))
    .orderBy(pmsBuiHotTopics.sortOrder);

  if (topics.length === 0) {
    const latest = await db
      .select()
      .from(pmsBuiHotTopics)
      .orderBy(desc(pmsBuiHotTopics.date))
      .limit(36);
    return c.json({ success: true, data: latest, date: latest[0]?.date || date });
  }

  return c.json({ success: true, data: topics, date });
});

export default route;
