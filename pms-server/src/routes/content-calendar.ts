import { Hono } from 'hono';
import { eq, and, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiContentCalendar } from '../db/schema/promotion.js';
import { serverError } from '../lib/http-error.js';

const route = new Hono();

// GET /api/content/calendar?week=2026-07-13 — 获取指定周的内容日历
route.get('/calendar', async (c) => {
  const weekStart = c.req.query('week') || new Date().toISOString().split('T')[0];
  const start = new Date(weekStart);
  // 回退到周一
  const dayOfWeek = start.getDay();
  const mondayOffset = dayOfWeek === 0 ? -6 : 1 - dayOfWeek;
  start.setDate(start.getDate() + mondayOffset);

  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(start);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  const list = await db
    .select()
    .from(pmsBuiContentCalendar)
    .where(
      and(
        eq(pmsBuiContentCalendar.merchantId, 'default'),
        inArray(pmsBuiContentCalendar.date, dates as any),
      ),
    )
    .orderBy(pmsBuiContentCalendar.date);

  // 如果某天没有数据，返回空占位
  const calendarByDate: Record<string, any> = {};
  list.forEach(item => {
    calendarByDate[item.date] = item;
  });

  const fullWeek = dates.map(date => ({
    date,
    dayOfWeek: new Date(date).getDay(),
    ...(calendarByDate[date] || {
      id: null,
      topic: null,
      titleSuggestion: null,
      weather: null,
      events: null,
      occupancyHint: null,
      status: 'empty',
      noteId: null,
    }),
  }));

  return c.json({ success: true, data: fullWeek, weekStart: dates[0], weekEnd: dates[6] });
});

// POST /api/content/calendar/generate — AI 生成一周内容日历
route.post('/calendar/generate', async (c) => {
  const body = await c.req.json();
  const { weekStart } = body as { weekStart?: string };

  const startDate = weekStart || new Date().toISOString().split('T')[0];
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    dates.push(d.toISOString().split('T')[0]);
  }

  // 通过 pms-agent 的内容规划能力生成
  const aiHost = process.env.PMS_AI_HOST || 'localhost';
  const aiPort = process.env.PMS_AI_PORT || '8000';

  try {
    const res = await fetch(`http://${aiHost}:${aiPort}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: `请为从 ${dates[0]} 开始的这一周（共7天）策划小红书内容日历。`,
        history: [],
      }),
    });

    if (res.ok) {
      // SSE 流式响应 — 收集完整文本后解析
      const text = await res.text();
      const events = text
        .split('\n')
        .filter(line => line.startsWith('data: '))
        .map(line => {
          try { return JSON.parse(line.slice(6)); } catch { return null; }
        })
        .filter(Boolean);

      const doneEvent = events.find((e: any) => e.summary);
      const summary = doneEvent?.summary || '';

      // 解析 AI 输出并保存到数据库
      const lines = summary.split('\n').filter((l: string) => l.includes('|'));
      for (let i = 0; i < Math.min(lines.length, 7); i++) {
        const parts = lines[i].split('|').map((s: string) => s.trim());
        if (parts.length >= 4 && dates[i]) {
          const id = `cal_${Date.now()}_${i}`;
          await db
            .insert(pmsBuiContentCalendar)
            .values({
              id,
              merchantId: 'default',
              date: dates[i],
              topic: parts[1] || '',
              titleSuggestion: parts[2] || '',
              status: 'suggested',
              occupancyHint: parts[3] || '',
            } as any)
            .catch(() => {}); // 忽略重复插入
        }
      }
      return c.json({ success: true, data: { weekStart: dates[0], generated: true } });
    }
    throw new Error(`AI服务返回 ${res.status}`);
  } catch (err: any) {
    return serverError(c, err, 'AI生成失败');
  }
});

// PATCH /api/content/calendar/:id — 更新日历条目
route.patch('/calendar/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  await db
    .update(pmsBuiContentCalendar)
    .set({
      topic: body.topic,
      titleSuggestion: body.titleSuggestion,
      status: body.status,
      noteId: body.noteId,
      updatedAt: new Date(),
    } as any)
    .where(eq(pmsBuiContentCalendar.id, id));
  return c.json({ success: true, message: '已更新' });
});

export default route;
