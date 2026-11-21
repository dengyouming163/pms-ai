// POST /api/mini/wenlv/dialogue/start（0079 统一重建）：纯假库 + 真 JWT，本机无 PG 可绿。
// 钉 Task 6 的新模型门控：node 由 loadRuntimeGraph 投影（nodeId=scene.id），
// isNpcDrivenNode 要求 nodeType==='npc' 且绑 npcId、配 chapterGoal——非 npc 场景即使留着
// npcId/chapterGoal 列也不得开对话（TR-6.2）；npc 场景凭预设 openingLine 直接发起（TR-6.1）。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const NPC_ROW = { id: 'npc1', name: '客栈掌柜', portraitUrl: null, voiceId: 'voice-male' };

const { state } = vi.hoisted(() => ({
  state: {
    // 每个用例按需放置投影节点（ProjectedNode 形状，这里只构造 start 路径读取的字段）。
    nodes: [] as any[],
    dialogueInserts: [] as any[],
  },
}));

// 规范图唯一入口被桩掉：返回当前 state.nodes + 全行 NPC；edges/endings 与 start 无关给空。
vi.mock('../../../services/wenlv/script-room.js', () => ({
  loadRuntimeGraph: async () => ({
    graph: { npcs: [NPC_ROW] },
    nodes: state.nodes,
    edges: [],
    endings: [],
  }),
  updateScene: vi.fn(),
}));

// 轻量假库：start 单人路径只 select player_progress/progress（空）并 insert 一条 dialogue。
vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const emptyWhere = () => ({
    orderBy: () => ({ limit: async () => [] as any[] }),
    limit: async () => [] as any[],
  });
  const db = {
    select: () => ({ from: () => ({ where: () => emptyWhere() }) }),
    insert: (table: unknown) => ({
      values: (v: any) => ({
        then: (onFulfilled: any, onRejected?: any) => {
          if (tableName(table) === 'pms_bui_wenlv_dialogues') state.dialogueInserts.push(v);
          return Promise.resolve().then(onFulfilled, onRejected);
        },
      }),
    }),
    update: () => ({ set: () => ({ where: () => ({ then: (fn: any) => Promise.resolve().then(fn) }) }) }),
  };
  return { db };
});

import dialogueRoute from '../wenlv-dialogue.js';

const signMini = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

const NPC_SCENE = {
  id: 'scene_npc',
  nodeType: 'npc',
  npcId: 'npc1',
  title: '客栈盘问',
  openingLine: '欢迎来到客栈。',
  image: null, // 无图 ⇒ 不触发生成视觉锚点（也不打 LLM）
  chapterGoal: { type: 'puzzle', description: '盘问暗道', answerCriteria: ['暗道'], minTurns: 2 },
};

const postStart = (nodeId: string, userId = 'u-dlg-1') =>
  dialogueRoute.request('/start', {
    method: 'POST',
    headers: { Authorization: `Bearer ${signMini(userId)}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ productId: 'p1', nodeId }),
  });

describe('POST /dialogue/start（0079 scenes 门控）', () => {
  beforeEach(() => {
    state.nodes = [];
    state.dialogueInserts = [];
  });

  it('TR-6.1 npc 场景（type=npc + npcId + chapterGoal）凭预设开场白发起 → 200 落对话', async () => {
    state.nodes = [NPC_SCENE];
    const res = await postStart('scene_npc');
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.openingLine).toBe('欢迎来到客栈。');
    expect(d.teamMode).toBe(false);
    expect(d.dialogueId).toBeTruthy();
    expect(d.npc).toMatchObject({ id: 'npc1', name: '客栈掌柜', voiceId: 'voice-male' });
    // nodeId=scene.id 落库，npcId 取自场景绑定；单人模式 teamId=null。
    expect(state.dialogueInserts).toHaveLength(1);
    expect(state.dialogueInserts[0]).toMatchObject({
      productId: 'p1', nodeId: 'scene_npc', npcId: 'npc1', teamId: null, status: 'active',
    });
  });

  it('TR-6.2 非 npc 场景即使留着 npcId/chapterGoal（投影 nodeType=scene）→ 400，不开对话', async () => {
    state.nodes = [{ ...NPC_SCENE, id: 'scene_plain', nodeType: 'scene' }];
    const res = await postStart('scene_plain');
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(String(body.error)).toContain('该节点不是 NPC 驱动模式');
    expect(state.dialogueInserts).toHaveLength(0);
  });

  it('nodeId 不在投影节点（结局场景不可对话 / 不存在）→ 404', async () => {
    state.nodes = [NPC_SCENE];
    const res = await postStart('scene_missing');
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('节点不存在');
    expect(state.dialogueInserts).toHaveLength(0);
  });

  it('未登录 → 401（门控在装配图之前）', async () => {
    state.nodes = [NPC_SCENE];
    const res = await dialogueRoute.request('/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: 'p1', nodeId: 'scene_npc' }),
    });
    expect(res.status).toBe(401);
    expect(state.dialogueInserts).toHaveLength(0);
  });
});
