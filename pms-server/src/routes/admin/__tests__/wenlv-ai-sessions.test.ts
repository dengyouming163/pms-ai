// 0079 AI 协作 DIY 会话（纯假库，本机无 PG 可绿）。
// 钉 Task 11：
//   TR-11.1 会话可创建/中断/跨请求恢复（room+user 幂等）；草案只写 draftSnapshots，
//           只有 adopt 事务写 config/npcs/chapters/scenes/flows（结局随 type='ending' 场景）；
//           非 active 拒写；跨房/跨章 400；采纳后可推进 stage。
//   TR-11.2 X-Internal-Service-Token 缺失 ⇒ 403。
import { describe, it, expect, beforeEach, vi } from 'vitest';

const state = vi.hoisted(() => ({
  sessions: [] as any[],
  rooms: [] as any[],
  chapters: [] as any[],
  anchor: { venues: [] as any[], profiles: [] as any[], merchants: [] as any[], points: [] as any[] },
  // 非事务 update（会话类）与事务内 upsert/update 分开留痕。
  updates: [] as { table: string; set: any }[],
  upserts: [] as { table: string; rows: any[] }[],
  txUpdates: [] as { table: string; set: any }[],
}));

vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';

  const rawRows = (table: unknown): any[] => {
    switch (tableName(table)) {
      case 'pms_bui_wenlv_ai_sessions': return state.sessions;
      case 'pms_bui_wenlv_script_rooms': return state.rooms;
      case 'pms_bui_wenlv_chapters': return state.chapters;
      case 'pms_bui_wenlv_venues': return state.anchor.venues;
      case 'pms_bui_wenlv_venue_profiles': return state.anchor.profiles;
      case 'pms_bui_wenlv_merchant_partners': return state.anchor.merchants;
      case 'pms_bui_wenlv_venue_points': return state.anchor.points;
      default: return [];
    }
  };

  // 最小条件解析：遍历 drizzle SQL.queryChunks 抠 Param.value（已探针验证），
  // 按行内任一字段值命中过滤（足以区分 getById('nope')→[] 与 room+user+status 复合 where）。
  const extractParams = (cond: any, depth = 0): unknown[] => {
    const out: unknown[] = [];
    for (const ch of cond?.queryChunks ?? []) {
      if (ch && typeof ch === 'object') {
        if (ch.constructor?.name === 'Param' || ('value' in ch && 'encoder' in ch)) out.push(ch.value);
        else if (Array.isArray(ch.queryChunks) && depth < 6) out.push(...extractParams(ch, depth + 1));
      }
    }
    return out;
  };
  const rowsFor = (table: unknown, params: unknown[] = []): any[] => {
    const rows = rawRows(table);
    if (params.length === 0) return rows;
    return rows.filter((r) =>
      Object.values(r).some((v) => (typeof v === 'string' || typeof v === 'number') && params.includes(v)));
  };

  const terminal = (table: unknown, params: unknown[] = []) => {
    const t: any = {};
    t.limit = async () => rowsFor(table, params);
    t.orderBy = () => t;
    t.then = (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(rowsFor(table, params)).then(onFulfilled, onRejected);
    return t;
  };

  const select = () => ({
    from: (table: unknown) => ({
      where: (cond?: unknown) => terminal(table, extractParams(cond)),
      orderBy: () => terminal(table),
      ...terminal(table),
    }),
  });

  const applyInsert = (table: unknown, rows: any[]) => {
    if (tableName(table) === 'pms_bui_wenlv_ai_sessions') state.sessions = rows;
  };

  // 非事务 insert：会话新建走 .returning()；四表写只在事务内（onConflictDoUpdate）。
  const insert = (table: unknown) => ({
    values: (rows: any) => {
      const arr = Array.isArray(rows) ? rows : [rows];
      applyInsert(table, arr);
      return {
        returning: async () => arr,
      };
    },
  });

  // 非事务 update（会话 stage/status/intent/transcript/draftSnapshots）：回写内存行。
  const update = (table: unknown) => ({
    set: (payload: any) => ({
      where: () => {
        state.updates.push({ table: tableName(table), set: payload });
        if (tableName(table) === 'pms_bui_wenlv_ai_sessions' && state.sessions[0]) {
          Object.assign(state.sessions[0], payload);
        }
        const w: any = {};
        w.returning = async () => [state.sessions[0] ? { ...state.sessions[0] } : { ...payload }];
        w.then = (onFulfilled: any, onRejected?: any) =>
          Promise.resolve([]).then(onFulfilled, onRejected);
        return w;
      },
    }),
  });

  // 采纳事务：四表 upsert + room/session update（假 tx 不模拟回滚；跨房/跨章 400 用例不断言写入数）。
  const tx = {
    select,
    insert: (table: unknown) => ({
      values: (rows: any) => {
        const arr = Array.isArray(rows) ? rows : [rows];
        state.upserts.push({ table: tableName(table), rows: arr });
        return { onConflictDoUpdate: async () => ({}) };
      },
    }),
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: () => {
          state.txUpdates.push({ table: tableName(table), set: payload });
          const w: any = {};
          w.then = (onFulfilled: any, onRejected?: any) =>
            Promise.resolve([]).then(onFulfilled, onRejected);
          return w;
        },
      }),
    }),
  };

  const db: any = { select, insert, update, transaction: async (cb: any) => cb(tx) };
  return { db };
});

