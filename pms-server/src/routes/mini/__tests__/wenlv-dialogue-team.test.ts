// P3C-C2：/start 团队模式 get-or-create 共享对话 + /:id/message 多人合并 + GET /:id 放宽所有权。
// 范式照 wenlv-team-join-by-id.test.ts：jwt 签的真 token + 真 DB 查询；
// fixture 全在 beforeAll 一次性种齐，afterAll 清掉。
// SSE 流式响应：fetch 桩成 status 500 让 streamNpcReply 走 FALLBACK_TEXT 分支，不实际调 LLM。
// 本地无 PG 时整块被 `describe.skipIf(!process.env.RUN_DB)` 跳过 —— 至少 import 必须能过。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import dialogueRoute from '../wenlv-dialogue.js';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvDialogues,
  pmsBuiWenlvTeams,
  pmsBuiWenlvScenes,
  pmsBuiWenlvChapters,
  pmsBuiWenlvScriptRooms,
  pmsBuiWenlvNpcs,
  pmsBuiWenlvProducts,
} from '../../../db/schema/index.js';

const TS = Date.now();
const P = `c2-prod-${TS}`;
const R = `c2-room-${TS}`;
const C = `c2-chapter-${TS}`;
// 0079：NPC 节点 = type='npc' 的场景（nodeId=scene.id）。
const N = `c2-scene-${TS}`;
// 非 npc 型场景但留着 npcId/chapterGoal 列：投影 nodeType='scene'，新门控必须拒绝开对话。
const N_LEGACY = `c2-legacy-scene-${TS}`;
const NPC = `c2-npc-${TS}`;
const T = `c2-team-${TS}`;
const UID_LEADER = `mini-c2-leader-${TS}`;
const UID_MEMBER = `mini-c2-member-${TS}`;
const UID_OUTSIDER = `mini-c2-out-${TS}`;
const UID_SOLO = `mini-c2-solo-${TS}`;

const signMini = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

// fetch 桩：返回非 ok 响应，让 streamNpcReply 走 FALLBACK_TEXT 分支（不实际调 LLM）。
const stubFetchLlm = () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response('LLM stub', { status: 500 })));
};

