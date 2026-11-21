// 场地档案 / 合作商户 / 实体道具 admin CRUD 单测（实景解密体验体系 Task 8）。
// 不连库（本机无 PG）：vi.mock ../../../db/index.js 假库 + Hono app.request。
// 装配照抄 wenlv-node-atoms.test.ts / wenlv-theme-sanitize.test.ts：假 db 记录落库 payload，
// 在**不连库**的前提下验证端点接线、白名单、暗码生成。
import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 假 db ─────────────────────────────────────────────────────────────────────
// state 挂在假模块上（而非文件级 const）：vi.mock 工厂提升到 import 之前，
// 引用文件后方的 const 会踩 TDZ（与 wenlv-theme-sanitize.test.ts 同款理由）。
vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const state: {
    venueProfiles: any[];
    merchants: any[];
    props: any[];
    venueRows: any[];
    productRows: any[];
    masters: any[];
    inserted: { table: string; values: any; onConflict?: any }[];
    updated: { table: string; payload: any }[];
    deleteQueue: any[][];
    updateQueue: any[][];
  } = {
    venueProfiles: [],
    merchants: [],
    props: [],
    venueRows: [],
    productRows: [],
    masters: [],
    inserted: [],
    updated: [],
    deleteQueue: [],
    updateQueue: [],
  };

  const rowsFor = (name: string) =>
    name === 'pms_bui_wenlv_venue_profiles' ? state.venueProfiles
    : name === 'pms_bui_wenlv_merchant_partners' ? state.merchants
    : name === 'pms_bui_wenlv_props' ? state.props
    : name === 'pms_bui_wenlv_venues' ? state.venueRows
    : name === 'pms_bui_wenlv_products' ? state.productRows
    : name === 'pms_bui_wenlv_merchants' ? state.masters
    : [];

  // select().from(table).where(...) → thenable（可 await）+ limit/orderBy 链。
  // 不求值 where 操作符（eq/and/or/isNull）——按表名返回整组配置行，
  // 用例只配置被测产品的行，足够区分。
  const selectChain = (table: unknown) => {
    const name = tableName(table);
    const allRows = () => [...rowsFor(name)];
    const w: any = {
      limit: async (n?: number) => allRows().slice(0, n ?? 1),
      orderBy: () => w,
    };
    w.then = (onFulfilled: any, onRejected?: any) =>
      Promise.resolve(allRows()).then(onFulfilled, onRejected);
    return w;
  };

  const db = {
    // select(fields?).from(table).leftJoin(...)?.where(...) → thenable + limit/orderBy 链。
    // leftJoin 只做链式占位（假库不求值 join 条件），where 返回按表名取行的 selectChain。
    select: () => ({ from: (table: unknown) => {
      const chain = {
        leftJoin: () => chain,
        where: () => selectChain(table),
      };
      return chain;
    } }),
    insert: (table: unknown) => {
      const name = tableName(table);
      return {
        values: (v: any) => {
          const entry: { table: string; values: any; onConflict?: any } = { table: name, values: v };
          state.inserted.push(entry);
          return {
            // upsert：记录 onConflict 配置，回显输入值（真实 DB 在冲突时返回更新后的行）
            onConflictDoUpdate: (conf: any) => {
              entry.onConflict = conf;
              return { returning: async () => [{ ...v }] };
            },
            returning: async () => [{ ...v }],
          };
        },
      };
    },
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: () => ({
          returning: async () => {
            state.updated.push({ table: tableName(table), payload });
            // updateQueue 为空 → 默认回显 payload（成功路径）；
            // 用例可 push [] 模拟「行不存在」→ returning() 返回 [] → 404
            return state.updateQueue.length ? state.updateQueue.shift()! : [{ ...payload }];
          },
        }),
      }),
    }),
    delete: (table: unknown) => ({
      where: () => ({
        returning: async () => {
          // deleteQueue 为空 → []（不存在 → 404）；用例 push [row] 模拟删除成功
          return state.deleteQueue.length ? state.deleteQueue.shift()! : [];
        },
      }),
    }),
  };
  return { db, state };
});

