// applyNodeCompletion 承重测试（Task 4 抽取自 POST /answer）：纯假库，本机无 PG 可绿。
// 不追求全覆盖，只钉「搬移后行为不变」的关键效果：grants/visited 写库、answer 事件、
// rally 发章闸、队伍进度同步（collabKey 清除）、state.atoms 回带、player 证物同步。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    progressRows: [] as any[],
    endingRows: [] as any[],
    productRows: [] as any[],
    stampRows: [] as any[],
    playerRows: [] as any[],
    edgeCount: 0,
    updateSets: [] as { table: string; payload: any }[],
    inserted: [] as { table: string; values: any }[],
  },
}));

vi.mock('../../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const rowsFor = (table: unknown) => {
    const name = tableName(table);
    if (name === 'pms_bui_wenlv_flows') return [{ count: state.edgeCount }];
    if (name === 'pms_bui_wenlv_progress') return state.progressRows;
    if (name === 'pms_bui_wenlv_scenes') return state.endingRows;
    if (name === 'pms_bui_wenlv_products') return state.productRows;
    if (name === 'pms_bui_wenlv_collectibles') return state.stampRows;
    if (name === 'pms_bui_wenlv_player_progress') return state.playerRows;
    return [];
  };
  const makeWhere = (table: unknown) => {
    const w: any = {
      limit: async () => rowsFor(table),
      orderBy: () => w,
    };
    w.then = (onFulfilled: any, onRejected?: any) => Promise.resolve(rowsFor(table)).then(onFulfilled, onRejected);
    return w;
  };
  const db = {
    select: () => ({
      from: (table: unknown) => ({ where: () => makeWhere(table) }),
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: async () => { state.updateSets.push({ table: tableName(table), payload }); },
      }),
    }),
    insert: (table: unknown) => ({
      values: (v: any) => Promise.resolve(state.inserted.push({ table: tableName(table), values: v })),
    }),
  };
  return { db };
});

import { applyNodeCompletion } from '../complete-node.js';
import type { WenlvState } from '../../../../db/schema/wenlv.js';

const emptyState = (): WenlvState => ({ visited: {}, collected: {}, completed: {} });

const baseInput = (over: Partial<any> = {}) => ({
  productId: 'p1',
  progressId: 'prg1',
  nodeId: 'n1',
  miniUserId: 'u1',
  state: emptyState(),
  node: { id: 'n1', venuePointId: 'pt1', title: '节点一', grants: ['g1', 'g2'] },
  // 0079：边/结局由规范图投影传入（不再由函数内部查旧 node_edges/endings 表）。
  edges: [] as any[],
  endings: [] as any[],
  progress: { id: 'prg1', status: 'active', endingId: null },
  ...over,
});

beforeEach(() => {
  state.progressRows = [];
  state.endingRows = [];
  state.productRows = [];
  state.stampRows = [];
  state.playerRows = [];
  state.edgeCount = 0;
  state.updateSets = [];
  state.inserted = [];
});

