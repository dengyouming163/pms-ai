import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 假 db ─────────────────────────────────────────────────────────────────────
// scene_refine 入队 / refine-apply 采纳端点的轻量单测：不连库、不连 LLM。
// 0079 统一模型：nodeId = scene.id；旧 /products/:id/nodes/:nodeId/refine → /scenes/:id/refine。
// vi.mock 提升到 import 前，state 必须定义在工厂闭包里（每个 it 动态切换返回值）。
vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const state: {
    sceneRows: any[]; npcRows: any[]; jobRows: any[];
    inserted: { table: string; values: any } | null;
    txNpcInserts: { table: string; values: any }[];
    sceneUpdateSets: any[]; jobUpdateSets: any[];
    sceneUpdateRows: any[]; maxOrderRows: any[];
    propRows: any[]; propInserts: { table: string; values: any }[];
  } = {
    sceneRows: [],
    npcRows: [],
    jobRows: [],
    inserted: null,
    txNpcInserts: [],
    sceneUpdateSets: [],
    jobUpdateSets: [],
    sceneUpdateRows: [{ id: 'n1' }],
    maxOrderRows: [{ m: 2 }],
    propRows: [],
    propInserts: [],
  };

  // select(...).from(table).where(...).limit(1) —— 顶层查询按表名取 state 行；
  // getProductIdBySceneId 走 innerJoin 链，innerJoin 透传回 from 对象，最终 where 仍按 scenes 表取 sceneRows。
  const makeWhere = (table: unknown) => {
    const w: any = {
      limit: async () => {
        const name = tableName(table);
        if (name === 'pms_bui_wenlv_scenes') return state.sceneRows;
        if (name === 'pms_bui_wenlv_npc_jobs') return state.jobRows;
        if (name === 'pms_bui_wenlv_npcs') return state.npcRows;
        if (name === 'pms_bui_wenlv_props') return state.propRows;
        return [];
      },
    };
    // 事务内 MAX(orderId) 聚簇查询没有 .limit()，直接 await 时按 NPC 表返回聚簇行。
    w.then = (onFulfilled: any, onRejected?: any) => {
      const name = tableName(table);
      const rows = name === 'pms_bui_wenlv_npcs' ? state.maxOrderRows : [];
      return Promise.resolve(rows).then(onFulfilled, onRejected);
    };
    return w;
  };
  const selectChain = () => {
    const fromObj: any = {
      from: (table: unknown) => {
        const whereObj: any = { where: () => makeWhere(table) };
        // innerJoin 透传：不解析 join 条件，直接返回同一个 from 对象（where 仍按主表取行）。
        whereObj.innerJoin = () => fromObj.from(table);
        return whereObj;
      },
    };
    return fromObj;
  };

  // update(table).set(payload).where(...).returning() —— set 时即按表留痕；
  // job 幂等回写没有 returning，直接 await where 结果（thenable）。
  const updateChain = (table: unknown) => ({
    set: (payload: any) => {
      const name = tableName(table);
      if (name === 'pms_bui_wenlv_scenes') state.sceneUpdateSets.push(payload);
      if (name === 'pms_bui_wenlv_npc_jobs') state.jobUpdateSets.push(payload);
      return {
        where: () => {
          const w: any = {
            returning: async () => (name === 'pms_bui_wenlv_scenes' ? state.sceneUpdateRows : [{ id: 'job1' }]),
          };
          w.then = (onFulfilled: any, onRejected?: any) => Promise.resolve([{ id: 'x' }]).then(onFulfilled, onRejected);
          return w;
        },
      };
    },
  });

  const tx = {
    select: selectChain,
    insert: (table: unknown) => ({
      values: async (v: any) => {
        const name = tableName(table);
        if (name === 'pms_bui_wenlv_props') state.propInserts.push({ table: name, values: v });
        else state.txNpcInserts.push({ table: name, values: v });
      },
    }),
    update: updateChain,
  };

  const db = {
    select: selectChain,
    // 入队端点 await insert(...).values(v) 后即返回，不链 returning。
    insert: (table: unknown) => ({
      values: async (v: any) => {
        state.inserted = { table: tableName(table), values: v };
      },
    }),
    update: updateChain,
    transaction: async (cb: any) => cb(tx),
  };
  return { db, state };
});

import adminWenlvRoute from '../wenlv.js';
import * as fakeDbModule from '../../../db/index.js';