import adminWenlvRoute from '../wenlv.js';
import * as fakeDbModule from '../../../db/index.js';

const fake = fakeDbModule as unknown as {
  state: {
    venueProfiles: any[];
    merchants: any[];
    props: any[];
    venueRows: any[];
    productRows: any[];
    masters: any[];
    inserted: { table: string; values: any; onConflict?: any }[];
    updated: { table: string; payload: any }[];
    deleteQueue: any[][];
    updateQueue: any[][];
  };
};

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const call = (method: string, path: string, body?: unknown) =>
  adminWenlvRoute.request(path, {
    method,
    headers: H,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  fake.state.venueProfiles = [];
  fake.state.merchants = [];
  fake.state.props = [];
  fake.state.masters = [];
  // 默认场地/产品存在（merchant/props POST 的 existence guard 用）
  fake.state.venueRows = [{ id: 'v1', name: '测试场地' }];
  fake.state.productRows = [{ id: 'p1', name: '测试剧本', status: 'draft' }];
  fake.state.inserted = [];
  fake.state.updated = [];
  fake.state.deleteQueue = [];
  fake.state.updateQueue = [];
});

// ── 门禁 ──────────────────────────────────────────────────────────────────────

describe('场地档案 / 商户 / 道具 admin CRUD 门禁', () => {
  it('未带内部 token → 403（不是裸端点）', async () => {
    const res = await adminWenlvRoute.request('/venues/v1/merchants', {
      method: 'GET',
      headers: { 'Content-Type': 'application/json' },
    });
    expect(res.status).toBe(403);
  });
});

// ── 场地档案（1:1 venue profile）─────────────────────────────────────────────

describe('PUT /venues/:venueId/profile（upsert）', () => {
  it('新 venueId → insert + onConflictDoUpdate（target=venueId），回显 200', async () => {
    const res = await call('PUT', '/venues/v1/profile', {
      supportActions: { contacts: true },
      deployableAtoms: ['atom-search'],
      routeRadiusM: 500,
      timeWindows: [{ from: '09:00', to: '18:00' }],
      notes: '测试档案',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.venueId).toBe('v1');
    expect(b.data.supportActions).toEqual({ contacts: true });
    // 承重：必须走 onConflictDoUpdate（upsert），不是裸 insert
    expect(fake.state.inserted).toHaveLength(1);
    expect(fake.state.inserted[0].table).toBe('pms_bui_wenlv_venue_profiles');
    expect(fake.state.inserted[0].onConflict).toBeDefined();
    expect(fake.state.inserted[0].values.venueId).toBe('v1');
    expect(fake.state.inserted[0].values.notes).toBe('测试档案');
  });

  it('已存在 → 仍走 insert + onConflictDoUpdate（不二次查库、不走 select+update 分支）', async () => {
    // 配置已有行——证明 app **不**先 select 再决定 insert/update，永远 upsert
    fake.state.venueProfiles = [{ id: 'vp_old', venueId: 'v1', notes: '旧备注' }];
    const res = await call('PUT', '/venues/v1/profile', { notes: '新备注' });
    expect(res.status).toBe(200);
    // 只有 1 次 insert（onConflictDoUpdate），**没有**额外的 update 调用
    expect(fake.state.inserted).toHaveLength(1);
    expect(fake.state.inserted[0].onConflict).toBeDefined();
    expect(fake.state.inserted[0].values.notes).toBe('新备注');
    expect(fake.state.updated).toHaveLength(0);
  });
});

describe('GET /venues/:venueId/profile', () => {
  it('存在 → 200', async () => {
    fake.state.venueProfiles = [{ id: 'vp_1', venueId: 'v1', notes: '档案', routeRadiusM: 300 }];
    const res = await call('GET', '/venues/v1/profile');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.venueId).toBe('v1');
    expect(b.data.notes).toBe('档案');
    expect(b.data.routeRadiusM).toBe(300);
  });

  it('不存在 → 404', async () => {
    const res = await call('GET', '/venues/missing/profile');
    expect(res.status).toBe(404);
    const b = await res.json();
    expect(b.success).toBe(false);
  });
});

