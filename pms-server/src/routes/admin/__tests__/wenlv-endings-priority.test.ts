/**
 * 块 E Task 5：结局 `priority` 写路径落库闸（DB）。
 *
 * ## 为什么必须有这条测试
 * `priority` 是后加列（迁移 0031）。加列的经典陷阱是「三处要同步」：schema 声明、
 * 写端点 `.values({...})`、更新端点白名单。第三处**没有编译器提醒** —— 漏了它
 * 端点照常 200、返回体里 priority 照常是旧值，只是静默不变（本仓前科：`applyLevel`
 * 的 `mapNode`、`qrcodes` 投影恒显未印）。
 *
 * 光 grep 只能证明「字符串出现过」，证明不了 PATCH 真能改它、也证明不了
 * 「只改别的字段不会被清零」。故本文件直打真实路由 + 直读 DB 断言：
 *   1. POST 传 `priority: 7` ⇒ 落库 7（不是默认 0）；
 *   2. PATCH 传 `priority: 3` ⇒ 落库 3（白名单真的放行了它）；
 *   3. PATCH 只传 `title` ⇒ `priority` 保持 3（白名单循环按 `k in body` 收集，
 *      未传的键不该进 patch ⇒ 不该被 reset 成默认值）。
 *
 * ## 为什么走真实 HTTP 路由而不是直插 DB
 * 直插 DB 证明的是 schema，不是端点。缺陷恰恰在端点白名单里。
 *
 * ## 红线
 * - 只用 `vitest.local.config.ts`（回环硬闸）；夹具 `seedNarrativeFixture` 自身
 *   也会 `assertLoopbackPgHost()`。**绝不**用 `vitest.db.config.ts`（指向生产）。
 * - 本地库是共享的 ⇒ `afterAll` 必须把夹具连同行一起清干净。
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { eq } from 'drizzle-orm';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvScenes } from '../../../db/schema/index.js';
import {
  fixtureLinear, seedNarrativeFixture, deleteNarrativeFixture,
} from '../../../test-utils/wenlv-narrative-fixture.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

/** 直读落库行（不经任何投影）—— 断言优先级最终值。结局 = scenes type='ending'。 */
async function landedPriority(endingId: string): Promise<number | null | undefined> {
  const [row] = await db.select().from(pmsBuiWenlvScenes)
    .where(eq(pmsBuiWenlvScenes.id, endingId)).limit(1);
  return row?.priority;
}

describe.skipIf(!process.env.RUN_DB)('结局 priority 写路径落库（POST values + PATCH 白名单）', () => {
  const TS = Date.now();
  const P = `endprio-${TS}`;
  const ROOM_ID = `room-${P}`;
  const CH_ID = `ch-${P}`;
  // POST 端点会生成 id（无 body.id 时 randomUUID）⇒ 用例从响应体取回再断言。
  let createdId = '';

  beforeAll(async () => {
    await seedNarrativeFixture(db, fixtureLinear(P), P);
  });

  afterAll(async () => {
    await deleteNarrativeFixture(db, P);
  });

  it('POST /script-rooms/:id/endings 传 priority=7 ⇒ 落库 7', async () => {
    const res = await adminWenlvRoute.request(`/script-rooms/${ROOM_ID}/endings`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ chapterId: CH_ID, title: '高优先结局', priority: 7 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    createdId = body.data.ending.id;
    expect(body.data.ending.priority).toBe(7);
    // 直读证明落库（响应体可能来自 returning()，仍是同一行；这里独立复核）
    expect(await landedPriority(createdId)).toBe(7);
  });

  it('PATCH /scenes/:id 传 priority=3 ⇒ 落库 3', async () => {
    const res = await adminWenlvRoute.request(`/scenes/${createdId}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ priority: 3 }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.scene.priority).toBe(3);
    expect(await landedPriority(createdId)).toBe(3);
  });

  it('PATCH 只改 title ⇒ priority 保持 3（不因未传被清零）', async () => {
    const res = await adminWenlvRoute.request(`/scenes/${createdId}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ title: '改了标题' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.scene.title).toBe('改了标题');
    // 这条才是白名单缺陷的探针：漏了 'priority' 时第三次 PATCH 不会清它（因为没传），
    // 但**第二条**用例会红；此处额外证明「未传字段不进 patch」这一语义不被破坏。
    expect(await landedPriority(createdId)).toBe(3);
  });

  it('POST 不传 priority ⇒ 落库默认 0（显式判型而非 Number(\'\') 混同）', async () => {
    const res = await adminWenlvRoute.request(`/script-rooms/${ROOM_ID}/endings`, {
      method: 'POST', headers: H,
      body: JSON.stringify({ chapterId: CH_ID, title: '无优先级结局' }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.ending.priority).toBe(0);
    expect(await landedPriority(body.data.ending.id)).toBe(0);
  });
});
