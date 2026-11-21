import { Hono } from 'hono';
import { db } from '../../db/index.js';
import { pmsBuiWenlvTriggers, pmsBuiWenlvCollectibles, pmsBuiWenlvPlayerProgress, pmsBuiWenlvProgress } from '../../db/schema/index.js';
import { eq, and } from 'drizzle-orm';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { applySanDelta } from '../../services/wenlv/san-service.js';
import { randomUUID } from 'node:crypto';
import type { WenlvState } from '../../db/schema/wenlv.js';

const route = new Hono();

route.post('/report', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const { code, type, beaconUuid, beaconMajor, beaconMinor, nodeId, triggerId } = await c.req.json();

  let trigger;
  if (type === 'qr' && code) {
    [trigger] = await db.select().from(pmsBuiWenlvTriggers)
      .where(and(eq(pmsBuiWenlvTriggers.type, 'qr'), eq(pmsBuiWenlvTriggers.collectibleId, code)))
      .limit(1);
  } else if (type === 'beacon' && beaconUuid) {
    [trigger] = await db.select().from(pmsBuiWenlvTriggers)
      .where(and(eq(pmsBuiWenlvTriggers.type, 'beacon'), eq(pmsBuiWenlvTriggers.beaconUuid, beaconUuid)))
      .limit(1);
  } else if (type === 'ar' && (nodeId || triggerId)) {
    // AR 显影触发器：按 nodeId 或 triggerId 查找
    const where = nodeId
      ? and(eq(pmsBuiWenlvTriggers.type, 'ar'), eq(pmsBuiWenlvTriggers.nodeId, nodeId))
      : eq(pmsBuiWenlvTriggers.id, triggerId);
    [trigger] = await db.select().from(pmsBuiWenlvTriggers).where(where).limit(1);
  }
  if (!trigger) return c.json({ success: false, error: '触发器不存在' }, 404);

  let [progress] = await db.select().from(pmsBuiWenlvPlayerProgress)
    .where(and(eq(pmsBuiWenlvPlayerProgress.miniUserId, auth.miniUserId), eq(pmsBuiWenlvPlayerProgress.productId, trigger.productId)))
    .limit(1);
  if (!progress) {
    const id = randomUUID();
    await db.insert(pmsBuiWenlvPlayerProgress).values({
      id, productId: trigger.productId, miniUserId: auth.miniUserId, san: 100,
    });
    [progress] = await db.select().from(pmsBuiWenlvPlayerProgress).where(eq(pmsBuiWenlvPlayerProgress.id, id)).limit(1);
  }

  const unlocked = progress.unlockedTriggers || [];
  if (unlocked.includes(trigger.id)) {
    return c.json({ success: true, data: { alreadyUnlocked: true, trigger } });
  }

  const unlockContent = (trigger.unlockContent || {}) as { clueText?: string; sanDelta?: number };
  const newSan = applySanDelta(progress.san, unlockContent.sanDelta || 0);
  const newUnlocked = [...unlocked, trigger.id];
  const newCollected = trigger.collectibleId
    ? [...(progress.collectedCollectibles || []), trigger.collectibleId]
    : progress.collectedCollectibles;

  await db.update(pmsBuiWenlvPlayerProgress)
    .set({ san: newSan, unlockedTriggers: newUnlocked, collectedCollectibles: newCollected, updatedAt: new Date() })
    .where(eq(pmsBuiWenlvPlayerProgress.id, progress.id));

  // 同步扫码收集的证物到主进度表 state.collected（供前端 UI 与节点引擎使用）
  // 前端 getWenlvProgress 读取 pmsBuiWenlvProgress.state，故需在此写入
  if (trigger.collectibleId) {
    const mainRows = await db.select({ id: pmsBuiWenlvProgress.id, state: pmsBuiWenlvProgress.state })
      .from(pmsBuiWenlvProgress)
      .where(and(
        eq(pmsBuiWenlvProgress.productId, trigger.productId),
        eq(pmsBuiWenlvProgress.miniUserId, auth.miniUserId),
      ));
    for (const r of mainRows) {
      const state = (r.state || { visited: {}, collected: {}, completed: {} }) as WenlvState;
      const nextCollected = { ...(state.collected || {}), [trigger.collectibleId]: true };
      await db.update(pmsBuiWenlvProgress)
        .set({ state: { ...state, collected: nextCollected }, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvProgress.id, r.id));
    }
  }

  // 查询收集到的证物信息返回前端
  let collectible: { id: string; name: string; type: string } | undefined;
  if (trigger.collectibleId) {
    const [col] = await db.select({ id: pmsBuiWenlvCollectibles.id, name: pmsBuiWenlvCollectibles.name, type: pmsBuiWenlvCollectibles.type })
      .from(pmsBuiWenlvCollectibles)
      .where(eq(pmsBuiWenlvCollectibles.id, trigger.collectibleId))
      .limit(1);
    if (col) collectible = { id: col.id, name: col.name, type: col.type };
  }

  return c.json({
    success: true,
    data: {
      trigger,
      clueText: unlockContent.clueText || '',
      sanDelta: unlockContent.sanDelta || 0,
      san: newSan,
      collectible,
    },
  });
});

// GET /api/mini/wenlv/trigger/beacon-heartbeat?beaconUuid=xxx
// 信标靠近时的氛围事件：不修改节点状态，仅返回提示文案 + 可选 SAN 微变（"心悸"反馈）
route.get('/beacon-heartbeat', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const beaconUuid = c.req.query('beaconUuid');
  if (!beaconUuid) return c.json({ success: false, error: '缺少 beaconUuid' }, 400);

  const [trigger] = await db.select().from(pmsBuiWenlvTriggers)
    .where(and(eq(pmsBuiWenlvTriggers.type, 'beacon'), eq(pmsBuiWenlvTriggers.beaconUuid, beaconUuid)))
    .limit(1);
  if (!trigger) return c.json({ success: true, data: null });

  const [progress] = await db.select().from(pmsBuiWenlvPlayerProgress)
    .where(and(
      eq(pmsBuiWenlvPlayerProgress.miniUserId, auth.miniUserId),
      eq(pmsBuiWenlvPlayerProgress.productId, trigger.productId),
    )).limit(1);

  const unlockContent = (trigger.unlockContent || {}) as { heartbeatText?: string; sanDelta?: number };
  const heartbeatText = unlockContent.heartbeatText || '你感到一阵心悸，似乎有什么东西在附近…';

  // 心跳只触发一次：未解锁时应用 SAN 微变并记录到 unlockedTriggers
  const unlocked = progress?.unlockedTriggers || [];
  if (progress && !unlocked.includes(trigger.id) && unlockContent.sanDelta) {
    const newSan = applySanDelta(progress.san, unlockContent.sanDelta);
    await db.update(pmsBuiWenlvPlayerProgress)
      .set({ san: newSan, unlockedTriggers: [...unlocked, trigger.id], updatedAt: new Date() })
      .where(eq(pmsBuiWenlvPlayerProgress.id, progress.id));
    return c.json({ success: true, data: { heartbeatText, sanDelta: unlockContent.sanDelta, san: newSan } });
  }

  return c.json({ success: true, data: { heartbeatText, sanDelta: 0, san: progress?.san ?? 100 } });
});

export default route;
