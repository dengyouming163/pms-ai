// 场景 atoms 写入口单测（实景解密体验体系 Task 3，0079 统一模型迁移版）：不连库、不连 LLM。
// 装配照抄 wenlv-node-refine.test.ts：vi.mock ../../../db/index.js 假库 + Hono app.request。
// 本机无 PG（ECONNREFUSED 5432），真库用例在此环境恒不可跑 ⇒ 本文件必须纯假库可绿。
import { describe, it, expect, beforeEach, vi } from 'vitest';

vi.mock('../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const state: {
    inserted: { table: string; values: any }[];
    updateSets: { table: string; payload: any }[];
  } = {
    inserted: [],
    updateSets: [],
  };

  const db = {
    select: () => ({
      from: () => ({ where: () => ({ limit: async () => [] }) }),
    }),
    // insert(...).values(v).returning()：留痕 values 并原样回显（atoms 必须随回读下发）。
    insert: (table: unknown) => ({
      values: (v: any) => ({
        returning: async () => {
          state.inserted.push({ table: tableName(table), values: v });
          return [{ ...v }];
        },
      }),
    }),
    // update(...).set(payload).where(...).returning()：回显 id + patch。
    update: (table: unknown) => ({
      set: (payload: any) => ({
        where: () => ({
          returning: async () => {
            state.updateSets.push({ table: tableName(table), payload });
            return [{ id: 'n1', ...payload }];
          },
        }),
      }),
    }),
  };
  return { db, state };
});

import adminWenlvRoute from '../wenlv.js';
import * as fakeDbModule from '../../../db/index.js';

const fake = fakeDbModule as unknown as {
  state: {
    inserted: { table: string; values: any }[];
    updateSets: { table: string; payload: any }[];
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
const patch = (path: string, body?: unknown) =>
  adminWenlvRoute.request(path, {
    method: 'PATCH',
    headers: H,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

beforeEach(() => {
  fake.state.inserted = [];
  fake.state.updateSets = [];
});

describe('POST /chapters/:id/scenes 与 PATCH /scenes/:id 的 atoms 写入', () => {
  it('合法 atoms 数组可写入并回读', async () => {
    const atoms = [{ id: 'a1', type: 'physical-search', config: { prompt: '找钥匙', expectedCode: 'X1' } }];
    const res = await post('/chapters/ch1/scenes', { title: '寻物场景', atoms });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(Array.isArray(b.data.scene.atoms)).toBe(true);
    expect(b.data.scene.atoms).toHaveLength(1);
    expect(b.data.scene.atoms[0].id).toBe('a1');
    // 承重：zod strip 未知键 —— 必须从 body 显式捞 atoms 写进 insert。
    expect(fake.state.inserted).toHaveLength(1);
    expect(fake.state.inserted[0].table).toBe('pms_bui_wenlv_scenes');
    expect(fake.state.inserted[0].values.atoms).toEqual(atoms);
  });

  it('PATCH 合法 atoms 覆写并回读（白名单含 atoms 的看守）', async () => {
    const atoms = [{ id: 'b1', type: 'observe', config: { prompt: '观察墙面', criteria: '新鲜划痕' } }];
    const res = await patch('/scenes/n1', { atoms });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.data.scene.atoms).toHaveLength(1);
    expect(b.data.scene.atoms[0].id).toBe('b1');
    // 白名单漏键时 set payload 里根本不会有 atoms（静默丢弃），这条断言是唯一看守。
    expect(fake.state.updateSets).toHaveLength(1);
    expect(fake.state.updateSets[0].payload.atoms).toEqual(atoms);
  });

  it('PATCH atoms=null 清空', async () => {
    const res = await patch('/scenes/n1', { atoms: null });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.scene.atoms).toBeNull();
    expect(fake.state.updateSets[0].payload.atoms).toBeNull();
  });

  it('PATCH 不带 atoms 键：只改 title，update payload 不含 atoms（undefined 不清空已有原子）', async () => {
    // PATCH 只改 title：白名单按 `k in body` 收集，atoms 不在 body ⇒ 绝不进 set payload。
    const res = await patch('/scenes/n1', { title: '新标题' });
    expect(res.status).toBe(200);
    expect(fake.state.updateSets).toHaveLength(1);
    expect(fake.state.updateSets[0].payload).not.toHaveProperty('atoms');
    expect(fake.state.updateSets[0].payload.title).toBe('新标题');
  });

  it('老字段 puzzle 照常写入（回归）：不带 atoms 时落库 atoms=[]（createScene 默认空数组）', async () => {
    const puzzle = { type: 'single' as const, question: '1+1=?', options: ['1', '2'], answer: '2' };
    const res = await post('/chapters/ch1/scenes', { title: '老谜题场景', puzzle });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.scene.puzzle).toEqual(puzzle);
    expect(b.data.scene.atoms).toEqual([]);
    expect(fake.state.inserted[0].values.puzzle).toEqual(puzzle);
    expect(fake.state.inserted[0].values.atoms).toEqual([]);
  });
});