import route from '../wenlv-ai-sessions.js';

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const req = (method: string, path: string, body?: unknown, headers: Record<string, string> = H) =>
  route.request(path, {
    method,
    headers,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const get = (p: string) => req('GET', p);
const post = (p: string, b?: unknown) => req('POST', p, b);
const put = (p: string, b?: unknown) => req('PUT', p, b);
const patch = (p: string, b?: unknown) => req('PATCH', p, b);

const seedSession = (over: any = {}) => ({
  id: 'a1', scriptRoomId: 'room1', userId: 'u1', stage: 'intent', status: 'active',
  intent: null,
  transcript: [{ role: 'user', content: '想做个悬疑本', stage: 'intent' }],
  draftSnapshots: {},
  createdAt: new Date(), updatedAt: new Date(),
  ...over,
});
const seedRoom = (over: any = {}) => ({
  id: 'room1', contentId: 'p1', venueId: 'v1', name: '古巷谜案',
  mode: 'standard', difficulty: 'normal', config: {}, status: 'draft',
  ...over,
});

const upserted = (table: string) =>
  state.upserts.filter((x) => x.table === table).flatMap((x) => x.rows);

beforeEach(() => {
  state.sessions = [seedSession()];
  state.rooms = [seedRoom()];
  state.chapters = [{ id: 'ch1', scriptRoomId: 'room1' }];
  state.anchor = {
    venues: [{ id: 'v1', name: '老街场地' }],
    profiles: [{ id: 'vp1', venueId: 'v1', supportActions: { frontDesk: true }, deployableAtoms: ['observe'], routeRadiusM: 300, timeWindows: [] }],
    merchants: [{ id: 'm1', venueId: 'v1', scriptRoomId: null, name: '茶馆', cipherDish: '雨前' }],
    points: [{ id: 'pt1', venueId: 'v1', name: '门口石狮' }],
  };
  state.updates = [];
  state.upserts = [];
  state.txUpdates = [];
});

describe('TR-11.2 内部 token 鉴权', () => {
  it('无 token ⇒ 403；带 token 探针 200', async () => {
    const denied = get('/ping');
    const noTok = await req('GET', '/ping', undefined, { 'Content-Type': 'application/json' });
    expect(noTok.status).toBe(403);
    const ok = await get('/ping');
    expect(ok.status).toBe(200);
    void denied;
  });
});

describe('TR-11.1 会话生命周期：创建/恢复/草案/状态机', () => {
  it('新建会话 resumed=false；同 room+user 再请幂等 resumed=true 且不重复建行', async () => {
    state.sessions = [];
    const r1 = await post('/sessions', { scriptRoomId: 'room1', userId: 'u1', intent: { tone: '悬疑' } });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.data.resumed).toBe(false);
    expect(b1.data.session.stage).toBe('intent');

    const r2 = await post('/sessions', { scriptRoomId: 'room1', userId: 'u1' });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    expect(b2.data.resumed).toBe(true);
    expect(b2.data.session.id).toBe(b1.data.session.id);
    // 内存里始终只有一行（第二次走 findActive 分支，未再 insert）。
    expect(state.sessions).toHaveLength(1);
  });

  it('按 id 读 / 按 room+user 恢复活跃会话；无会话 404', async () => {
    const byId = await get('/sessions/a1');
    expect(byId.status).toBe(200);
    expect((await byId.json()).data.session.scriptRoomId).toBe('room1');
    expect((await get('/sessions/nope')).status).toBe(404);

    const active = await get('/rooms/room1/active-session?userId=u1');
    expect(active.status).toBe(200);
    state.sessions = [];
    expect((await get('/rooms/room1/active-session?userId=u1')).status).toBe(404);
  });

  it('草案分阶段落 draftSnapshots、可推进 stage、换版不覆盖其它阶段；四表零写入', async () => {
    const r1 = await put('/sessions/a1/drafts/worldview', { draft: { theme: '民国悬疑' }, advanceTo: 'worldview' });
    expect(r1.status).toBe(200);
    const b1 = await r1.json();
    expect(b1.data.stage).toBe('worldview');
    expect(b1.data.stages).toContain('worldview');

    const r2 = await put('/sessions/a1/drafts/characters', { draft: { npcs: [{ name: '掌柜' }] } });
    expect(r2.status).toBe(200);
    const b2 = await r2.json();
    // 换版只覆盖本 stage 键，世界观草案保留。
    expect(b2.data.stages.sort()).toEqual(['characters', 'worldview']);

    // 未采纳：四表与 room 一律没动。
    expect(state.upserts).toHaveLength(0);
    expect(state.txUpdates).toHaveLength(0);

    expect((await put('/sessions/a1/drafts/bogus', { draft: {} })).status).toBe(400);
  });

  it('追加 transcript；非法 body 400', async () => {
    const ok = await post('/sessions/a1/transcript', {
      entries: [{ role: 'assistant', content: '好的，加一段暗号', stage: 'intent' }],
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.transcriptLength).toBe(2);
    expect((await post('/sessions/a1/transcript', { entries: [] })).status).toBe(400);
  });

  it('置 completed 后再写草案/对话 ⇒ 409；PATCH 非法 status 400', async () => {
    const fin = await patch('/sessions/a1', { status: 'completed' });
    expect(fin.status).toBe(200);
    expect((await put('/sessions/a1/drafts/scenes', { draft: {} })).status).toBe(409);
    expect((await post('/sessions/a1/transcript', { entries: [{ role: 'user', content: 'x' }] })).status).toBe(409);
    expect((await patch('/sessions/a1', { status: 'weird' })).status).toBe(400);
  });
});

describe('TR-11.1 adopt 采纳事务落四表 + 步①锚定', () => {
  const adoptPayload = () => ({
    scriptRoomId: 'room1',
    worldview: { tone: '悬疑', era: '民国' },
    npcs: [{ id: 'n1', name: '茶馆掌柜', persona: { personality: ['谨慎'] } }],
    chapters: [{ id: 'ch1', title: '第一章 · 雨巷', goal: '找到接头人' }],
    scenes: [
      { id: 's1', chapterId: 'ch1', title: '巷口', type: 'narrative', grants: ['letter'] },
      { id: 'e1', chapterId: 'ch1', title: '真相', type: 'ending', triggerCondition: { type: 'all', conditions: [] } },
    ],
    flows: [{ id: 'f1', fromSceneId: 's1', toSceneId: 'e1', type: 'auto' }],
    advanceTo: 'publish',
  });

  it('采纳：worldview→room.config、角色→npcs(productId)、骨架→chapters、场景/结局→scenes、流转→flows，并推进 stage', async () => {
    const r = await post('/sessions/a1/adopt', adoptPayload());
    expect(r.status).toBe(200);
    const b = await r.json();
    expect(b.data.adopted).toMatchObject({
      worldview: true, npcs: ['n1'], chapters: ['ch1'], scenes: ['s1', 'e1'], flows: ['f1'],
    });

    // npcs 归属 room.contentId
    expect(upserted('pms_bui_wenlv_npcs')[0]).toMatchObject({ id: 'n1', productId: 'p1' });
    // 结局作为 type='ending' 的场景同通道落库
    const scenes = upserted('pms_bui_wenlv_scenes');
    expect(scenes.find((s) => s.id === 'e1')).toMatchObject({ chapterId: 'ch1', type: 'ending' });
    expect(scenes.find((s) => s.id === 's1')).toMatchObject({ grants: ['letter'], type: 'narrative' });
    expect(upserted('pms_bui_wenlv_flows')[0]).toMatchObject({ fromSceneId: 's1', toSceneId: 'e1' });

    // 世界观 merge 进 config.worldview（不抹 config 其它键）
    const roomUpd = state.txUpdates.find((u) => u.table === 'pms_bui_wenlv_script_rooms')!;
    expect(roomUpd.set.config).toMatchObject({ worldview: { tone: '悬疑', era: '民国' } });
    // 会话推进到 publish
    const sessUpd = state.txUpdates.find((u) => u.table === 'pms_bui_wenlv_ai_sessions')!;
    expect(sessUpd.set.stage).toBe('publish');
  });

  it('会话与剧本房不匹配 ⇒ 400（任何写入之前）；场景挂到外房章节 ⇒ 400', async () => {
    const mismatch = await post('/sessions/a1/adopt', { ...adoptPayload(), scriptRoomId: 'roomX' });
    expect(mismatch.status).toBe(400);
    expect(state.upserts).toHaveLength(0);
    expect(state.txUpdates).toHaveLength(0);

    const badChapter = await post('/sessions/a1/adopt', {
      scriptRoomId: 'room1',
      scenes: [{ id: 's9', chapterId: 'chOTHER', title: '串房场景' }],
    });
    expect(badChapter.status).toBe(400);
  });

  it('仅存草案不 adopt ⇒ 四表始终无写入（AI 提案/用户决策）', async () => {
    await put('/sessions/a1/drafts/skeleton', { draft: { chapters: [{ title: '脑中草案' }] } });
    await put('/sessions/a1/drafts/scenes', { draft: { scenes: [] } });
    expect(state.upserts).toHaveLength(0);
    expect(state.txUpdates).toHaveLength(0);
  });

  it('步①锚定上下文：返回场地能力档案 + 商户 + 点位；未绑场地空域；房不存在 404', async () => {
    const r = await get('/rooms/room1/anchor-context');
    expect(r.status).toBe(200);
    const d = (await r.json()).data;
    expect(d.venue.id).toBe('v1');
    expect(d.venueProfile.supportActions).toEqual({ frontDesk: true });
    expect(d.venueProfile.deployableAtoms).toContain('observe');
    expect(d.merchants[0].cipherDish).toBe('雨前');
    expect(d.venuePoints[0].id).toBe('pt1');

    state.rooms = [seedRoom({ venueId: null })];
    const unbound = await get('/rooms/room1/anchor-context');
    const ud = (await unbound.json()).data;
    expect(unbound.status).toBe(200);
    expect(ud.venue).toBeNull();
    expect(ud.merchants).toEqual([]);

    state.rooms = [];
    expect((await get('/rooms/room1/anchor-context')).status).toBe(404);
  });
});