const fake = fakeDbModule as unknown as {
  state: {
    sceneRows: any[]; npcRows: any[]; jobRows: any[];
    inserted: { table: string; values: any } | null;
    txNpcInserts: { table: string; values: any }[];
    sceneUpdateSets: any[]; jobUpdateSets: any[];
    sceneUpdateRows: any[]; maxOrderRows: any[];
    propRows: any[]; propInserts: { table: string; values: any }[];
  };
};

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const post = (path: string, body?: unknown) =>
  adminWenlvRoute.request(path, {
    method: 'POST',
    headers: H,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// scene→npc 转型 + 新建 NPC 的成功草稿
const refineDraft = {
  targetType: 'npc',
  title: '新标题',
  storyText: '新文本',
  puzzle: null,
  grants: [],
  requires: null,
  chapterGoal: { type: 'reveal', description: 'd', answerCriteria: [], minTurns: 2 },
  openingLine: '你来了',
  arDialogue: null,
  npcId: null,
  newNpc: {
    name: '老周',
    persona: { personality: ['稳'], tone: '低', catchphrases: [], backstory: '', clues: [], taboos: [] },
  },
  notes: '',
};

const makeJob = (overrides: any = {}) => ({
  id: 'task1', productId: 'p1', nodeId: 'n1', type: 'node_refine', status: 'succeeded',
  result: { refine: refineDraft }, createdAt: new Date(), updatedAt: new Date(),
  ...overrides,
});

describe('POST /scenes/:id/refine（node_refine 入队）', () => {
  beforeEach(() => {
    fake.state.sceneRows = [{ id: 'n1', productId: 'p1', type: 'narrative' }];
    fake.state.npcRows = [];
    fake.state.jobRows = [];
    fake.state.inserted = null;
    fake.state.txNpcInserts = [];
    fake.state.sceneUpdateSets = [];
    fake.state.jobUpdateSets = [];
    fake.state.sceneUpdateRows = [{ id: 'n1' }];
    fake.state.maxOrderRows = [{ m: 2 }];
    fake.state.propRows = [];
    fake.state.propInserts = [];
  });

  it('成功入队：values 落 type=node_refine/status=pending，result.targetType 透传，返回 taskId', async () => {
    const res = await post('/scenes/n1/refine', { targetType: 'npc' });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.taskId).toBe('string');
    expect(body.data.taskId).toBeTruthy();

    expect(fake.state.inserted).not.toBeNull();
    const { table, values } = fake.state.inserted!;
    expect(table).toBe('pms_bui_wenlv_npc_jobs');
    expect(values.id).toBe(body.data.taskId);
    expect(values.productId).toBe('p1');
    expect(values.nodeId).toBe('n1');
    expect(values.targetType).toBe('node');
    expect(values.targetId).toBe('n1');
    expect(values.type).toBe('node_refine');
    expect(values.status).toBe('pending');
    expect(values.result.targetType).toBe('npc');
    expect(values.result.linkNpcId).toBeNull();
  });

  it('body 缺省时 targetType 默认 keep，linkNpcId 缺省为 null', async () => {
    const res = await post('/scenes/n1/refine', {});
    expect(res.status).toBe(200);
    expect(fake.state.inserted!.values.result).toEqual({ targetType: 'keep', linkNpcId: null });
  });

  it('targetType 非法 → 400，且不写 npc_jobs', async () => {
    const res = await post('/scenes/n1/refine', { targetType: 'boss' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('targetType');
    expect(fake.state.inserted).toBeNull();
  });

  it('场景不存在 → 404，且不写 npc_jobs', async () => {
    fake.state.sceneRows = [];
    const res = await post('/scenes/missing/refine', { targetType: 'keep' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toContain('节点不存在');
    expect(fake.state.inserted).toBeNull();
  });

  it('linkNpcId 指向不存在 / 他产品 NPC → 400，且不写 npc_jobs', async () => {
    fake.state.npcRows = []; // 查不到 = 不属于本产品
    const res = await post('/scenes/n1/refine', { targetType: 'npc', linkNpcId: 'npc-other' });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain('NPC');
    expect(fake.state.inserted).toBeNull();
  });
});

describe('POST /scenes/:id/refine-apply（采纳 node_refine 草稿）', () => {
  beforeEach(() => {
    fake.state.sceneRows = [{ id: 'n1', productId: 'p1', type: 'narrative' }];
    fake.state.npcRows = [];
    fake.state.jobRows = [makeJob()];
    fake.state.inserted = null;
    fake.state.txNpcInserts = [];
    fake.state.sceneUpdateSets = [];
    fake.state.jobUpdateSets = [];
    fake.state.sceneUpdateRows = [{ id: 'n1', type: 'npc' }];
    fake.state.maxOrderRows = [{ m: 2 }];
    fake.state.propRows = [];
    fake.state.propInserts = [];
  });

  const APPLY = '/scenes/n1/refine-apply';

  it('a) 成功（scene→npc 且 newNpc）：事务内建 NPC（orderId=MAX+1）、场景更新强制带类型耦合字段、job 置 applied', async () => {
    const res = await post(APPLY, { taskId: 'task1', fields: ['title'] });
    expect(res.status).toBe(200);
    expect((await res.json()).success).toBe(true);

    // 事务内新建 NPC：name/persona 来自草稿，orderId = MAX("order")(2) + 1
    expect(fake.state.txNpcInserts).toHaveLength(1);
    const npcInsert = fake.state.txNpcInserts[0];
    expect(npcInsert.table).toBe('pms_bui_wenlv_npcs');
    expect(npcInsert.values.id).toMatch(/^npc_/);
    expect(npcInsert.values.name).toBe('老周');
    expect(npcInsert.values.persona).toEqual(refineDraft.newNpc.persona);
    expect(npcInsert.values.orderId).toBe(3);

    // 场景更新：即便只勾 title，scene→npc 转型也强制 type/chapterGoal/openingLine/puzzle/npcId
    expect(fake.state.sceneUpdateSets).toHaveLength(1);
    const sceneSet = fake.state.sceneUpdateSets[0];
    expect(sceneSet.type).toBe('npc');
    expect(sceneSet.title).toBe('新标题');
    expect(sceneSet.chapterGoal).toEqual(refineDraft.chapterGoal);
    expect(sceneSet.openingLine).toBe('你来了');
    expect(sceneSet.puzzle).toBeNull();
    expect(sceneSet.npcId).toBe(npcInsert.values.id);
    expect('storyText' in sceneSet).toBe(false); // 未勾选的内容字段仍不写

    // job 同事务置 applied:true，且保留 result.refine
    expect(fake.state.jobUpdateSets).toHaveLength(1);
    const jobSet = fake.state.jobUpdateSets[0];
    expect(jobSet.result.applied).toBe(true);
    expect(jobSet.result.refine).toEqual(refineDraft);
    expect(jobSet.updatedAt).toBeInstanceOf(Date);
  });

  it('b) taskId 属于其他场景 → 404，不开事务', async () => {
    fake.state.jobRows = [makeJob({ nodeId: 'n-other' })];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('任务不存在');
    expect(fake.state.sceneUpdateSets).toHaveLength(0);
    expect(fake.state.txNpcInserts).toHaveLength(0);
  });

  it('c) status=pending → 409 任务未完成，不开事务', async () => {
    fake.state.jobRows = [makeJob({ status: 'pending' })];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('未完成');
    expect(fake.state.sceneUpdateSets).toHaveLength(0);
  });

  it('d) result 无 refine → 409，不开事务', async () => {
    fake.state.jobRows = [makeJob({ result: {} })];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('草稿');
    expect(fake.state.sceneUpdateSets).toHaveLength(0);
  });

  it('e) result.applied 已为真 → 409 幂等拦截，不开事务', async () => {
    fake.state.jobRows = [makeJob({ result: { refine: refineDraft, applied: true } })];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('已采纳');
    expect(fake.state.sceneUpdateSets).toHaveLength(0);
    expect(fake.state.txNpcInserts).toHaveLength(0);
    expect(fake.state.jobUpdateSets).toHaveLength(0);
  });

  it('f) update returning 空数组（场景被并发删除）→ 抛错走回滚路径，NPC 不落库', async () => {
    fake.state.sceneUpdateRows = [];
    let status = 200;
    let rejected = false;
    try {
      const res = await post(APPLY, { taskId: 'task1' });
      status = res.status;
    } catch {
      rejected = true;
    }
    expect(rejected || status === 500).toBe(true);
    expect(fake.state.sceneUpdateSets).toHaveLength(1);
    expect(fake.state.jobUpdateSets).toHaveLength(0);
  });

  it('g) NPC 草稿既无 npcId 也无 newNpc → 409 前置拦截，不进事务', async () => {
    fake.state.jobRows = [makeJob({
      result: { refine: { ...refineDraft, npcId: null, newNpc: null } },
    })];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('缺少绑定 NPC');
    expect(fake.state.txNpcInserts).toHaveLength(0);
    expect(fake.state.sceneUpdateSets).toHaveLength(0);
  });

  it('h) 场景事务前已不存在 → 404，不进事务', async () => {
    fake.state.sceneRows = [];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(404);
    expect((await res.json()).error).toBe('节点不存在');
    expect(fake.state.txNpcInserts).toHaveLength(0);
    expect(fake.state.sceneUpdateSets).toHaveLength(0);
  });

  // ===== props 自动登记（幂等：按 name+nodeId+productId 查重）=====
  const sceneDraftWithProps = {
    targetType: 'scene', title: '前台', storyText: '旧物包里塞着铜钥。', puzzle: null,
    grants: [], requires: null, chapterGoal: null, openingLine: null,
    arDialogue: null, npcId: null, newNpc: null, notes: '',
    props: [
      { name: '铜钥', kind: 'key', placeNote: '前台旧物包内' },
      { name: '家书', kind: 'letter', placeNote: '客房枕头下' },
    ],
  };

  it('i) draft.props 非空 → 事务内按 name 幂等登记道具', async () => {
    fake.state.jobRows = [makeJob({ result: { refine: sceneDraftWithProps } })];
    fake.state.sceneUpdateRows = [{ id: 'n1', type: 'scene' }];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(200);

    expect(fake.state.propInserts).toHaveLength(2);
    const [p1, p2] = fake.state.propInserts;
    expect(p1.table).toBe('pms_bui_wenlv_props');
    expect(p1.values.id).toMatch(/^prop_/);
    expect(p1.values.productId).toBe('p1');
    expect(p1.values.nodeId).toBe('n1');
    expect(p1.values.name).toBe('铜钥');
    expect(p1.values.kind).toBe('key');
    expect(p1.values.code).toBeNull();
    expect(p1.values.placeNote).toBe('前台旧物包内');
    expect(p2.values.name).toBe('家书');
    expect(p2.values.kind).toBe('letter');
    expect(p2.values.placeNote).toBe('客房枕头下');
    expect(fake.state.txNpcInserts).toHaveLength(0);
    expect(fake.state.jobUpdateSets).toHaveLength(1);
    expect(fake.state.jobUpdateSets[0].result.applied).toBe(true);
  });

  it('j) 幂等：道具已存在则跳过 insert', async () => {
    fake.state.jobRows = [makeJob({ result: { refine: sceneDraftWithProps } })];
    fake.state.sceneUpdateRows = [{ id: 'n1', type: 'scene' }];
    fake.state.propRows = [{ id: 'prop_existing', productId: 'p1', nodeId: 'n1', name: '铜钥' }];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(200);
    expect(fake.state.propInserts).toHaveLength(0);
    expect(fake.state.sceneUpdateSets).toHaveLength(1);
    expect(fake.state.jobUpdateSets).toHaveLength(1);
  });

  it('k) props 防御：缺 name 跳过；kind 非白名单 → 默认 letter；placeNote 非串 → null', async () => {
    const draft = {
      ...sceneDraftWithProps,
      props: [
        { name: '印章', kind: 'artifact' },
        { kind: 'key' },
        { name: '腰牌', kind: 'card', placeNote: 123 },
      ],
    };
    fake.state.jobRows = [makeJob({ result: { refine: draft } })];
    fake.state.sceneUpdateRows = [{ id: 'n1', type: 'scene' }];
    const res = await post(APPLY, { taskId: 'task1' });
    expect(res.status).toBe(200);
    expect(fake.state.propInserts).toHaveLength(2);
    const stamp = fake.state.propInserts.find((p) => p.values.name === '印章')!;
    expect(stamp.values.kind).toBe('letter');
    const badge = fake.state.propInserts.find((p) => p.values.name === '腰牌')!;
    expect(badge.values.kind).toBe('card');
    expect(badge.values.placeNote).toBeNull();
  });
});

// ===== POST /npc-jobs/:id/discard（任务中心「弃用」按钮）=====
describe('POST /npc-jobs/:id/discard（弃用 AI 草稿）', () => {
  const DISCARD = '/npc-jobs/task1/discard';
  beforeEach(() => {
    fake.state.jobRows = [];
    fake.state.jobUpdateSets = [];
  });

  it('a) succeeded 未采纳 → 200，result 置 discarded=true', async () => {
    fake.state.jobRows = [makeJob()];
    const res = await post(DISCARD);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.discarded).toBe(true);
    expect(fake.state.jobUpdateSets).toHaveLength(1);
    expect(fake.state.jobUpdateSets[0].result.discarded).toBe(true);
    expect(fake.state.jobUpdateSets[0].result.refine).toEqual(refineDraft);
  });

  it('b) 已弃用再弃用 → 200 幂等（不再写库）', async () => {
    fake.state.jobRows = [makeJob({ result: { refine: refineDraft, discarded: true } })];
    const res = await post(DISCARD);
    expect(res.status).toBe(200);
    expect(fake.state.jobUpdateSets).toHaveLength(0);
  });

  it('c) 已采纳 → 409 不能弃用', async () => {
    fake.state.jobRows = [makeJob({ result: { refine: refineDraft, applied: true } })];
    const res = await post(DISCARD);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain('已采纳');
    expect(fake.state.jobUpdateSets).toHaveLength(0);
  });

  it('d) 非 succeeded（pending/failed）→ 409', async () => {
    fake.state.jobRows = [makeJob({ status: 'failed' })];
    const res = await post(DISCARD);
    expect(res.status).toBe(409);
    expect(fake.state.jobUpdateSets).toHaveLength(0);
  });

  it('e) 任务不存在 → 404', async () => {
    const res = await post(DISCARD);
    expect(res.status).toBe(404);
    expect(fake.state.jobUpdateSets).toHaveLength(0);
  });
});
