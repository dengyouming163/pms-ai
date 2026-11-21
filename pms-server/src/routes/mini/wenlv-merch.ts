import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/index.js';
import { pmsBuiWenlvMerchRedeems, pmsBuiWenlvRewards, pmsBuiWenlvClaims } from '../../db/schema/index.js';
import { eq, and, sql } from 'drizzle-orm';
import { parseMiniToken } from '../../middleware/mini-auth.js';

const route = new Hono();

/** C 端 - 兑换文创商品（领取奖励 claim 后，选择自提/快递并填收件信息） */
route.post('/redeems', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  const userId = miniUser.miniUserId;
  const body = await c.req.json().catch(() => ({}));
  const { claimId, receiverName, receiverPhone, receiverAddress, pickupStoreId } = body;

  // 1. 校验 claim 存在且属于该用户
  const [claim] = await db.select().from(pmsBuiWenlvClaims)
    .where(and(eq(pmsBuiWenlvClaims.id, claimId), eq(pmsBuiWenlvClaims.miniUserId, userId))).limit(1);
  if (!claim) return c.json({ success: false, error: '领奖记录不存在' }, 404);
  if (claim.status !== 'claimed') return c.json({ success: false, error: '该奖励已核销或已取消' }, 400);
  if (!claim.rewardId) return c.json({ success: false, error: '该档位无关联奖励' }, 400);

  // 2. 校验 reward 是 merchandise 类型
  const [reward] = await db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.id, claim.rewardId)).limit(1);
  if (!reward || reward.type !== 'merchandise') return c.json({ success: false, error: '非文创商品类型奖励' }, 400);

  // 3. 校验库存
  if (reward.stockLimit !== null && reward.stockLimit !== undefined && (reward.stockUsed ?? 0) >= reward.stockLimit) {
    return c.json({ success: false, error: '库存不足' }, 400);
  }

  // 4. 创建兑换记录（claimCode 用 M 前缀区分 LY 领奖码）
  const id = randomUUID();
  const claimCode = `M${Date.now().toString(36).toUpperCase()}${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
  await db.insert(pmsBuiWenlvMerchRedeems).values({
    id, productId: claim.productId, miniUserId: userId, progressId: claim.progressId,
    rewardId: claim.rewardId, tierId: claim.tierId, claimCode, status: 'pending',
    receiverName: receiverName ?? null, receiverPhone: receiverPhone ?? null,
    receiverAddress: receiverAddress ?? null, redeemedStoreId: pickupStoreId ?? null,
  });

  // 5. 更新库存（原子 +1）
  await db.update(pmsBuiWenlvRewards)
    .set({ stockUsed: sql`${pmsBuiWenlvRewards.stockUsed} + 1` })
    .where(eq(pmsBuiWenlvRewards.id, claim.rewardId));

  return c.json({ success: true, data: { id, claimCode } });
});

/** C 端 - 查询我的兑换记录 */
route.get('/redeems/mine', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  const list = await db.select().from(pmsBuiWenlvMerchRedeems)
    .where(eq(pmsBuiWenlvMerchRedeems.miniUserId, miniUser.miniUserId));
  return c.json({ success: true, data: { list } });
});

export default route;
