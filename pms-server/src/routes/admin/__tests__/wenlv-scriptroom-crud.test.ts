// 0079 统一重建 · admin 规范图 CRUD（纯假库，本机无 PG 可绿）。
// 钉 Task 9：
//   TR-9.1 scenes/flows 全量字段可写；zod 拒绝非法 type / 非法（含递归非法）condition；
//           删章/删场景级联删 flows 顺序正确；
//   TR-9.2 结局（type='ending' 的 scene）列表/创建可用、跨房挂章 400；trigger 支持 sceneId；
//           商户可挂 scriptRoomId（房不存在 400，置 null 解绑）。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  productRows: [] as any[],
  venueRows: [] as any[],
  roomRows: [] as any[],
  chapterRows: [] as any[],
  sceneRows: [] as any[],
  inserts: [] as { table: string; row: any }[],
  updates: [] as { table: string; set: any }[],
  deleteSeq: [] as string[],
}));

vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';

  const rowsFor = (table: unknown): any[] => {
    switch (tableName(table)) {
      case 'pms_bui_wenlv_products': return state.productRows;
      case 'pms_bui_wenlv_venues': return state.venueRows;
      case 'pms_bui_wenlv_script_rooms': return state.roomRows;
      case 'pms_bui_wenlv_chapters': return state.chapterRows;
      case 'pms_bui_wenlv_scenes': return state.sceneRows;
      default: return []; // merchant/triggers 的幂等存在性检查默认空
    }
  };

  // 终端同时支持 .limit(1) / .orderBy() / 直接 await（thenable）。
  const terminal = (table: unknown) => {
    const t: any = {};
    t.limit = async () => rowsFor(table);
    t.orderBy = () => t;
    t.then = (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(rowsFor(table)).then(onFulfilled, onRejected);
    return t;
  };

  const db: any = {
    select: () => ({
      from: (table: unknown) => ({
        where: () => terminal(table),
        orderBy: () => terminal(table),
        ...terminal(table),
      }),
    }),
    insert: (table: unknown) => ({
      values: (rows: any) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        for (const row of arr) state.inserts.push({ table: tableName(table), row });
        return {
          returning: async () => arr,
          onConflictDoNothing: async () => ({}),
        };
      },
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: () => {
          state.updates.push({ table: tableName(table), set: payload });
          const w: any = {};
          w.returning = async () => [{ id: 'x', ...payload }];
          w.then = (onFulfilled: any, onRejected?: any) =>
            Promise.resolve([{ id: 'x', ...payload }]).then(onFulfilled, onRejected);
          return w;
        },
      }),
    }),
    delete: (table: unknown) => ({
      where: () => {
        state.deleteSeq.push(tableName(table));
        const w: any = {};
        w.returning = async () => [{ id: 'id' }];
        w.then = (onFulfilled: any, onRejected?: any) =>
          Promise.resolve([]).then(onFulfilled, onRejected);
        return w;
      },
    }),
    transaction: async (cb: any) => cb(db),
  };
  return { db };
});