// ── 合作商户 ─────────────────────────────────────────────────────────────────

describe('商户 CRUD', () => {
  it('POST /venues/:venueId/merchants：创建，id 以 mp_ 前缀生成', async () => {
    const res = await call('POST', '/venues/v1/merchants', {
      name: '老张饭馆', role: 'restaurant', cipherDish: '宫保鸡丁',
      replyCode: 'RC-001', staffCard: '培训卡内容',
      timeWindows: [{ from: '10:00', to: '14:00' }], status: 'active',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.venueId).toBe('v1');
    expect(b.data.name).toBe('老张饭馆');
    expect(b.data.id).toMatch(/^mp_/);
    expect(fake.state.inserted).toHaveLength(1);
    expect(fake.state.inserted[0].table).toBe('pms_bui_wenlv_merchant_partners');
    expect(fake.state.inserted[0].values.venueId).toBe('v1');
  });

  it('POST /venues/:venueId/merchants：场地不存在 → 404', async () => {
    fake.state.venueRows = [];
    const res = await call('POST', '/venues/missing/merchants', { name: 'x' });
    expect(res.status).toBe(404);
    expect(fake.state.inserted).toHaveLength(0);
  });

  it('POST /venues/:venueId/merchants：缺 name → 400', async () => {
    const res = await call('POST', '/venues/v1/merchants', { role: 'restaurant' });
    expect(res.status).toBe(400);
    expect(fake.state.inserted).toHaveLength(0);
  });

  it('POST /venues/:venueId/merchants：带 merchantId 且主数据存在 → name 用主数据兜底、merchantId 落库', async () => {
    fake.state.masters = [{ id: 'm_master_1', name: '主数据面馆', status: 'active' }];
    const res = await call('POST', '/venues/v1/merchants', {
      role: 'restaurant', merchantId: 'm_master_1',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.name).toBe('主数据面馆'); // 未传 name，由主数据兜底
    expect(fake.state.inserted[0].values.merchantId).toBe('m_master_1');
  });

  it('POST /venues/:venueId/merchants：带 merchantId 但主数据不存在 → 400', async () => {
    const res = await call('POST', '/venues/v1/merchants', {
      role: 'restaurant', merchantId: 'm_master_nope',
    });
    expect(res.status).toBe(400);
    expect(fake.state.inserted).toHaveLength(0);
  });

  it('POST /venues/:venueId/merchants：带 merchantId + name → 手填 name 优先于主数据', async () => {
    fake.state.masters = [{ id: 'm_master_1', name: '主数据面馆', status: 'active' }];
    const res = await call('POST', '/venues/v1/merchants', {
      name: '现场别名', role: 'restaurant', merchantId: 'm_master_1',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.name).toBe('现场别名');
    expect(fake.state.inserted[0].values.merchantId).toBe('m_master_1');
  });

  it('PATCH /merchants/:id：白名单字段写入，结构字段（venueId/id）被忽略', async () => {
    const res = await call('PATCH', '/merchants/mp_1', {
      name: '新名字', role: 'merch', cipherDish: '新暗号菜',
      replyCode: 'RC-002', staffCard: '新卡', timeWindows: [], status: 'inactive',
      // 白名单外——必须被忽略
      venueId: 'hacked-venue', id: 'hacked-id',
    });
    expect(res.status).toBe(200);
    expect(fake.state.updated).toHaveLength(1);
    const payload = fake.state.updated[0].payload;
    expect(payload.name).toBe('新名字');
    expect(payload.role).toBe('merch');
    expect(payload.cipherDish).toBe('新暗号菜');
    // 🔴 结构字段不得进 set payload（静默丢弃 = 越权写 venueId）
    expect(payload).not.toHaveProperty('venueId');
    expect(payload).not.toHaveProperty('id');
  });

  it('PATCH /merchants/:id：不存在 → 404', async () => {
    fake.state.updateQueue = [[]]; // returning() 返回 [] → row undefined
    const res = await call('PATCH', '/merchants/missing', { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('PATCH /merchants/:id：merchantId 指向存在主数据 → 写入', async () => {
    fake.state.masters = [{ id: 'm_master_1', name: '主数据面馆', status: 'active' }];
    const res = await call('PATCH', '/merchants/mp_1', { merchantId: 'm_master_1' });
    expect(res.status).toBe(200);
    expect(fake.state.updated[0].payload.merchantId).toBe('m_master_1');
  });

  it('PATCH /merchants/:id：merchantId 指向不存在主数据 → 400', async () => {
    const res = await call('PATCH', '/merchants/mp_1', { merchantId: 'm_master_nope' });
    expect(res.status).toBe(400);
  });

  it('PATCH /merchants/:id：merchantId 为 null → 解绑放行', async () => {
    const res = await call('PATCH', '/merchants/mp_1', { merchantId: null });
    expect(res.status).toBe(200);
    expect(fake.state.updated[0].payload.merchantId).toBeNull();
  });

  it('DELETE /merchants/:id：存在 → 200', async () => {
    fake.state.deleteQueue = [[{ id: 'mp_1', name: '老张饭馆' }]];
    const res = await call('DELETE', '/merchants/mp_1');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.id).toBe('mp_1');
  });

  it('DELETE /merchants/:id：不存在 → 404', async () => {
    // deleteQueue 空 → returning() 返回 [] → 404
    const res = await call('DELETE', '/merchants/missing');
    expect(res.status).toBe(404);
  });

  it('GET /venues/:venueId/merchants：列表按预期字段返回', async () => {
    fake.state.merchants = [
      { id: 'mp_1', venueId: 'v1', name: '商户A', role: 'restaurant', status: 'active' },
      { id: 'mp_2', venueId: 'v1', name: '商户B', role: 'merch', status: 'active' },
    ];
    const res = await call('GET', '/venues/v1/merchants');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data).toHaveLength(2);
    expect(b.data[0].name).toBe('商户A');
    expect(b.data[1].role).toBe('merch');
  });
});

// ── 实体道具 ─────────────────────────────────────────────────────────────────

describe('道具 CRUD', () => {
  it('POST /products/:id/props：创建，id 以 prop_ 前缀生成', async () => {
    const res = await call('POST', '/products/p1/props', {
      name: '密信道具', kind: 'letter', placeNote: '藏在古井旁', nodeId: 'n1',
    });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.productId).toBe('p1');
    expect(b.data.name).toBe('密信道具');
    expect(b.data.id).toMatch(/^prop_/);
    expect(fake.state.inserted).toHaveLength(1);
    expect(fake.state.inserted[0].table).toBe('pms_bui_wenlv_props');
  });

  it('POST /products/:id/props：产品不存在 → 404', async () => {
    fake.state.productRows = [];
    const res = await call('POST', '/products/missing/props', { name: 'x' });
    expect(res.status).toBe(404);
    expect(fake.state.inserted).toHaveLength(0);
  });

  it('POST /products/:id/props：缺 name → 400', async () => {
    const res = await call('POST', '/products/p1/props', { kind: 'letter' });
    expect(res.status).toBe(400);
    expect(fake.state.inserted).toHaveLength(0);
  });

  it('PATCH /props/:id：白名单字段写入，结构字段（productId/id）被忽略', async () => {
    const res = await call('PATCH', '/props/prop_1', {
      name: '新名字', kind: 'key', code: 'WENLV-ABC123',
      placeNote: '新位置', nodeId: 'n2',
      // 白名单外——必须被忽略
      productId: 'hacked-product', id: 'hacked-id',
    });
    expect(res.status).toBe(200);
    expect(fake.state.updated).toHaveLength(1);
    const payload = fake.state.updated[0].payload;
    expect(payload.name).toBe('新名字');
    expect(payload.kind).toBe('key');
    expect(payload.code).toBe('WENLV-ABC123');
    expect(payload).not.toHaveProperty('productId');
    expect(payload).not.toHaveProperty('id');
  });

  it('PATCH /props/:id：不存在 → 404', async () => {
    fake.state.updateQueue = [[]];
    const res = await call('PATCH', '/props/missing', { name: 'x' });
    expect(res.status).toBe(404);
  });

  it('DELETE /props/:id：存在 → 200', async () => {
    fake.state.deleteQueue = [[{ id: 'prop_1', name: '道具' }]];
    const res = await call('DELETE', '/props/prop_1');
    expect(res.status).toBe(200);
  });

  it('DELETE /props/:id：不存在 → 404', async () => {
    const res = await call('DELETE', '/props/missing');
    expect(res.status).toBe(404);
  });

  it('GET /products/:id/props：列表按预期字段返回', async () => {
    fake.state.props = [
      { id: 'prop_1', productId: 'p1', name: '道具A', kind: 'letter' },
      { id: 'prop_2', productId: 'p1', name: '道具B', kind: 'key' },
    ];
    const res = await call('GET', '/products/p1/props');
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data).toHaveLength(2);
    expect(b.data[0].name).toBe('道具A');
    expect(b.data[1].kind).toBe('key');
  });
});

// ── 暗码批量生成 ─────────────────────────────────────────────────────────────

describe('POST /products/:id/props/generate-codes', () => {
  it('空 code 生成暗码、已有 code 跳过、暗码唯一且去易混淆字符', async () => {
    fake.state.props = [
      { id: 'prop_1', productId: 'p1', name: '道具A', kind: 'letter', code: null },
      { id: 'prop_2', productId: 'p1', name: '道具B', kind: 'key', code: '' },
      { id: 'prop_3', productId: 'p1', name: '道具C', kind: 'card', code: 'WENLV-EXIST01' },
    ];
    const res = await call('POST', '/products/p1/props/generate-codes', {});
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    // 只有 2 条空 code 的被更新（prop_3 已有 code，跳过）
    expect(fake.state.updated).toHaveLength(2);
    const codes = fake.state.updated.map((u) => u.payload.code);
    for (const code of codes) {
      // 格式：WENLV-<6位>，字母数字大写
      expect(code).toMatch(/^WENLV-[A-Z2-9]{6}$/);
      // 🔴 去易混淆字符 I/O-0-1（红线）
      expect(code).not.toMatch(/[IO01]/);
    }
    // 两条暗码互不相同
    expect(codes[0]).not.toBe(codes[1]);
    // 生成的新暗码不与已有暗码冲突
    expect(codes).not.toContain('WENLV-EXIST01');
  });

  it('全部已有 code → 返回空列表、不触发 update', async () => {
    fake.state.props = [
      { id: 'prop_1', productId: 'p1', name: '道具A', code: 'WENLV-AAA111' },
    ];
    // 注意：WENLV-AAA111 含 1，但这里是测试数据（已有 code），不是新生成的
    const res = await call('POST', '/products/p1/props/generate-codes', {});
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data).toHaveLength(0);
    expect(fake.state.updated).toHaveLength(0);
  });

  it('产品不存在 → 404', async () => {
    fake.state.productRows = [];
    const res = await call('POST', '/products/missing/props/generate-codes', {});
    expect(res.status).toBe(404);
  });
});
