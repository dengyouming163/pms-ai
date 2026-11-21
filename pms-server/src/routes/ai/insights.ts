import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiAiInsights, pmsBuiAiActions, pmsBuiAiMetrics } from '../../db/schema/ai.js';
import { getTenantScope } from '../../utils/tenant.js';

// auth 中间件注入 authUser（payload: { userId, ... }），Hono 需显式泛型才能 c.get 类型安全
const insights = new Hono<{ Variables: { authUser: { userId?: string } } }>();

insights.get('/', async (c) => {
  const scope = getTenantScope(c);
  const list = await db.select().from(pmsBuiAiInsights)
    .where(and(
      eq(pmsBuiAiInsights.merchantId, scope.merchantId),
      eq(pmsBuiAiInsights.status, 'active'),
    ))
    .orderBy(desc(pmsBuiAiInsights.priority))
    .limit(20);
  return c.json({ insights: list });
});

insights.post('/:id/apply', async (c) => {
  const id = c.req.param('id');
  const scope = getTenantScope(c);
  const [insight] = await db.select().from(pmsBuiAiInsights)
    .where(and(
      eq(pmsBuiAiInsights.id, id),
      eq(pmsBuiAiInsights.merchantId, scope.merchantId),
    ))
    .limit(1);
  if (!insight) return c.json({ success: false, error: '洞察不存在' }, 404);

  if (insight.actionLevel === 'L1') {
    await db.update(pmsBuiAiInsights)
      .set({ status: 'applied', appliedAt: new Date() })
      .where(eq(pmsBuiAiInsights.id, id));

    // 写入 AI 指标
    await db.insert(pmsBuiAiMetrics).values({
      id: `metric_${Date.now()}_${id.slice(-6)}`,
      merchantId: scope.merchantId,
      agent: insight.agent || 'unknown',
      operation: 'action',
      insightGenerated: true,
      insightAdopted: true,
      createdAt: new Date(),
    });
    return c.json({ success: true, message: '已自动执行', autoApplied: true });
  }

  // L2/L3: 生成待确认操作 + 决策链
  const actionId = `act_${Date.now()}_${id.slice(-6)}`;
  const authUser = c.get('authUser') as { userId?: string } | undefined;
  await db.insert(pmsBuiAiActions).values({
    id: actionId, insightId: id, merchantId: scope.merchantId,
    title: insight.title || '', description: insight.content || '',
    toolName: (insight.actionPayload as Record<string, unknown>)?.tool as string || 'unknown',
    toolParams: insight.actionPayload || {},
    actionLevel: insight.actionLevel || 'L2',
    status: 'pending',
    decisionChain: [{
      step: 'created',
      actor: authUser?.userId || 'system',
      decision: 'pending_confirmation',
      timestamp: new Date().toISOString(),
      evidence: insight.evidence || [],
      agent: insight.agent,
    }],
    createdAt: new Date(),
  });
  return c.json({ success: true, message: `已生成待确认操作（${insight.actionLevel}）`, autoApplied: false, actionId });
});

insights.post('/:id/dismiss', async (c) => {
  const id = c.req.param('id');
  const scope = getTenantScope(c);
  await db.update(pmsBuiAiInsights)
    .set({ status: 'dismissed' })
    .where(and(
      eq(pmsBuiAiInsights.id, id),
      eq(pmsBuiAiInsights.merchantId, scope.merchantId),
    ));
  return c.json({ success: true, message: '已忽略' });
});

insights.post('/:id/feedback', async (c) => {
  const id = c.req.param('id');
  const scope = getTenantScope(c);
  const { feedback } = await c.req.json();
  await db.update(pmsBuiAiInsights)
    .set({ feedback })
    .where(and(
      eq(pmsBuiAiInsights.id, id),
      eq(pmsBuiAiInsights.merchantId, scope.merchantId),
    ));
  return c.json({ success: true });
});

export default insights;
