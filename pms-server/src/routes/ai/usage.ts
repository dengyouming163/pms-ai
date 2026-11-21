import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiAiUsage, pmsBuiAiMetrics, pmsBuiAiInsights } from '../../db/schema/ai.js';
import { getTenantScope } from '../../utils/tenant.js';

const usage = new Hono();

usage.get('/', async (c) => {
  const scope = getTenantScope(c);
  const now = new Date();
  const period = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;

  const [record] = await db.select().from(pmsBuiAiUsage)
    .where(and(eq(pmsBuiAiUsage.merchantId, scope.merchantId), eq(pmsBuiAiUsage.period, period)))
    .limit(1);

  // 实时聚合（fallback）
  const insights = await db.select().from(pmsBuiAiInsights)
    .where(and(eq(pmsBuiAiInsights.merchantId, scope.merchantId)))
    .orderBy(desc(pmsBuiAiInsights.createdAt)).limit(100);

  return c.json({
    chatCount: record?.chatCount || 0,
    insightCount: insights.length,
    insightAdoptedCount: record?.insightAdoptedCount || insights.filter(i => i.status === 'applied').length,
    actionCount: record?.actionCount || 0,
    tokensUsed: record?.tokensUsed || 0,
    estimatedCost: Number(record?.estimatedCost || 0),
    suggestionsSavings: Number(record?.suggestionsSavings || 0),
  });
});

export default usage;