import route from '../wenlv.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const req = (method: string, path: string, body?: unknown) =>
  route.request(path, {
    method,
    headers: H,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const post = (p: string, b?: unknown) => req('POST', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);
const del = (p: string) => req('DELETE', p);

const inserted = (table: string) => state.inserts.filter((x) => x.table === table);

beforeEach(() => {
  state.productRows = [{ id: 'p1', name: '剧本', status: 'draft' }];
  state.venueRows = [{ id: 'v1', name: '场地' }];
  state.roomRows = [{ id: 'room1', name: '房' }];
  state.chapterRows = [{ id: 'ch1', scriptRoomId: 'room1' }];
  state.sceneRows = [];
  state.inserts = [];
  state.updates = [];
  state.deleteSeq = [];
});

describe('TR-9.1 scenes/flows 全量字段 + 结构化 condition 校验', () => {
  it('scene 全量玩法字段（含合法 requires/triggerCondition）落库', async () => {
    const r = await post('/chapters/ch1/scenes', {
      title: '谜题场', type: 'puzzle', venuePointId: 'pt1', grants: ['k1'],
      requires: { type: 'ref', ref: { kind: 'collected', id: 'k1' } },
      triggerCondition: { type: 'any', conditions: [{ type: 'role', characterId: 'c1' }] },
      priority: 5, sanDelta: -10, perspectiveCharacterId: 'c1',
    });
    expect(r.status).toBe(200);
    const row = inserted('pms_bui_wenlv_scenes')[0].row;
    expect(row).toMatchObject({
      chapterId: 'ch1', title: '谜题场', type: 'puzzle', venuePointId: 'pt1',
      grants: ['k1'], priority: 5, sanDelta: -10, perspectiveCharacterId: 'c1',
    });
    expect(row.requires).toEqual({ type: 'ref', ref: { kind: 'collected', id: 'k1' } });
  });

  it('非法 scene type ⇒ 400 且不落库', async () => {
    const r = await post('/chapters/ch1/scenes', { title: 'x', type: 'nope' });
    expect(r.status).toBe(400);
    expect(inserted('pms_bui_wenlv_scenes')).toHaveLength(0);
  });

  it('非法 requires 条件（未知 type / ref 缺 id / nofM 负数）⇒ 400', async () => {
    const r1 = await post('/chapters/ch1/scenes', { title: 'x', requires: { type: 'weird' } });
    expect(r1.status).toBe(400);
    const r2 = await post('/chapters/ch1/scenes', {
      title: 'x', requires: { type: 'ref', ref: { kind: 'collected' } },
    });
    expect(r2.status).toBe(400);
    const r3 = await post('/chapters/ch1/scenes', {
      title: 'x', triggerCondition: { type: 'nofM', n: -1, of: [] },
    });
    expect(r3.status).toBe(400);
    expect(inserted('pms_bui_wenlv_scenes')).toHaveLength(0);
  });

  it('嵌套非法条件（all.conditions[0] 坏）⇒ 400；深度递归合法条件 ⇒ 200', async () => {
    const bad = await post('/chapters/ch1/scenes', {
      title: 'x',
      requires: { type: 'all', conditions: [{ type: 'all', conditions: [{ type: 'bogus' }] }] },
    });
    expect(bad.status).toBe(400);
    const good = await post('/chapters/ch1/scenes', {
      title: 'x',
      requires: {
        type: 'all',
        conditions: [
          { type: 'ref', ref: { kind: 'visited', id: 's1' } },
          { type: 'nofM', n: 2, of: [
            { type: 'ref', ref: { kind: 'collected', id: 'a' } },
            { type: 'role', characterId: 'c1' },
          ] },
        ],
      },
    });
    expect(good.status).toBe(200);
  });

  it('flow 四型 + 结构化 condition：合法 200，非法 condition 400', async () => {
    const ok = await post('/flows', {
      fromSceneId: 's1', toSceneId: 's2', type: 'choice', choiceText: '走这边',
      condition: { type: 'all', conditions: [{ type: 'ref', ref: { kind: 'skill', id: 'unlock' } }] },
      grants: ['k2'], sanDelta: 0, sortOrder: 1,
    });
    expect(ok.status).toBe(200);
    expect(inserted('pms_bui_wenlv_flows')[0].row).toMatchObject({
      fromSceneId: 's1', toSceneId: 's2', type: 'choice', grants: ['k2'],
    });

    const badType = await post('/flows', { fromSceneId: 's1', toSceneId: 's2', type: 'teleport' });
    expect(badType.status).toBe(400);
    const badCond = await post('/flows', { fromSceneId: 's1', toSceneId: 's2', condition: { type: 'nope' } });
    expect(badCond.status).toBe(400);
    expect(inserted('pms_bui_wenlv_flows')).toHaveLength(1);
  });

  it('删章节级联 flows→scenes→chapters；删场景级联 flows→scenes', async () => {
    state.sceneRows = [{ id: 'sx' }];
    const rc = await del('/chapters/ch1');
    expect(rc.status).toBe(200);
    const idx = (t: string) => state.deleteSeq.indexOf(t);
    expect(idx('pms_bui_wenlv_flows')).toBeLessThan(idx('pms_bui_wenlv_scenes'));
    expect(idx('pms_bui_wenlv_scenes')).toBeLessThan(idx('pms_bui_wenlv_chapters'));

    state.deleteSeq = [];
    const rs = await del('/scenes/sx');
    expect(rs.status).toBe(200);
    expect(state.deleteSeq).toEqual(['pms_bui_wenlv_flows', 'pms_bui_wenlv_scenes']);
  });

  it('剧本房详情一次返回 room/chapters/scenesByChapter/flows', async () => {
    const r = await req('GET', '/script-rooms/room1');
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.data.room.id).toBe('room1');
    expect(Array.isArray(b.data.flows)).toBe(true);
  });
});

describe('TR-9.2 结局（type=ending 场景）与 trigger(sceneId) / 商户挂房', () => {
  it('结局创建落成 type=ending 场景，缺省条件为空 all；列表可读', async () => {
    const r = await post('/script-rooms/room1/endings', {
      chapterId: 'ch1', title: '好结局', content: '圆满', priority: 9, rewardId: 'rw1',
    });
    expect(r.status).toBe(200);
    const row = inserted('pms_bui_wenlv_scenes')[0].row;
    expect(row).toMatchObject({
      chapterId: 'ch1', title: '好结局', type: 'ending',
      content: '圆满', priority: 9, rewardId: 'rw1',
    });
    expect(row.triggerCondition).toEqual({ type: 'all', conditions: [] });

    state.sceneRows = [{ id: 'e1', chapterId: 'ch1', title: '好结局', type: 'ending' }];
    const list = await req('GET', '/script-rooms/room1/endings');
    expect(list.status).toBe(200);
    const b = await list.json();
    expect(b.data.endings[0].id).toBe('e1');
  });

  it('结局携带自定义 triggerCondition 落库；章节不属于该房 ⇒ 400', async () => {
    const ok = await post('/script-rooms/room1/endings', {
      chapterId: 'ch1', title: '坏结局',
      triggerCondition: { type: 'ref', ref: { kind: 'collected', id: 'evil_key' } },
    });
    expect(ok.status).toBe(200);
    expect(inserted('pms_bui_wenlv_scenes')[0].row.triggerCondition)
      .toEqual({ type: 'ref', ref: { kind: 'collected', id: 'evil_key' } });

    state.inserts = [];
    state.chapterRows = []; // 章节不属于任何房
    const bad = await post('/script-rooms/room1/endings', { chapterId: 'ch9', title: '串房结局' });
    expect(bad.status).toBe(400);
    expect(inserted('pms_bui_wenlv_scenes')).toHaveLength(0);
  });

  it('trigger 创建/改 支持 sceneId（nodeId 过渡列并存）；非法 type 400', async () => {
    const r = await post('/products/p1/triggers', { type: 'qr', sceneId: 's1' });
    expect(r.status).toBe(200);
    expect(inserted('pms_bui_wenlv_triggers')[0].row).toMatchObject({
      type: 'qr', sceneId: 's1', nodeId: null,
    });
    const badType = await post('/products/p1/triggers', { type: 'nfc' });
    expect(badType.status).toBe(400);

    const pr = await patch('/triggers/tg1', { sceneId: 's2', nodeId: null });
    expect(pr.status).toBe(200);
    expect(state.updates.find((u) => u.table === 'pms_bui_wenlv_triggers')?.set)
      .toMatchObject({ sceneId: 's2', nodeId: null });
  });

  it('商户创建/改可挂 scriptRoomId；房不存在 ⇒ 400 且不写', async () => {
    const r = await post('/venues/v1/merchants', { name: '暗号餐馆', scriptRoomId: 'room1' });
    expect(r.status).toBe(200);
    expect(inserted('pms_bui_wenlv_merchant_partners')[0].row)
      .toMatchObject({ venueId: 'v1', scriptRoomId: 'room1' });

    state.inserts = [];
    state.roomRows = [];
    const bad = await post('/venues/v1/merchants', { name: '黑店', scriptRoomId: 'nope' });
    expect(bad.status).toBe(400);
    expect(inserted('pms_bui_wenlv_merchant_partners')).toHaveLength(0);

    // PATCH 绑不存在的房 ⇒ 400，不触发 update；置 null 解绑放行。
    const badPatch = await patch('/merchants/m1', { scriptRoomId: 'ghost' });
    expect(badPatch.status).toBe(400);
    expect(state.updates.filter((u) => u.table === 'pms_bui_wenlv_merchant_partners')).toHaveLength(0);

    state.roomRows = [{ id: 'room2' }];
    const unbind = await patch('/merchants/m1', { scriptRoomId: null });
    expect(unbind.status).toBe(200);
    expect(state.updates.find((u) => u.table === 'pms_bui_wenlv_merchant_partners')?.set)
      .toMatchObject({ scriptRoomId: null });
  });
});