describe.skipIf(!process.env.RUN_DB)('P3C-C2 /api/mini/wenlv/dialogue team mode', () => {
  let teamDialogueId = '';

  beforeAll(async () => {
    // 防御：清掉残留
    await db.delete(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.productId, P));
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, N_LEGACY));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.id, C));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));

    await db.insert(pmsBuiWenlvProducts).values({
      id: P, name: 'C2 测试剧本', status: 'published', playMode: 'group', isFree: true,
    });
    await db.insert(pmsBuiWenlvNpcs).values({
      id: NPC, productId: P, name: '掌柜', role: '店家',
    });
    // 0079 规范图：room(contentId=product) → chapter → npc 场景。
    await db.insert(pmsBuiWenlvScriptRooms).values({ id: R, name: 'C2 剧本房', contentId: P });
    await db.insert(pmsBuiWenlvChapters).values({ id: C, scriptRoomId: R, title: '第一章', order: 0 });
    // openingLine 预设 ⇒ /start 不会触发 LLM 调用
    await db.insert(pmsBuiWenlvScenes).values({
      id: N, chapterId: C, type: 'npc', title: 'NPC 章节', order: 0, npcId: NPC,
      openingLine: '欢迎来到客栈。',
      chapterGoal: { type: 'puzzle', description: '解谜', answerCriteria: ['暗道'], minTurns: 2 },
    });
    // 非 npc 型场景但留着 npcId/chapterGoal 列：投影 nodeType='scene'，/start 必须 400 拒绝。
    await db.insert(pmsBuiWenlvScenes).values({
      id: N_LEGACY, chapterId: C, type: 'narrative', title: '旧 NPC 章节（已降级）', order: 1, npcId: NPC,
      openingLine: '我本是 NPC。',
      chapterGoal: { type: 'puzzle', description: '旧目标', answerCriteria: ['旧暗号'], minTurns: 2 },
    });
    await db.insert(pmsBuiWenlvTeams).values({
      id: T, productId: P, leaderId: UID_LEADER, inviteCode: `C2${String(TS).slice(-6)}`,
      members: [
        { userId: UID_LEADER, joinedAt: new Date().toISOString() },
        { userId: UID_MEMBER, joinedAt: new Date().toISOString() },
      ],
      status: 'playing',
      progress: { visited: {}, collected: {}, completed: {} },
    });
  });

  it('/start 不传 teamId（单人模式）→ 200 创建新对话，teamMode=false', async () => {
    const res = await dialogueRoute.request('/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_SOLO)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: P, nodeId: N }),
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.dialogueId).toBeTruthy();
    expect(d.teamMode).toBe(false);
    expect(d.openingLine).toBe('欢迎来到客栈。');
    // teamId 应为 null（单人模式）
    const [row] = await db.select().from(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.id, d.dialogueId)).limit(1);
    expect(row.teamId).toBeNull();
  });

  it('/start 存量旧 npc 行（nodeType=scene 但留着 npcId/chapterGoal）→ 400，不再开对话', async () => {
    // 钉新门控 isNpcDrivenNode（nodeType==='npc' && npcId && chapterGoal）：
    // 若门控退回只判 npcId，本用例会得到 200 而变红。
    const res = await dialogueRoute.request('/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_SOLO)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: P, nodeId: N_LEGACY }),
    });
    expect(res.status).toBe(400);
    const b = await res.json();
    expect(b.success).toBe(false);
    expect(String(b.error)).toContain('该节点不是 NPC 驱动模式');
  });

  it('/start 传 teamId 非队员 → 403', async () => {
    const res = await dialogueRoute.request('/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_OUTSIDER)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: P, nodeId: N, teamId: T }),
    });
    expect(res.status).toBe(403);
  });

  it('/start 传 teamId 队员 → 200 创建共享对话 teamMode=true', async () => {
    const res = await dialogueRoute.request('/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_LEADER)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: P, nodeId: N, teamId: T }),
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.teamMode).toBe(true);
    expect(d.dialogueId).toBeTruthy();
    teamDialogueId = d.dialogueId;
    // 落库 teamId 应为 T
    const [row] = await db.select().from(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.id, teamDialogueId)).limit(1);
    expect(row.teamId).toBe(T);
  });

  it('/start 第二个队员再次进入 → 200 返回既有 team 对话（get-or-create）', async () => {
    const res = await dialogueRoute.request('/start', {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_MEMBER)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: P, nodeId: N, teamId: T }),
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.dialogueId).toBe(teamDialogueId);
    expect(d.teamMode).toBe(true);
    expect(Array.isArray(d.messages)).toBe(true);
    expect(d.messages.length).toBeGreaterThan(0);
  });

  it('/:id/message 队员（非创建者）发消息 → 200 放行（团队模式放宽所有权）', async () => {
    stubFetchLlm();
    const res = await dialogueRoute.request(`/${teamDialogueId}/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_MEMBER)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '我看到暗道入口' }),
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // 消费 SSE 流至关闭，确保 start 回调里的 DB 写入完成
    const reader = res.body!.getReader();
    for (;;) {
      const { done } = await reader.read();
      if (done) break;
    }
    // 消息应带 [队员xxx] 前缀落库
    const [row] = await db.select().from(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.id, teamDialogueId)).limit(1);
    const userMsg = row.messages.find((m) => m.role === 'user' && m.content.includes('暗道入口'));
    expect(userMsg).toBeTruthy();
    expect(userMsg!.content).toMatch(/^\[队员/);
    vi.unstubAllGlobals();
  });

  it('/:id/message 非队员发消息 → 403', async () => {
    const res = await dialogueRoute.request(`/${teamDialogueId}/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_OUTSIDER)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '我也要发' }),
    });
    expect(res.status).toBe(403);
  });

  it('/:id/message 单人模式对话非持有者发消息 → 403（向后兼容）', async () => {
    // 取上面单人模式创建的对话（持有者 UID_SOLO），用 UID_LEADER 发应被拒
    const [solo] = await db.select().from(pmsBuiWenlvDialogues)
      .where(eq(pmsBuiWenlvDialogues.miniUserId, UID_SOLO)).limit(1);
    expect(solo).toBeTruthy();
    const res = await dialogueRoute.request(`/${solo.id}/message`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${signMini(UID_LEADER)}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: '乱入' }),
    });
    expect(res.status).toBe(403);
  });

  it('GET /:id 队员可读共享对话（团队模式放宽所有权）', async () => {
    const res = await dialogueRoute.request(`/${teamDialogueId}`, {
      headers: { Authorization: `Bearer ${signMini(UID_MEMBER)}` },
    });
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.id).toBe(teamDialogueId);
    expect(Array.isArray(d.messages)).toBe(true);
  });

  it('GET /:id 非队员 → 403', async () => {
    const res = await dialogueRoute.request(`/${teamDialogueId}`, {
      headers: { Authorization: `Bearer ${signMini(UID_OUTSIDER)}` },
    });
    expect(res.status).toBe(403);
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.productId, P));
    await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, T));
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, C));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.id, C));
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, P));
    await db.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, P));
  });
});
