/**
 * `GET /products/:id/full` 必须下发 `requiresCredential`（派生自 nodeRequiresCredential）。
 *
 * 动机：创作台的实时预览要用它决定节点标签。该字段不是列、只在 mini DTO 里派生过，
 * admin 侧此前**完全没有**；让前端自己推断必然出错。
 *
 * 装置照抄 `src/routes/admin/__tests__/wenlv-simulate-route.test.ts`
 * （app 直调、内部 token、RUN_DB 门控、夹具用 test-utils/wenlv-narrative-fixture.ts）。
 * 本地真跑：
 *   pnpm exec vitest run --config vitest.local.config.ts <本文件>
 * ⚠️ 禁用 vitest.db.config.ts —— 它硬编码生产库凭据。
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { and, eq, inArray } from 'drizzle-orm';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvScenes, pmsBuiWenlvVenuePoints, pmsBuiWenlvVenues } from '../../../db/schema/index.js';
import { fixtureLinear, seedNarrativeFixture, deleteNarrativeFixture } from '../../../test-utils/wenlv-narrative-fixture.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN };

// 门禁用例不需要 DB，放在 skipIf 之外 —— 它证明的是「端点不是裸的」。
describe('GET /products/:id/full 门禁', () => {
  it('未带内部 token 返回 403', async () => {
    const res = await adminWenlvRoute.request('/products/whatever/full');
    expect(res.status).toBe(403);
  });
});

describe.skipIf(!process.env.RUN_DB)('GET /products/:id/full 的 requiresCredential（DB）', () => {
  const P = 'full-cred-' + Date.now();
  const NODES = [`${P}-n1`, `${P}-n2`, `${P}-n3`];

  beforeAll(async () => {
    await seedNarrativeFixture(db, fixtureLinear(P), P);
    // 夹具不带 venuePointId（见该文件说明），这里只给 n1 挂一个点位。
    await db.update(pmsBuiWenlvScenes)
      .set({ venuePointId: `${P}-vp` })
      .where(eq(pmsBuiWenlvScenes.id, NODES[0]));
  });

  afterAll(async () => { await deleteNarrativeFixture(db, P); });

  it('挂点位的节点 requiresCredential=true', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/full`, { headers: H });
    expect(res.status).toBe(200);
    const body = await res.json();
    const n1 = body.data.nodes.find((n: any) => n.id === NODES[0]);
    expect(n1.requiresCredential).toBe(true);       // ← 判据
  });

  it('未挂点位的节点 requiresCredential=false（证明不是恒真）', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/full`, { headers: H });
    const body = await res.json();
    for (const id of [NODES[1], NODES[2]]) {
      const n = body.data.nodes.find((x: any) => x.id === id);
      expect(n.requiresCredential).toBe(false);
    }
  });

  it('旧字段 venuePointId 仍在（本改动是**新增**派生字段，不是替换）', async () => {
    const res = await adminWenlvRoute.request(`/products/${P}/full`, { headers: H });
    const body = await res.json();
    const n1 = body.data.nodes.find((n: any) => n.id === NODES[0]);
    expect(n1.venuePointId).toBe(`${P}-vp`);
  });
});

/**
 * `/full` 的 `displayLocation` 派生自引擎 `nodeDisplayLocation()`：
 * 绑了点位 → 点位名；没绑 → null（location 文本列已移除，不再有回退）。
 */
describe.skipIf(!process.env.RUN_DB)('GET /products/:id/full 的 displayLocation（DB）', () => {
  const L = 'full-loc-' + Date.now();
  const VEN = `${L}-ven`;
  const PT = `${L}-pt`;
  const PT2 = `${L}-pt2`;
  const N1 = `${L}-n1`;
  const N2 = `${L}-n2`;
  const NAME_PT = '雨夜渡口';
  const NAME_PT2 = '第二幕·点位名';

  beforeAll(async () => {
    await seedNarrativeFixture(db, fixtureLinear(L), L);
    await db.insert(pmsBuiWenlvVenues).values({ id: VEN, name: 'location 投影测试场地' });
    await db.insert(pmsBuiWenlvVenuePoints).values([
      { id: PT, venueId: VEN, name: NAME_PT, sortOrder: 1 },
      { id: PT2, venueId: VEN, name: NAME_PT2, sortOrder: 2 },
    ]);
    await db.update(pmsBuiWenlvScenes)
      .set({ venuePointId: PT })
      .where(eq(pmsBuiWenlvScenes.id, N1));
    // N2 不挂点位
  });

  afterAll(async () => {
    await deleteNarrativeFixture(db, L);
    await db.delete(pmsBuiWenlvVenuePoints).where(inArray(pmsBuiWenlvVenuePoints.id, [PT, PT2]));
    await db.delete(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, VEN));
  });

  async function nodeOf(nodeId: string): Promise<any> {
    const res = await adminWenlvRoute.request(`/products/${L}/full`, { headers: H });
    expect(res.status).toBe(200);
    const body = await res.json();
    const n = body.data.nodes.find((x: any) => x.id === nodeId);
    expect(n, `节点 ${nodeId} 不在 /full 响应里`).toBeTruthy();
    return n;
  }

  it('① 挂点位 ⇒ displayLocation=点位名', async () => {
    const n = await nodeOf(N1);
    expect(n.displayLocation).toBe(NAME_PT);
  });

  it('② 不挂点位 ⇒ displayLocation=null（location 文本列已移除，无回退）', async () => {
    const n = await nodeOf(N2);
    expect(n.displayLocation).toBeNull();
  });
});
