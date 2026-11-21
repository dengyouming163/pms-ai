// 0079 统一重建 · 发布闸 / 快照 / 回滚（纯假库，本机无 PG 可绿）。
// 钉 Task 8：
//   TR-8.3 空气包（规范图空）⇒ POST publish 409，且 product 绝不被置 live、不落快照；
//   TR-8.1 合规规范图（room/chapter/scene + ending 场景/character）⇒ 200，
//           快照 snapshotData.scriptGraph 存全量 room/chapters/scenes/flows，room 与 product 双侧挂牌；
//   TR-8.2 rollback ⇒ 事务按 flows→scenes→chapters 删光再按快照重建（结局随 type='ending' 场景还原），
//           room 回 draft、product 回 preview。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  productRow: null as any,
  characters: [] as any[],
  runtime: { graph: null, nodes: [], edges: [], endings: [] } as any,
  snapshotRows: [] as any[],
  curRoom: null as any,
  curChapterIds: ['ch1'] as string[],
  curSceneIds: ['s1'] as string[],
  productUpdates: [] as any[],
  roomUpdates: [] as any[],
  snapshotInserts: [] as any[],
  txDeletes: [] as string[],
  txInserts: [] as { table: string; rows: any[] }[],
  txUpdates: [] as { table: string; set: any }[],
}));

// 剧情图唯一来源：规范图投影。
vi.mock('../../../services/wenlv/script-room.js', () => ({
  loadRuntimeGraph: async () => ({
    graph: state.runtime.graph,
    nodes: state.runtime.nodes,
    edges: state.runtime.edges,
    endings: state.runtime.endings,
  }),
}));

vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';

  const topRows = (table: unknown) => {
    const name = tableName(table);
    if (name === 'pms_bui_wenlv_products') return state.productRow ? [state.productRow] : [];
    if (name === 'pms_bui_wenlv_characters') return state.characters;
    if (name === 'pms_bui_wenlv_product_snapshots') return state.snapshotRows;
    return []; // collectibles/rewards/tiers/npcs/venue_points/triggers 全空
  };

  // 终端既支持 .limit(1)（products/curRoom）、.orderBy()（tiers），也支持直接 await（thenable）。
  const terminal = (table: unknown) => {
    const t: any = {};
    t.limit = async () => topRows(table);
    t.orderBy = () => t;
    t.then = (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(topRows(table)).then(onFulfilled, onRejected);
    return t;
  };

  const selectChain = () => ({
    from: (table: unknown) => ({
      // venue_points 在图闸里无 where 直接 await；其余走 where。
      ...terminal(table),
      where: () => terminal(table),
    }),
  });

  const updateChain = (table: unknown) => ({
    set: (payload: any) => {
      const name = tableName(table);
      if (name === 'pms_bui_wenlv_products') state.productUpdates.push(payload);
      if (name === 'pms_bui_wenlv_script_rooms') state.roomUpdates.push(payload);
      return {
        where: () => {
          const w: any = {};
          w.returning = async () => [{ ...state.productRow, ...payload }];
          w.then = (onFulfilled: any, onRejected?: any) =>
            Promise.resolve([{ ...state.productRow, ...payload }]).then(onFulfilled, onRejected);
          return w;
        },
      };
    },
  });

  // 回滚事务内的假 tx：select 按当前 room 层级返回 id，delete/insert/update 留痕。
  const txTerminal = (table: unknown) => {
    const t: any = {};
    t.limit = async () => {
      const name = tableName(table);
      if (name === 'pms_bui_wenlv_script_rooms') return state.curRoom ? [{ id: state.curRoom.id }] : [];
      return [];
    };
    t.then = (onFulfilled: any, onRejected?: any) => {
      const name = tableName(table);
      let rows: any[] = [];
      if (name === 'pms_bui_wenlv_chapters') rows = state.curChapterIds.map((id) => ({ id }));
      if (name === 'pms_bui_wenlv_scenes') rows = state.curSceneIds.map((id) => ({ id }));
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    };
    return t;
  };
  const tx = {
    select: () => ({ from: (table: unknown) => ({ where: () => txTerminal(table) }) }),
    delete: (table: unknown) => ({
      where: () => {
        state.txDeletes.push(tableName(table));
        const w: any = {};
        w.then = (onFulfilled: any, onRejected?: any) => Promise.resolve([]).then(onFulfilled, onRejected);
        return w;
      },
    }),
    insert: (table: unknown) => ({
      values: async (rows: any) => {
        state.txInserts.push({ table: tableName(table), rows: Array.isArray(rows) ? rows : [rows] });
      },
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: () => {
          state.txUpdates.push({ table: tableName(table), set: payload });
          const w: any = {};
          w.then = (onFulfilled: any, onRejected?: any) => Promise.resolve([{}]).then(onFulfilled, onRejected);
          return w;
        },
      }),
    }),
  };

  const db = {
    select: selectChain,
    insert: (table: unknown) => ({
      values: (rows: any) => {
        state.snapshotInserts.push({ table: tableName(table), rows: Array.isArray(rows) ? rows : [rows] });
        return { onConflictDoNothing: async () => ({}) };
      },
    }),
    update: updateChain,
    transaction: async (cb: any) => cb(tx),
  };
  return { db };
});

