// GET /api/mini/wenlv/my-play/report/:productId（0079 统一重建）：纯假库 + 真 JWT，本机无 PG 可绿。
// 钉 Task 7：已达成结局由规范图投影（type='ending' 场景）经唯一真相源 selectEnding 裁决——
// 不同 triggerCondition 命中不同结局（TR-7.1），报告能读出该结局 id/title（TR-7.2），不再读旧 endings 表。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const { state } = vi.hoisted(() => ({
  state: {
    playerProgress: [] as any[],
    dialogues: [] as any[],
    endings: [] as any[],
  },
}));

// 结局集由规范图投影喂入（ProjectedEnding 形状；内部保留 triggerCondition 供 selectEnding）。
vi.mock('../../../services/wenlv/script-room.js', () => ({
  loadRuntimeGraph: async (productId: string) => ({
    graph: null, nodes: [], edges: [],
    endings: state.endings.map((e) => ({ ...e })),
    __productId: productId,
  }),
}));

vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const rowsFor = (table: unknown) => {
    const name = tableName(table);
    if (name === 'pms_bui_wenlv_player_progress') return state.playerProgress;
    if (name === 'pms_bui_wenlv_dialogues') return state.dialogues;
    if (name === 'pms_bui_wenlv_products') return [{ name: '测试剧本杀' }];
    return []; // collectibles 等给空
  };
  // 报告端点混用 .limit(1)（解构首行）与无 limit（直接 await 数组），where 链两者都给。
  const where = (table: unknown) => ({
    limit: async () => rowsFor(table),
    then: (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(rowsFor(table)).then(onFulfilled, onRejected),
  });
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => where(table) }) }),
  };
  return { db };
});

import route from '../wenlv-my-play.js';

const UID = 'u-report-1';
const sign = () =>
  jwt.sign({ miniUserId: UID, openid: 'o_x' }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
const getReport = (productId = 'p1') =>
  route.request(`/report/${productId}`, { headers: { Authorization: `Bearer ${sign()}` } });

// 两个结局：好结局要集齐 key_good（高优先），坏结局要 key_evil。满足谁由 collected 决定。
const E_GOOD = {
  id: 'e_good', title: '真相大白', text: '好结局文案', image: null, rewardId: null, priority: 10,
  triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'key_good' } },
};
const E_BAD = {
  id: 'e_bad', title: '含冤离场', text: '坏结局文案', image: null, rewardId: null, priority: 5,
  triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'key_evil' } },
};

const seedProgress = (collected: string[]) => {
  state.playerProgress = [{
    id: 'pp1', san: 80, collectedCollectibles: collected,
    createdAt: new Date(0), updatedAt: new Date(60_000),
  }];
  // 有 completed 对话才算通关；visited/completed 以 sceneId 为键。
  state.dialogues = [{ id: 'd1', nodeId: 'scene_final', status: 'completed' }];
};

describe('GET /my-play/report/:productId（0079 场景结局裁决）', () => {
  beforeEach(() => {
    state.endings = [E_GOOD, E_BAD];
    state.playerProgress = [];
    state.dialogues = [];
  });

  it('TR-7.1/7.2 集齐好结局证物 ⇒ selectEnding 裁出 e_good，报告读出其 id/title', async () => {
    seedProgress(['key_good']);
    const res = await getReport();
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.ending).toEqual({ id: 'e_good', title: '真相大白', text: '好结局文案' });
    expect(d.productName).toBe('测试剧本杀');
    // 另一结局进隐藏提示（未发现口吻，不泄漏条件）。
    expect(d.hiddenEndingHints.some((h: string) => h.includes('含冤离场'))).toBe(true);
  });

  it('TR-7.1 集齐的是坏结局证物 ⇒ 裁出 e_bad（按 triggerCondition 而非固定取高优先）', async () => {
    seedProgress(['key_evil']);
    const res = await getReport();
    expect(res.status).toBe(200);
    const d = (await res.json()).data;
    expect(d.ending?.id).toBe('e_bad');
    expect(d.ending?.title).toBe('含冤离场');
  });

  it('无 player_progress 行 ⇒ 404 无游玩记录', async () => {
    const res = await getReport();
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('无游玩记录');
  });

  it('有进度但无 completed 对话（未通关）⇒ 400 尚未通关，不裁决结局', async () => {
    state.playerProgress = [{ san: 80, collectedCollectibles: [], createdAt: new Date(0), updatedAt: new Date() }];
    state.dialogues = [{ id: 'd1', nodeId: 'scene_mid', status: 'active' }];
    const res = await getReport();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('尚未通关');
  });

  it('未登录 ⇒ 401', async () => {
    const res = await route.request('/report/p1');
    expect(res.status).toBe(401);
  });
});
