// POST /products/:id/atoms/:atomId/complete 与 POST /track 端点测试（实景原子 Task 4）。
// 纯假库 + 真 JWT（parseMiniToken 真解签）+ WENLV_BYPASS_TICKET 旁路门票；本机无 PG 可绿。
// 假库 update 会把 payload 合并回 progress 活行，以承载「两原子跨请求完成节点」与幂等场景。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
process.env.WENLV_BYPASS_TICKET = '1';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';

const { state } = vi.hoisted(() => ({
  state: {
    productRows: [] as any[],
    nodeRows: [] as any[],
    progressRows: [] as any[],
    pointRows: [] as any[],
    characterRows: [] as any[],
    partnerRows: [] as any[],
    collectibleRows: [] as any[],
    // I1：命中的 atom key 让条件 UPDATE 模拟「并发赢家已先写」⇒ 影响 0 行（活行同步置 done）。
    zeroRowAtomKeys: [] as string[],
    // I1 配套：0 行重读时，赢家活行除 atoms done 外还已落 completed[nodeId]（完成链路也跑完）。
    zeroRowCompletedNodes: [] as string[],
    updateSets: [] as { table: string; payload: any }[],
    events: [] as any[],
  },
}));

vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const rowsFor = (table: unknown) => {
    const name = tableName(table);
    if (name === 'pms_bui_wenlv_products') return state.productRows;
    if (name === 'pms_bui_wenlv_scenes') return state.nodeRows;
    if (name === 'pms_bui_wenlv_progress') return state.progressRows;
    if (name === 'pms_bui_wenlv_venue_points') return state.pointRows;
    if (name === 'pms_bui_wenlv_characters') return state.characterRows;
    if (name === 'pms_bui_wenlv_merchant_partners') return state.partnerRows;
    if (name === 'pms_bui_wenlv_collectibles') return state.collectibleRows;
    if (name === 'pms_bui_wenlv_flows') return [{ count: 0 }]; // 夹具剧本均非边模型
    return []; // endings 等返回空
  };
  const makeWhere = (table: unknown) => {
    const w: any = {
      orderBy: () => w,
      limit: async () => rowsFor(table),
    };
    // settleEndings 直接 await where 结果（无 limit）。
    w.then = (onFulfilled: any, onRejected?: any) => Promise.resolve(rowsFor(table)).then(onFulfilled, onRejected);
    return w;
  };
  // drizzle sql`` 片段 duck-type（ctor 名 'SQL'，参数走 toQuery().params）。
  const isSqlChunk = (v: any): boolean =>
    !!v && typeof v === 'object' && v.constructor?.name === 'SQL';
  const sqlParams = (chunk: any): unknown[] => {
    try {
      return chunk.toQuery({
        escapeName: (s: string) => s,
        escapeParam: (v: unknown) => v,
        paramStartIndex: 0,
        prepareTypename: () => '',
      }).params as unknown[];
    } catch {
      return [];
    }
  };
  const thenable = (val: any) => ({
    then: (onFulfilled: any, onRejected?: any) => Promise.resolve(val).then(onFulfilled, onRejected),
  });
  const db = {
    select: () => ({ from: (table: unknown) => ({ where: () => makeWhere(table) }) }),
    insert: (table: unknown) => ({
      values: (v: any) => {
        const p: any = {
          then: (onFulfilled: any, onRejected?: any) => {
            if (tableName(table) === 'pms_bui_wenlv_events') state.events.push(v);
            return Promise.resolve().then(onFulfilled, onRejected);
          },
        };
        p.returning = async () => {
          if (tableName(table) === 'pms_bui_wenlv_events') state.events.push(v);
          return [{ ...v }];
        };
        return p;
      },
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: () => {
          const name = tableName(table);
          state.updateSets.push({ table: name, payload });
          // I1：state.atoms 单条条件 UPDATE（payload.state 为 sql`` 片段）。
          // 按活行 atoms[key].done 与 zeroRowAtomKeys 决定 0/1 行；1 行时就地更新活行并回 RETURNING。
          if (name === 'pms_bui_wenlv_progress' && isSqlChunk(payload.state)) {
            return {
              then: (onFulfilled: any, onRejected?: any) => Promise.resolve().then(onFulfilled, onRejected),
              returning: () => {
                const [setKey, doneJson] = sqlParams(payload.state);
                const key = String(setKey);
                const row = state.progressRows[0];
                const already = !!row && row.state?.atoms?.[key]?.done === true;
                const forcedZero = state.zeroRowAtomKeys.includes(key);
                if (!row || already || forcedZero) {
                  // forcedZero：模拟并发赢家在本请求期间先写成功（活行带上 done 供端点重读）。
                  if (row && forcedZero && !already) {
                    const wonNodeId = key.slice(0, Math.max(0, key.indexOf(':')));
                    row.state = {
                      ...row.state,
                      atoms: { ...(row.state.atoms ?? {}), [key]: JSON.parse(String(doneJson)) },
                      // 赢家连完成链路也跑完了：按测试预置补 completed[nodeId]。
                      ...(state.zeroRowCompletedNodes.includes(wonNodeId)
                        ? { completed: { ...(row.state.completed ?? {}), [wonNodeId]: true } }
                        : {}),
                    };
                  }
                  return thenable([]);
                }
                row.state = {
                  ...row.state,
                  atoms: { ...(row.state.atoms ?? {}), [key]: JSON.parse(String(doneJson)) },
                };
                return thenable([{ state: row.state }]);
              },
            };
          }
          if (name === 'pms_bui_wenlv_progress' && state.progressRows[0]) {
            Object.assign(state.progressRows[0], payload);
          }
          return thenable(undefined);
        },
      }),
    }),
  };
  return { db };
});

