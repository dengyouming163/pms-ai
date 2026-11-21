// GET /teams/:id 的 memberStates 字段测试。
// 范式照 wenlv-team.db.test.ts：jwt 签的真 token + 真 DB 查询；
// fixture 全在 beforeAll 一次性种齐，afterAll 清掉。
// 本地无 PG 时整块被 `describe.skipIf(!process.env.RUN_DB)` 跳过 —— 至少 import 必须能过。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvTeams,
  pmsBuiWenlvProgress,
  pmsBuiWenlvProducts,
  pmsBuiWenlvCharacters,
} from '../../../db/schema/index.js';

const TS = Date.now();
const T = `ms-team-${TS}`;
const UID = `mini-ms-1-${TS}`;
const UID_OTHER = `mini-ms-2-${TS}`;
// 整组夹具共用同一个 productId（task 描述原稿用了多次 Date.now() 会让 product/team/character 的 id 漂移）
const P = `ms-prod-${TS}`;
const CHAR = `ms-char-${TS}`;

const signMini = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

describe.skipIf(!process.env.RUN_DB)('GET /api/mini/wenlv/teams/:id memberStates', () => {
  beforeAll(async () => {
    // 防御：本 id 此前若有残留先清掉，让「未清场」噪声不污染本测
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    await db.insert(pmsBuiWenlvProducts).values({
      id: P, name: 'MS 测试剧本', status: 'published', playMode: 'group', isFree: true,
    });
    // pmsBuiWenlvCharacters 的 faction/identity/vitality/wisdom/insight 都 NOT NULL 且无默认值 —— 必须显式给
    await db.insert(pmsBuiWenlvCharacters).values({
      id: CHAR, productId: P, name: '阿探', order: 0,
      faction: '探', identity: '捕快', vitality: 50, wisdom: 50, insight: 50,
    });
    await db.insert(pmsBuiWenlvTeams).values({
      id: T, productId: P, leaderId: UID, inviteCode: `MS${String(TS).slice(-6)}`,
      members: [
        { userId: UID, joinedAt: new Date().toISOString(), characterId: CHAR },
        { userId: UID_OTHER, joinedAt: new Date().toISOString() },
      ],
      status: 'playing',
      progress: { visited: {}, collected: {}, completed: {} },
    });
    // 给 UID 建一个 progress 行：1 个 visited + 1 个 collected
    await db.insert(pmsBuiWenlvProgress).values({
      id: `ms-prog-${TS}`, productId: P, miniUserId: UID, sessionId: T,
      state: { visited: { 'node-A': true }, collected: { 'clue-X': true }, completed: {} },
      status: 'active', characterId: CHAR,
    });
  });

  it('memberStates 数组长度等于队伍人数', async () => {
    const res = await wenlvRoute.request(`/teams/${T}`, {
      headers: { Authorization: `Bearer ${signMini(UID)}` },
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(Array.isArray(d.memberStates)).toBe(true);
    expect(d.memberStates.length).toBe(2);
  });

  it('memberStates 包含 characterId/characterName/online/collectedCount/visitedCount', async () => {
    const res = await wenlvRoute.request(`/teams/${T}`, {
      headers: { Authorization: `Bearer ${signMini(UID)}` },
    });
    const d = (await res.json()).data;
    const me = d.memberStates.find((m: any) => m.userId === UID);
    expect(me).toBeTruthy();
    expect(me.characterId).toBe(CHAR);
    expect(me.characterName).toBe('阿探');
    expect(typeof me.online).toBe('boolean');
    expect(me.collectedCount).toBe(1);
    expect(me.visitedCount).toBe(1);
  });

  it('未选角的队员 characterId 为 null', async () => {
    const res = await wenlvRoute.request(`/teams/${T}`, {
      headers: { Authorization: `Bearer ${signMini(UID)}` },
    });
    const d = (await res.json()).data;
    const other = d.memberStates.find((m: any) => m.userId === UID_OTHER);
    expect(other.characterId).toBeNull();
    expect(other.characterName).toBeNull();
    expect(other.collectedCount).toBe(0);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.sessionId, T));
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    await db.delete(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });
});