describe('applyNodeCompletion（自 /answer 抽取的节点完成链路）', () => {
  it('通关：visited 标记 + grants 并入 collected 后写 progress，并插 answer 事件', async () => {
    const r = await applyNodeCompletion(baseInput());
    expect(r.stampError).toBeNull();
    expect(r.endings).toEqual([]);
    expect(r.mine).toEqual([]);
    expect(r.teamProgress).toBeNull();
    // progress 恰好写一次，落库 state 含 visited 与 grants
    const progWrites = state.updateSets.filter((u) => u.table === 'pms_bui_wenlv_progress');
    expect(progWrites).toHaveLength(1);
    const persisted = progWrites[0].payload.state;
    expect(persisted.visited.n1).toBe(true);
    expect(persisted.collected).toMatchObject({ g1: true, g2: true });
    // answer 事件流水（payload 默认 {}，与单人 /answer 逐字一致）
    const evt = state.inserted.find((i) => i.table === 'pms_bui_wenlv_events');
    expect(evt).toBeTruthy();
    if (!evt) throw new Error('answer 事件未写入');
    expect(evt.values.eventType).toBe('answer');
    expect(evt.values.nodeId).toBe('n1');
    expect(evt.values.payload).toEqual({});
    expect(evt.values.miniUserId).toBe('u1');
  });

  it('state.atoms 回带：原子通关时 done 记录不被 applyGrants 出口丢掉', async () => {
    const s = emptyState();
    s.atoms = { 'n1:a1': { done: true, at: '2026-10-07T00:00:00.000Z' } };
    await applyNodeCompletion(baseInput({ state: s }));
    const persisted = state.updateSets.find((u) => u.table === 'pms_bui_wenlv_progress')!.payload.state;
    expect(persisted.atoms).toEqual({ 'n1:a1': { done: true, at: '2026-10-07T00:00:00.000Z' } });
  });

  it('原子链路预置的 completed[n1] 标记随完成链路整体写回，三键重建不丢', async () => {
    // F2：原子端点在调用前置 completed[n1]=true。markVisited 透传、applyGrants 有 grants
    // 时重建三键（展开既有 completed）、atoms 尾部挂回——最终写库必须同时保留四类数据。
    const s: WenlvState = {
      visited: { n1: true }, // 绑点位节点：/trigger 已到场
      collected: {},
      completed: { n1: true },
      atoms: { 'n1:a1': { done: true, at: '2026-10-07T00:00:00.000Z' } },
    };
    const r = await applyNodeCompletion(baseInput({ state: s, eventType: 'node_complete' }));
    expect(r.stampError).toBeNull();
    const persisted = state.updateSets.find((u) => u.table === 'pms_bui_wenlv_progress')!.payload.state;
    expect(persisted.completed).toMatchObject({ n1: true });
    expect(persisted.visited).toMatchObject({ n1: true });
    expect(persisted.collected).toMatchObject({ g1: true, g2: true });
    expect(persisted.atoms).toEqual({ 'n1:a1': { done: true, at: '2026-10-07T00:00:00.000Z' } });
    // 返回态与写回态同一口径，端点直接拿去做响应。
    expect(r.state.completed?.n1).toBe(true);
  });

  it('rally 节点未绑点位却发印章 ⇒ stampError 中止，不写库不插事件', async () => {
    state.productRows = [{ mode: 'rally' }];
    state.stampRows = [{ id: 's1', type: 'stamp' }];
    const r = await applyNodeCompletion(baseInput({
      node: { venuePointId: null, title: '远程章节点', grants: ['s1'] },
    }));
    expect(r.stampError).toContain('远程章节点');
    expect(state.updateSets).toHaveLength(0);
    expect(state.inserted).toHaveLength(0);
  });

  it('组局：team.progress 以并集重算，clearCollabKey 删除本节点协作答案、他题保留', async () => {
    // completed 三键同样随并集重算：原子链路预置的 n1 标记与队友历史 doneOld 都不得丢。
    const s: WenlvState = { visited: {}, collected: { g1: true }, completed: { n1: true } };
    const evalState: WenlvState = { visited: { other: true }, collected: {}, completed: { doneOld: true } };
    const r = await applyNodeCompletion(baseInput({
      state: s,
      evalState,
      team: { id: 'team1' },
      teamProgress: { collaborativeAnswers: { n1: { u1: 'X' }, n2: { u2: 'Y' } } },
      clearCollabKey: 'n1',
      eventPayload: { collaborative: true, leaderConfirm: false },
    }));
    expect(r.teamProgress).not.toBeNull();
    const teamWrite = state.updateSets.find((u) => u.table === 'pms_bui_wenlv_teams')!;
    expect(teamWrite.payload.progress.visited).toMatchObject({ other: true, n1: true });
    expect(teamWrite.payload.progress.collected).toMatchObject({ g1: true });
    expect(teamWrite.payload.progress.completed).toMatchObject({ n1: true, doneOld: true });
    expect(teamWrite.payload.progress.collaborativeAnswers).toEqual({ n2: { u2: 'Y' } });
    // 协作链路的 answer 事件 payload 原样保留
    expect(state.inserted.find((i) => i.table === 'pms_bui_wenlv_events')!.values.payload)
      .toEqual({ collaborative: true, leaderConfirm: false });
  });

  it('新发放证物同步 player_progress.collectedCollectibles（与既有行去重合并）', async () => {
    state.playerRows = [{ id: 'pp1', collectedCollectibles: ['old'] }];
    await applyNodeCompletion(baseInput({ node: { venuePointId: 'pt1', grants: ['g1'], title: 't' } }));
    const ppWrite = state.updateSets.find((u) => u.table === 'pms_bui_wenlv_player_progress')!;
    expect(ppWrite).toBeTruthy();
    expect(ppWrite.payload.collectedCollectibles.sort()).toEqual(['g1', 'old']);
  });

  it('player_progress 无行时跳过同步（不新增、不报错）', async () => {
    await applyNodeCompletion(baseInput());
    expect(state.updateSets.some((u) => u.table === 'pms_bui_wenlv_player_progress')).toBe(false);
  });

  it('M6 eventType 收窄：默认 answer，显式 node_complete 原样落事件', async () => {
    await applyNodeCompletion(baseInput());
    await applyNodeCompletion(baseInput({ eventType: 'node_complete', eventPayload: { atomId: 'a9' } }));
    const evts = state.inserted.filter((i) => i.table === 'pms_bui_wenlv_events').map((i) => i.values);
    expect(evts.map((e) => e.eventType)).toEqual(['answer', 'node_complete']);
    expect(evts[1].payload).toEqual({ atomId: 'a9' });
  });

  // ── 0079 统一模型：puzzle_pass 边流转与结局结算（边/结局由投影传入）────────────
  it('puzzle_pass 边：答对后自动解锁目标节点并发放边 grants（随本节点一并写库）', async () => {
    const edges = [
      { id: 'e1', fromNodeId: 'n1', toNodeId: 'n2', edgeType: 'puzzle_pass', label: null, condition: null, grants: ['g3'], sanDelta: -2 },
    ];
    const r = await applyNodeCompletion(baseInput({ edges }));
    expect(r.stampError).toBeNull();
    const persisted = state.updateSets.find((u) => u.table === 'pms_bui_wenlv_progress')!.payload.state;
    expect(persisted.visited.n1).toBe(true);   // markVisited 本节点
    expect(persisted.visited.n2).toBe(true);   // puzzle_pass 自动解锁
    expect(persisted.collected).toMatchObject({ g1: true, g2: true, g3: true });
  });

  it('puzzle_pass 边条件不满足（未到 gate）⇒ 不解锁 n2、不发边 grants', async () => {
    const edges = [
      { id: 'e1', fromNodeId: 'n1', toNodeId: 'n2', edgeType: 'puzzle_pass', label: null,
        condition: { type: 'ref', ref: { kind: 'visited', id: 'gate' } }, grants: ['g3'], sanDelta: 0 },
    ];
    await applyNodeCompletion(baseInput({ edges }));
    const persisted = state.updateSets.find((u) => u.table === 'pms_bui_wenlv_progress')!.payload.state;
    expect(persisted.visited.n2).toBeUndefined();
    expect(persisted.collected.g3).toBeUndefined();
  });

  it('结局结算：visited 命中结局条件 ⇒ 个人行落 completed+endingId（首次盖 completedAt），mine/endings 返回该结局', async () => {
    const endings = [
      { id: 'E1', priority: 1, triggerCondition: { type: 'ref', ref: { kind: 'visited', id: 'n1' } } },
    ];
    const r = await applyNodeCompletion(baseInput({ endings }));
    expect(r.mine).toEqual(['E1']);
    expect(r.endings).toEqual(['E1']); // 散客：主位 endings = mine
    const endingWrite = state.updateSets.find(
      (u) => u.table === 'pms_bui_wenlv_progress' && u.payload.endingId === 'E1',
    );
    expect(endingWrite).toBeTruthy();
    expect(endingWrite!.payload.status).toBe('completed');
    expect(endingWrite!.payload.completedAt).toBeTruthy();
  });
});