import wenlvRoute from '../wenlv.js';
import type { WenlvState } from '../../../db/schema/wenlv.js';

// 0079：原子端点改由运行时规范图取节点（loadRuntimeGraph → scenes 投影）。
// 纯单测不连新表，直接把夹具 nodeRows（旧 node 行形状，含 atoms/grants/venuePointId/requires）
// 作为投影 nodes 喂回；edges/endings 恒空（本套夹具均为无边、无结局剧本）。
// 本文件只打 atoms/track 端点（不触达 GET /:id 的其它 script-room 导出），故仅 mock 这一个函数。
vi.mock('../../../services/wenlv/script-room.js', () => ({
  loadRuntimeGraph: async (): Promise<unknown> =>
    ({ graph: null, nodes: state.nodeRows as any[], edges: [] as any[], endings: [] as any[] }),
}));

const P = 'p1';
const N = 'n1';
const U = 'u1';
const H = () => ({
  Authorization: `Bearer ${jwt.sign({ miniUserId: U, openid: 'o_' + U }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' })}`,
  'Content-Type': 'application/json',
});

const freshState = (s: Partial<WenlvState> = {}): WenlvState => ({
  visited: {}, collected: {}, completed: {}, ...s,
});

const setFixture = (node: any, progressState?: WenlvState) => {
  state.nodeRows = [node];
  state.progressRows = [{
    id: 'prog1', productId: P, miniUserId: U, status: 'active',
    endingId: null, characterId: null, sessionId: null,
    state: progressState ?? freshState(),
  }];
};

const complete = (atomId: string, body: Record<string, unknown> = {}) =>
  wenlvRoute.request(`/products/${P}/atoms/${atomId}/complete`, {
    method: 'POST',
    headers: H(),
    body: JSON.stringify({ nodeId: N, ...body }),
  });

const eventTypes = () => state.events.map((e: any) => e.eventType);
const persistedState = (): WenlvState => state.progressRows[0]?.state as WenlvState;

beforeEach(() => {
  state.productRows = [];
  state.nodeRows = [];
  state.progressRows = [];
  state.pointRows = [];
  state.characterRows = [];
  state.partnerRows = [];
  state.collectibleRows = [];
  state.zeroRowAtomKeys = [];
  state.zeroRowCompletedNodes = [];
  state.updateSets = [];
  state.events = [];
});

