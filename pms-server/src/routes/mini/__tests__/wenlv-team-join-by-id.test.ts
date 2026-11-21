// POST /teams/join 支持 teamId（直接按主键查队）或 inviteCode（6 位邀请码查队），二选一。
// 范式照 wenlv-team-member-states.test.ts：jwt 签的真 token + 真 DB 查询；
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
const T = `jb-team-${TS}`;
const UID_NEW = `mini-jb-new-${TS}`;
const UID_LEADER = `mini-jb-leader-${TS}`;
// 整组夹具共用同一个 productId（原稿多次 Date.now() 会让 product/team 的 productId 漂移）
const P = `jb-prod-${TS}`;

const signMini = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

describe.skipIf(!process.env.RUN_DB)('POST /api/mini/wenlv/teams/join by teamId', () => {
  beforeAll(async () => {
    // 防御：本 id 此前若有残留先清掉
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    // venueId 在 pmsBuiWenlvProducts 可空（schema 行 170 无 .notNull()）—— 直接省去 venue 插入
    await db.insert(pmsBuiWenlvProducts).values({
      id: P, name: 'JB 测试剧本', status: 'published', playMode: 'group', isFree: true,
    }).onConflictDoNothing();
    await db.insert(pmsBuiWenlvTeams).values({
      id: T, productId: P, leaderId: UID_LEADER, inviteCode: `JB${String(TS).slice(-6)}`,
      members: [{ userId: UID_LEADER, joinedAt: new Date().toISOString() }],
      status: 'forming',
      progress: { visited: {}, collected: {}, completed: {} },
    }).onConflictDoNothing();
  });

  it('用 teamId 加入队伍', async () => {
    const res = await wenlvRoute.request('/teams/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_NEW)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: T }),
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.id).toBe(T);
    expect(d.members.some((m: any) => m.userId === UID_NEW)).toBe(true);
  });

  it('重复加入幂等返回', async () => {
    const res = await wenlvRoute.request('/teams/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_NEW)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ teamId: T }),
    });
    expect(res.status).toBe(200);
  });

  it('缺 teamId 又缺 inviteCode ⇒ 400', async () => {
    const res = await wenlvRoute.request('/teams/join', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_NEW)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    expect(res.status).toBe(400);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });
});
