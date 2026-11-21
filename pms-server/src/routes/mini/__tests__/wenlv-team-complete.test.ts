// POST /teams/:id/complete — 队长结算队伍（status: playing → completed）。
// 范式照 wenlv-team-join-by-id.test.ts：jwt 签的真 token + 真 DB 查询；
// fixture 全在 beforeAll 一次性种齐，afterAll 清掉。
// 本地无 PG 时整块被 `describe.skipIf(!process.env.RUN_DB)` 跳过 —— 至少 import 必须能过。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvTeams, pmsBuiWenlvProducts } from '../../../db/schema/index.js';

const TS = Date.now();
const T = `tc-team-${TS}`;
const UID_LEADER = `mini-tc-leader-${TS}`;
const UID_OTHER = `mini-tc-other-${TS}`;
// 整组夹具共用同一个 productId（原稿多次 Date.now() 会让 product/team 的 productId 漂移）
const P = `tc-prod-${TS}`;

const signMini = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

describe.skipIf(!process.env.RUN_DB)('POST /api/mini/wenlv/teams/:id/complete', () => {
  beforeAll(async () => {
    // 防御：本 id 此前若有残留先清掉
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    // venueId 在 pmsBuiWenlvProducts 可空（schema 行 170 无 .notNull()）—— 直接省去 venue 插入
    await db.insert(pmsBuiWenlvProducts).values({
      id: P, name: 'TC 测试剧本', status: 'published', playMode: 'group', isFree: true,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvTeams).values({
      id: T, productId: P, leaderId: UID_LEADER, inviteCode: `TC${String(TS).slice(-6)}`,
      members: [
        { userId: UID_LEADER, joinedAt: new Date().toISOString(), characterId: 'c1' },
        { userId: UID_OTHER, joinedAt: new Date().toISOString(), characterId: 'c2' },
      ],
      status: 'playing',
      progress: { visited: {}, collected: {}, completed: {} },
    }).onConflictDoNothing();
  });

  it('非队长调用 ⇒ 403', async () => {
    const res = await wenlvRoute.request(`/teams/${T}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_OTHER)}` },
    });
    expect(res.status).toBe(403);
  });

  it('队长调用 ⇒ 200 且 status 变 completed', async () => {
    const res = await wenlvRoute.request(`/teams/${T}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_LEADER)}` },
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.status).toBe('completed');
    expect(d.completedAt).toBeTruthy();
  });

  it('重复调用幂等返回 completed', async () => {
    const res = await wenlvRoute.request(`/teams/${T}/complete`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_LEADER)}` },
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.status).toBe('completed');
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });
});