describe('POST /products/:id/atoms/:atomId/complete', () => {
  it('未登录 ⇒ 401', async () => {
    const res = await wenlvRoute.request(`/products/${P}/atoms/a1/complete`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ nodeId: N, code: 'X' }),
    });
    expect(res.status).toBe(401);
  });

  it('未开始体验（无 progress 行）⇒ 400', async () => {
    state.nodeRows = [{ id: N, productId: P, title: 't', venuePointId: null, grants: [], atoms: [{ id: 'a1', type: 'ar-echo', config: {} }] }];
    const res = await complete('a1');
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('尚未开始');
  });

  it('节点无此 atomId ⇒ 404', async () => {
    setFixture({ id: N, productId: P, title: 't', venuePointId: null, grants: [], atoms: [] });
    const res = await complete('ghost');
    expect(res.status).toBe(404);
  });

  it('code 对 ⇒ done+nodeCompleted，写 state.atoms/visited，埋 collect + node_complete', async () => {
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: '找', expectedCode: 'ABC' } }],
    });
    const res = await complete('a1', { code: 'ABC' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.done).toBe(true);
    expect(b.data.nodeCompleted).toBe(true);
    expect(b.data.grants).toContain('g1');
    const s = persistedState();
    expect(s.atoms?.[`${N}:a1`]?.done).toBe(true);
    expect(s.visited?.[N]).toBe(true); // 完成链路统一标记
    expect(s.completed?.[N]).toBe(true); // F2 完成标记随链路写回（幂等闸信号）
    expect(eventTypes().filter((t) => t === 'collect')).toHaveLength(1);
    expect(eventTypes()).toContain('node_complete');
  });

  it('code 错 ⇒ 200 done:false，不写状态不埋点', async () => {
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: '找', expectedCode: 'ABC' } }],
    });
    const res = await complete('a1', { code: 'ZZZ' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.done).toBe(false);
    expect(b.data.message).toBeTruthy();
    expect(persistedState().atoms).toBeUndefined();
    expect(state.events).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
  });

  it('expectedCode 缺省时回退绑定点位码（须先 /trigger 到场）', async () => {
    state.pointRows = [{ id: 'pt1', code: 'PTC-9' }];
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: 'pt1', grants: [],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: '找' } }],
    }, freshState({ visited: { [N]: true } }));
    const res = await complete('a1', { code: 'PTC-9' });
    expect((await res.json()).data.done).toBe(true);
  });

  it('cipher 对 ⇒ done 且埋 cipher_redeemed', async () => {
    state.partnerRows = [{ id: 'mp1', venueId: 'v1', status: 'active', replyCode: '芝麻' }];
    setFixture({
      id: N, productId: P, title: '接头', venuePointId: null, grants: [],
      atoms: [{ id: 'a1', type: 'cipher-contact', config: { cipherPhrase: 'p', merchantPartnerId: 'mp1' } }],
    });
    const res = await complete('a1', { code: '芝麻' });
    expect((await res.json()).data.done).toBe(true);
    expect(eventTypes()).toContain('cipher_redeemed');
  });

  it('attest（human-quest）⇒ 直接 done + task_grant', async () => {
    setFixture({
      id: N, productId: P, title: '委托', venuePointId: null, grants: [],
      atoms: [{ id: 'a1', type: 'human-quest', config: { questBrief: '跑腿' } }],
    });
    const res = await complete('a1');
    expect((await res.json()).data.done).toBe(true);
    expect(eventTypes()).toContain('task_grant');
  });

  it('collectibles 集齐 ⇒ done；未集齐 ⇒ done:false', async () => {
    const atom: any = { id: 'a1', type: 'cross-place', config: { collectibleIds: ['c1', 'c2'] } };
    setFixture({ id: N, productId: P, title: '拼图', venuePointId: null, grants: [], atoms: [atom] },
      freshState({ collected: { c1: true } }));
    const miss = await complete('a1');
    expect((await miss.json()).data.done).toBe(false);
    state.progressRows[0].state = freshState({ collected: { c1: true, c2: true } });
    const ok = await complete('a1');
    expect((await ok.json()).data.done).toBe(true);
  });

  it('answer（single）复用 /answer 归一：对 ⇒ done，错 ⇒ done:false', async () => {
    setFixture({
      id: N, productId: P, title: '问答', venuePointId: null, grants: [],
      atoms: [{ id: 'a1', type: 'single', config: { question: 'q', options: ['A', 'B'], answer: 'B' } }],
    });
    expect((await (await complete('a1', { answer: ' B ' })).json()).data.done).toBe(true);
    // 重置：上一条已写 done，重开一行验证错答
    state.progressRows[0].state = freshState();
    state.events = [];
    expect((await (await complete('a1', { answer: 'A' })).json()).data.done).toBe(false);
  });

  it('item-combine 通过 ⇒ 回补 revealText', async () => {
    setFixture({
      id: N, productId: P, title: '组合', venuePointId: null, grants: [],
      atoms: [{ id: 'a1', type: 'item-combine', config: { itemIds: ['i1', 'i2'], revealText: '机关开了' } }],
    });
    const b = (await (await complete('a1', { answer: ['i2', 'i1'] })).json()).data;
    expect(b.done).toBe(true);
    expect(b.revealText).toBe('机关开了');
  });

  it('多个 required：非最后一个只持久化字典、不走完成链路；最后一个才触发节点完成（仅一次）', async () => {
    setFixture({
      id: N, productId: P, title: '双原子', venuePointId: null, grants: ['g1'],
      atoms: [
        { id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'K' } },
        { id: 'a2', type: 'human-quest', config: { questBrief: 'q' } },
      ],
    });
    const first = (await (await complete('a1', { code: 'K' })).json()).data;
    expect(first.done).toBe(true);
    expect(first.nodeCompleted).toBe(false);
    let s = persistedState();
    expect(s.atoms?.[`${N}:a1`]?.done).toBe(true);
    expect(s.visited?.[N]).toBeUndefined();
    expect(eventTypes()).not.toContain('node_complete');

    const second = (await (await complete('a2')).json()).data;
    expect(second.nodeCompleted).toBe(true);
    s = persistedState();
    expect(s.atoms?.[`${N}:a2`]?.done).toBe(true);
    expect(s.visited?.[N]).toBe(true);
    expect(s.completed?.[N]).toBe(true);
    expect(eventTypes().filter((t) => t === 'node_complete')).toHaveLength(1);
    expect(eventTypes()).toContain('task_grant');
  });

  it('幂等：已 done 的原子再提交 ⇒ 不重复埋点/不重复更新/不重复完成事件', async () => {
    // 修复后的真实存量态：首次走完成链路时 completed[N] 已随 state 持久化。
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'ABC' } }],
    }, freshState({
      completed: { [N]: true },
      atoms: { [`${N}:a1`]: { done: true, at: '2026-01-01T00:00:00Z' } },
    }));
    const res = await complete('a1', { code: 'WRONG-EVEN-IF-SO' });
    const b = await res.json();
    expect(b.data.done).toBe(true);
    expect(b.data.nodeCompleted).toBe(true);
    expect(state.events).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
  });

  it('幂等直返口径：required 全 done 但 completed 未标记（历史卡死行）⇒ nodeCompleted 如实报 false', async () => {
    // 0bdf6639 部署窗口可能造出的存量态：visited 已置、required 原子全 done，
    // 但完成链路被错误闸跳过、completed 未落。直返分支不得把它报成已完成。
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: 'pt1', grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'ABC' } }],
    }, freshState({
      visited: { [N]: true },
      atoms: { [`${N}:a1`]: { done: true, at: '2026-01-01T00:00:00Z' } },
    }));
    const b = (await (await complete('a1', { code: 'ABC' })).json()).data;
    expect(b.done).toBe(true);
    expect(b.nodeCompleted).toBe(false);
    expect(state.events).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
  });

  // ── C1：两道服务端门禁（与 /answer 同款，任何写入/埋点/verify 之前）──────────
  it('C1 绑点位但未到场（visited 未置）⇒ 403 到场拒绝，持码正确也不放行，零写入零埋点', async () => {
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: 'pt1', grants: [],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: '找', expectedCode: 'ABC' } }],
    });
    const res = await complete('a1', { code: 'ABC' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('请先到场触发该节点');
    expect(persistedState().atoms).toBeUndefined();
    expect(state.events).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
  });

  it('C1 /trigger 到场后（visited=true）再完成绑点位原子 ⇒ 200 done/完成链路照跑', async () => {
    // 🔴 关键回归（0bdf6639 的 F2 错用 visited 当闸）：/trigger 到场即 markVisited，
    // 绑点位节点做完最后一个 required 原子时完成链路曾被整体跳过。visited 预置不得抑制链路。
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: 'pt1', grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: '找', expectedCode: 'ABC' } }],
    }, freshState({ visited: { [N]: true } }));
    const res = await complete('a1', { code: 'ABC' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.done).toBe(true);
    expect(b.data.nodeCompleted).toBe(true);
    const s = persistedState();
    expect(s.atoms?.[`${N}:a1`]?.done).toBe(true);
    expect(s.visited?.[N]).toBe(true);
    expect(s.completed?.[N]).toBe(true);        // 完成标记落库（F2 新闸信号）
    expect(s.collected?.g1).toBe(true);         // grants 侧效应由完成链路驱动
    expect(eventTypes()).toContain('node_complete');
    expect(eventTypes()).toContain('collect');
    // 完成链路的整行写恰好一次（区别于原子字典的条件 UPDATE）。
    const objWrites = state.updateSets
      .filter((u) => u.table === 'pms_bui_wenlv_progress' && u.payload.state.constructor?.name !== 'SQL');
    expect(objWrites).toHaveLength(1);
  });

  it('C1 requires 前置条件不满足 ⇒ 403 与 /answer 同款拒绝，零写入零埋点', async () => {
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: [],
      requires: { type: 'visited', id: 'gate-node' },
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: '找', expectedCode: 'ABC' } }],
    });
    const res = await complete('a1', { code: 'ABC' });
    expect(res.status).toBe(403);
    expect((await res.json()).error).toBe('前置条件未满足');
    expect(persistedState().atoms).toBeUndefined();
    expect(state.events).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
  });

  it('C1 requires 满足（gate 已 visited）⇒ 正常 200', async () => {
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: [],
      requires: { type: 'visited', id: 'gate-node' },
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: '找', expectedCode: 'ABC' } }],
    }, freshState({ visited: { 'gate-node': true } }));
    const res = await complete('a1', { code: 'ABC' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.done).toBe(true);
  });

  // ── F1：rally 发章闸前置（与 applyNodeCompletion 同一谓词，零写入 403）──────
  it('F1 rally 未绑点位却发印章的节点：原子通过也 403，state.atoms/events 零写入', async () => {
    state.productRows = [{ id: P, mode: 'rally' }];
    state.collectibleRows = [{ id: 's1', productId: P, type: 'stamp' }];
    setFixture({
      id: N, productId: P, title: '远程章', venuePointId: null, grants: ['s1'],
      atoms: [{ id: 'a1', type: 'human-quest', config: { questBrief: 'q' } }],
    });
    const res = await complete('a1');
    expect(res.status).toBe(403);
    expect((await res.json()).error).toContain('远程集章');
    expect(persistedState().atoms).toBeUndefined();
    expect(state.events).toHaveLength(0);
    expect(state.updateSets).toHaveLength(0);
  });

  // ── F2：节点完成幂等闸（completed 标记；visited 仅表到场、绝不能当完成信号）─────
  it('F2 回归：绑点位节点 /trigger 已到场（visited=true），逐原子到最后一个 required ⇒ 完成链路恰好触发一次', async () => {
    // 主场景（physical-search/cipher-contact 等绑点位原子节点）：visited 在答题/做原子之前
    // 就已为 true。修复前这里跳过 applyNodeCompletion：grants 不发、puzzle_pass 边不流转、
    // 结局不结算、玩家卡死。
    setFixture({
      id: N, productId: P, title: '双原子点位', venuePointId: 'pt1', grants: ['g1'],
      atoms: [
        { id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'K' } },
        { id: 'a2', type: 'human-quest', config: { questBrief: 'q' } },
        { id: 'a3', type: 'human-quest', required: false, config: { questBrief: '可选' } },
      ],
    }, freshState({ visited: { [N]: true } }));

    const first = (await (await complete('a1', { code: 'K' })).json()).data;
    expect(first.nodeCompleted).toBe(false);
    expect(eventTypes()).not.toContain('node_complete');
    expect(persistedState().completed?.[N]).toBeUndefined();

    const second = (await (await complete('a2')).json()).data;
    expect(second.nodeCompleted).toBe(true);
    const s = persistedState();
    expect(s.completed?.[N]).toBe(true);        // 完成标记随链路持久化
    expect(s.visited?.[N]).toBe(true);          // 到场标记保持
    expect(s.collected?.g1).toBe(true);         // grants 由完成链路发放
    expect(s.atoms?.[`${N}:a2`]?.done).toBe(true);
    expect(eventTypes().filter((t) => t === 'node_complete')).toHaveLength(1);
    // 完成链路整行写恰好一次。
    let objWrites = state.updateSets
      .filter((u) => u.table === 'pms_bui_wenlv_progress' && u.payload.state.constructor?.name !== 'SQL');
    expect(objWrites).toHaveLength(1);
    // 写回的整行 state 自带 completed 标记（applyGrants 重建三键不丢、atoms 挂回不丢）。
    expect(objWrites[0].payload.state.completed?.[N]).toBe(true);
    expect(objWrites[0].payload.state.atoms?.[`${N}:a1`]?.done).toBe(true);

    // 再做一个可选原子 ⇒ 不二次触发：无第二条 node_complete、完成链路不再整行写库。
    const third = (await (await complete('a3')).json()).data;
    expect(third.done).toBe(true);
    expect(third.nodeCompleted).toBe(true);
    expect(eventTypes().filter((t) => t === 'node_complete')).toHaveLength(1);
    expect(eventTypes()).toContain('task_grant'); // 可选原子自身事件照埋
    objWrites = state.updateSets
      .filter((u) => u.table === 'pms_bui_wenlv_progress' && u.payload.state.constructor?.name !== 'SQL');
    expect(objWrites).toHaveLength(1);
    expect(persistedState().completed?.[N]).toBe(true);
  });

  it('F2 无点位节点：首原子（required）完成即触发并写 completed；再做可选原子不重复触发', async () => {
    setFixture({
      id: N, productId: P, title: '双原子', venuePointId: null, grants: ['g1'],
      atoms: [
        { id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'K' } },
        { id: 'a2', type: 'human-quest', required: false, config: { questBrief: 'q' } },
      ],
    });
    const first = (await (await complete('a1', { code: 'K' })).json()).data;
    expect(first.nodeCompleted).toBe(true);
    let s = persistedState();
    expect(s.completed?.[N]).toBe(true);
    expect(s.visited?.[N]).toBe(true);
    expect(eventTypes().filter((t) => t === 'node_complete')).toHaveLength(1);

    const second = (await (await complete('a2')).json()).data;
    expect(second.nodeCompleted).toBe(true);
    s = persistedState();
    expect(s.atoms?.[`${N}:a2`]?.done).toBe(true);
    expect(eventTypes().filter((t) => t === 'node_complete')).toHaveLength(1);
    // 第二次只有原子字典条件 UPDATE，无完成链路整行写。
    const objWrites = state.updateSets
      .filter((u) => u.table === 'pms_bui_wenlv_progress' && u.payload.state.constructor?.name !== 'SQL');
    expect(objWrites).toHaveLength(1);
  });

  it('F2 required 全为 false 的节点：首个原子完成即触发完成链路（语义留痕）', async () => {
    setFixture({
      id: N, productId: P, title: '可选原子节点', venuePointId: null, grants: ['g1'],
      atoms: [{ id: 'a1', type: 'human-quest', required: false, config: { questBrief: 'q' } }],
    });
    const b = (await (await complete('a1')).json()).data;
    expect(b.done).toBe(true);
    expect(b.nodeCompleted).toBe(true);
    expect(eventTypes()).toContain('node_complete');
    expect(persistedState().visited?.[N]).toBe(true);
    expect(persistedState().completed?.[N]).toBe(true);
  });

  // ── I1：条件 UPDATE 0 行（并发赢家先写）⇒ 重读幂等返回，不埋点不触发链路 ────
  it('I1 条件 UPDATE 0 行且重读行已含 completed[nodeId] ⇒ nodeCompleted=true，零事件零链路', async () => {
    state.zeroRowAtomKeys = [`${N}:a1`];
    state.zeroRowCompletedNodes = [N]; // 赢家把原子与完成链路都跑完了
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'K' } }],
    });
    const res = await complete('a1', { code: 'K' });
    const b = await res.json();
    expect(res.status).toBe(200);
    expect(b.data.done).toBe(true);
    expect(b.data.nodeCompleted).toBe(true); // required 全 done 且 completed 已落
    expect(state.events).toHaveLength(0);     // collect / node_complete 均不写
    expect(eventTypes()).not.toContain('node_complete');
    // 只有一条条件 UPDATE，无 applyNodeCompletion 的整行写。
    const progWrites = state.updateSets.filter((u) => u.table === 'pms_bui_wenlv_progress');
    expect(progWrites).toHaveLength(1);
    expect(progWrites[0].payload.state.constructor?.name).toBe('SQL');
    // 端点重读看到的赢家写入
    expect(persistedState().atoms?.[`${N}:a1`]?.done).toBe(true);
    expect(persistedState().completed?.[N]).toBe(true);
  });

  it('I1 条件 UPDATE 0 行但重读行只写了原子字典（completed 未落）⇒ nodeCompleted 如实 false', async () => {
    // 与正常分支同口径：required 全 done 单独不等于节点完成；本请求不补跑链路（不埋点）。
    state.zeroRowAtomKeys = [`${N}:a1`];
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'K' } }],
    });
    const b = (await (await complete('a1', { code: 'K' })).json()).data;
    expect(b.done).toBe(true);
    expect(b.nodeCompleted).toBe(false);
    expect(state.events).toHaveLength(0);
    expect(persistedState().atoms?.[`${N}:a1`]?.done).toBe(true);
    expect(persistedState().completed?.[N]).toBeUndefined();
  });

  it('I1 条件 UPDATE 命中 1 行 ⇒ 以 RETURNING state 判定并正常走完成链路', async () => {
    setFixture({
      id: N, productId: P, title: '寻物', venuePointId: null, grants: ['g1'],
      atoms: [{ id: 'a1', type: 'physical-search', config: { prompt: 'p', expectedCode: 'K' } }],
    });
    const res = await complete('a1', { code: 'K' });
    const b = await res.json();
    expect(b.data.done).toBe(true);
    expect(b.data.nodeCompleted).toBe(true);
    expect(persistedState().atoms?.[`${N}:a1`]?.done).toBe(true);
    expect(persistedState().visited?.[N]).toBe(true);
    expect(persistedState().completed?.[N]).toBe(true);
    expect(eventTypes()).toContain('collect');
    expect(eventTypes()).toContain('node_complete');
  });
});

