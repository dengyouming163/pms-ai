import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiAiActions } from '../../db/schema/ai.js';
import { getTenantScope } from '../../utils/tenant.js';
import { checkExecutionLevel } from '../../middleware/execution-control.js';

const actions = new Hono();

actions.get('/pending', async (c) => {
  const scope = getTenantScope(c);
  const list = await db.select().from(pmsBuiAiActions as any)
    .where(and(eq((pmsBuiAiActions as any).merchantId, scope.merchantId), eq((pmsBuiAiActions as any).status, 'pending')))
    .orderBy(desc((pmsBuiAiActions as any).createdAt)).limit(30);
  return c.json({ actions: list });
});

actions.post('/:id/confirm', async (c) => {
  const id = c.req.param('id');
  const scope = getTenantScope(c);
  const authUser = (c as any).get('authUser');
  const [action] = await db.select().from(pmsBuiAiActions as any)
    .where(and(eq((pmsBuiAiActions as any).id, id), eq((pmsBuiAiActions as any).merchantId, scope.merchantId))).limit(1);
  if (!action) return c.json({ success: false, error: '操作不存在' }, 404);
  const check = checkExecutionLevel(action.actionLevel || 'L2', authUser?.scope || 'staff');
  if (!check.allowed) return c.json({ success: false, error: check.reason }, 403);
  const now = new Date();
  const chain = [...((action.decisionChain as any[]) || []), { step: 'confirmed', actor: authUser?.userId || 'unknown', decision: 'confirm', timestamp: now.toISOString() }];
  await db.update(pmsBuiAiActions).set({ status: 'confirmed', confirmedBy: authUser?.userId || '', confirmedAt: now, decisionChain: chain }).where(eq((pmsBuiAiActions as any).id, id));
  return c.json({ success: true, message: '操作已确认' });
});

actions.post('/:id/reject', async (c) => {
  const id = c.req.param('id');
  const scope = getTenantScope(c);
  const authUser = (c as any).get('authUser');
  const [action] = await db.select().from(pmsBuiAiActions as any)
    .where(and(eq((pmsBuiAiActions as any).id, id), eq((pmsBuiAiActions as any).merchantId, scope.merchantId))).limit(1);
  if (!action) return c.json({ success: false, error: '操作不存在' }, 404);
  const chain = [...((action.decisionChain as any[]) || []), { step: 'rejected', actor: authUser?.userId || 'unknown', decision: 'reject', timestamp: new Date().toISOString() }];
  await db.update(pmsBuiAiActions).set({ status: 'rejected', decisionChain: chain }).where(eq((pmsBuiAiActions as any).id, id));
  return c.json({ success: true, message: '操作已拒绝' });
});

export default actions;