import route from '../wenlv.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const post = (path: string, body?: unknown) =>
  route.request(path, { method: 'POST', headers: H, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

const draftProduct = () => ({
  id: 'p1', name: '测试剧本', mode: 'narrative', status: 'preview',
  publishedVersion: 0, venueId: null, publishedAt: null,
});
const character = () => ({
  id: 'c1', name: '主角', faction: '正派', identity: '侠客',
  vitality: 50, wisdom: 50, insight: 50, skills: [],
});
// 一个合法 narrative 规范图投影：单场景（入口）+ 一个 ending 场景结局。
const legalRuntime = () => ({
  graph: {
    room: { id: 'room1', contentId: 'p1', name: '房', status: 'draft', publishedAt: null },
    chapters: [{ id: 'ch1', scriptRoomId: 'room1', title: '第一章', order: 0 }],
    scenes: [
      { id: 's1', chapterId: 'ch1', title: '开端', type: 'narrative', grants: [], npcLineIds: [], atoms: [], arAssetUrls: {}, sanDelta: 0, priority: 0 },
      { id: 'e1', chapterId: 'ch1', title: '终局', type: 'ending', content: '终', triggerCondition: { type: 'all', conditions: [] }, grants: [], npcLineIds: [], atoms: [], arAssetUrls: {}, sanDelta: 0, priority: 0 },
    ],
    flows: [],
    npcs: [],
  },
  nodes: [{
    id: 's1', productId: 'p1', nodeType: 'scene', legacyNodeType: 'scene', title: '开端',
    storyText: null, requires: null, geo: null, mapX: null, mapY: null, image: null, narrationUrl: null,
    venuePointId: null, grants: [], puzzle: null, atoms: null, order: 0, npcId: null, npcLineIds: [],
    perspectiveCharacterId: null, chapterGoal: null, openingLine: null, sanDelta: 0,
    arAssetUrl: null, arAssetUrls: {}, arDialogue: null, createdAt: new Date(), updatedAt: new Date(),
  }],
  edges: [],
  endings: [{ id: 'e1', title: '终局', text: '终', image: null, rewardId: null, priority: 0, triggerCondition: { type: 'all', conditions: [] } }],
});

beforeEach(() => {
  state.productRow = draftProduct();
  state.characters = [];
  state.runtime = { graph: null, nodes: [], edges: [], endings: [] };
  state.snapshotRows = [];
  state.curRoom = { id: 'room1' };
  state.curChapterIds = ['ch1'];
  state.curSceneIds = ['s1', 'e1'];
  state.productUpdates = [];
  state.roomUpdates = [];
  state.snapshotInserts = [];
  state.txDeletes = [];
  state.txInserts = [];
  state.txUpdates = [];
});

describe('POST /products/:id/publish（0079 规范图发布闸）', () => {
  it('TR-8.3 空气包（无 room/scene）⇒ 409，不置 live、不落快照', async () => {
    const res = post('/products/p1/publish');
    const r = await res;
    expect(r.status).toBe(409);
    const b = await r.json();
    expect(Array.isArray(b.errors)).toBe(true);
    expect(b.errors.length).toBeGreaterThan(0);
    expect(state.productUpdates).toHaveLength(0);
    expect(state.roomUpdates).toHaveLength(0);
    expect(state.snapshotInserts).toHaveLength(0);
  });

  it('TR-8.1 合规规范图 ⇒ 200、写四表快照、room/product 双挂牌', async () => {
    state.characters = [character()];
    state.runtime = legalRuntime();
    const r = await post('/products/p1/publish');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.data.status).toBe('published');
    expect(b.data.publishedVersion).toBe(1);

    expect(state.productUpdates[0]).toMatchObject({ status: 'published', publishedVersion: 1 });
    expect(state.roomUpdates[0]).toMatchObject({ status: 'published' });

    expect(state.snapshotInserts).toHaveLength(1);
    const data = state.snapshotInserts[0].rows[0].snapshotData;
    expect(data.scriptGraph).toBeTruthy();
    expect(data.scriptGraph.room.id).toBe('room1');
    expect(data.scriptGraph.chapters).toHaveLength(1);
    // 结局是 type='ending' 的场景，随 scenes 一起入快照（不再单列 endings）。
    expect(data.scriptGraph.scenes.map((s: any) => s.id).sort()).toEqual(['e1', 's1']);
    expect(data.scriptGraph.scenes.find((s: any) => s.id === 'e1').type).toBe('ending');
    expect(data.scriptGraph.flows).toEqual([]);
  });
});

describe('POST /products/:id/snapshots/:version/rollback（0079 四表还原）', () => {
  it('TR-8.2 删 flows→scenes→chapters 后按快照重建，room 回 draft / product 回 preview', async () => {
    state.snapshotRows = [{
      id: 'SNAP_p1_1', productId: 'p1', version: 1,
      snapshotData: {
        product: { id: 'p1', name: '测试剧本', mode: 'narrative', status: 'published', publishedVersion: 1 },
        scriptGraph: {
          room: { id: 'room1', contentId: 'p1', name: '房', mode: 'standard', config: {} },
          chapters: [{ id: 'ch1', scriptRoomId: 'room1', title: '第一章', order: 0 }],
          scenes: [
            { id: 's1', chapterId: 'ch1', title: '开端', type: 'narrative', grants: [], npcLineIds: [], atoms: [], arAssetUrls: {}, sanDelta: 0, priority: 0 },
            { id: 'e1', chapterId: 'ch1', title: '终局', type: 'ending', triggerCondition: { type: 'all', conditions: [] }, grants: [], npcLineIds: [], atoms: [], arAssetUrls: {}, sanDelta: 0, priority: 0 },
          ],
          flows: [{ id: 'f1', fromSceneId: 's1', toSceneId: 'e1', type: 'auto', condition: null, grants: [], sanDelta: 0, sortOrder: 0 }],
        },
        collectibles: [], characters: [], npcs: [], rewards: [], tiers: [],
      },
    }];

    const r = await post('/products/p1/snapshots/1/rollback');
    expect(r.status).toBe(200);

    // 删除顺序：flows 先于 scenes，scenes 先于 chapters。
    const idx = (t: string) => state.txDeletes.indexOf(t);
    expect(idx('pms_bui_wenlv_flows')).toBeGreaterThanOrEqual(0);
    expect(idx('pms_bui_wenlv_flows')).toBeLessThan(idx('pms_bui_wenlv_scenes'));
    expect(idx('pms_bui_wenlv_scenes')).toBeLessThan(idx('pms_bui_wenlv_chapters'));

    const inserted = (t: string) => state.txInserts.find((x) => x.table === t);
    expect(inserted('pms_bui_wenlv_chapters')?.rows).toHaveLength(1);
    expect(inserted('pms_bui_wenlv_scenes')?.rows.map((s) => s.id).sort()).toEqual(['e1', 's1']);
    expect(inserted('pms_bui_wenlv_scenes')?.rows.find((s) => s.id === 'e1').type).toBe('ending');
    expect(inserted('pms_bui_wenlv_flows')?.rows).toHaveLength(1);

    const roomUpd = state.txUpdates.find((u) => u.table === 'pms_bui_wenlv_script_rooms');
    expect(roomUpd?.set.status).toBe('draft');
    const prodUpd = state.txUpdates.find((u) => u.table === 'pms_bui_wenlv_products');
    expect(prodUpd?.set.status).toBe('preview');
    expect(prodUpd?.set.publishedVersion).toBe(1);
  });

  it('快照不存在 ⇒ 404', async () => {
    state.snapshotRows = [];
    const r = await post('/products/p1/snapshots/9/rollback');
    expect(r.status).toBe(404);
  });
});