describe('POST /track', () => {
  const track = (body: Record<string, unknown>) =>
    wenlvRoute.request('/track', { method: 'POST', headers: H(), body: JSON.stringify(body) });

  it('白名单事件落 events', async () => {
    const res = await track({ productId: P, eventType: 'purchased', payload: { sku: 'x' }, nodeId: N });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
    expect(state.events).toHaveLength(1);
    expect(state.events[0]).toMatchObject({ productId: P, miniUserId: U, eventType: 'purchased', nodeId: N });
    expect(state.events[0].payload).toEqual({ sku: 'x' });
  });

  it('白名单事件 paid_customization 落 events（P2 修复：此前被 400 静默丢弃）', async () => {
    const res = await track({ productId: P, eventType: 'paid_customization', payload: { merchantPartnerId: 'mp-1' } });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);
  });

  it('payload 缺省/为数组 ⇒ 落 {} 不报错', async () => {
    const res = await track({ productId: P, eventType: 'shared', payload: ['nope'] });
    expect(res.status).toBe(200);
    expect(state.events[0].payload).toEqual({});
  });

  it('非法 eventType ⇒ 400；缺 productId ⇒ 400', async () => {
    expect((await track({ productId: P, eventType: 'hack' })).status).toBe(400);
    expect((await track({ eventType: 'shared' })).status).toBe(400);
    expect(state.events).toHaveLength(0);
  });

  it('未登录 ⇒ 401', async () => {
    const res = await wenlvRoute.request('/track', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: P, eventType: 'shared' }),
    });
    expect(res.status).toBe(401);
  });

  it('F3 productId/nodeId 超 varchar(50) ⇒ 400 且不落事件', async () => {
    const long51 = 'x'.repeat(51);
    expect((await track({ productId: long51, eventType: 'shared' })).status).toBe(400);
    expect((await track({ productId: P, eventType: 'shared', nodeId: long51 })).status).toBe(400);
    expect(state.events).toHaveLength(0);
  });

  it('F3 payload 对象 JSON 体积 > 4000 字符 ⇒ 400', async () => {
    const big = { note: 'x'.repeat(5000) };
    const res = await track({ productId: P, eventType: 'shared', payload: big });
    expect(res.status).toBe(400);
    expect(state.events).toHaveLength(0);
  });

  it('F3 边界值：productId/nodeId 恰好 50 字符、payload 体积 ≤4000 ⇒ 200', async () => {
    const id50 = 'p'.repeat(50);
    const payload = { note: 'x'.repeat(3989) }; // {"note":""} 占 11 字符，合计恰好 4000
    expect(JSON.stringify(payload).length).toBe(4000);
    const res = await track({ productId: id50, eventType: 'shared', payload, nodeId: 'n'.repeat(50) });
    expect(res.status).toBe(200);
    expect(state.events).toHaveLength(1);
  });
});
