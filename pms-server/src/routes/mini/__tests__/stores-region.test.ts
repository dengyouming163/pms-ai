import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';

// mock db：验证 region 筛选时拼出的条件与响应暴露 regionTags
vi.mock('../../../db/index.js', () => ({ db: { select: vi.fn() } }));

import { db } from '../../../db/index.js';
import route from '../stores.js';

const app = new Hono();
app.route('/api/mini/stores', route);

beforeEach(() => { vi.clearAllMocks(); });

/** 模拟列表查询返回两门店（一个绑地域、一个未绑） */
function mockList(rows: any[]) {
  const chain = {
    from: vi.fn().mockReturnThis(),
    innerJoin: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    limit: vi.fn().mockResolvedValue(rows),
  };
  (db.select as any).mockReturnValue(chain);
  return chain;
}

/**
 * 提取 drizzle SQL 对象渲染后的 SQL 文本，用于断言 where 收到的条件内容。
 * 只遍历 queryChunks / StringChunk.value / Column.name / Param.value，
 * 不下沉 table 等引用，避免循环结构（JSON.stringify 会因 table↔columns 循环引用抛错）。
 */
function sqlText(node: any): string {
  const out: string[] = [];
  const walk = (n: any): void => {
    if (n == null) return;
    if (Array.isArray(n)) { n.forEach(walk); return; }
    if (typeof n === 'string') { out.push(n); return; }
    if (typeof n !== 'object') { out.push(String(n)); return; }
    // StringChunk：value 为 string[]，原始 SQL 片段
    if (Array.isArray(n.value) && typeof n.value[0] === 'string') { out.push(n.value.join('')); return; }
    // 嵌套 SQL：继续下沉 queryChunks
    if (Array.isArray(n.queryChunks)) { walk(n.queryChunks); return; }
    // Column：name 即数据库列名（如 region_tags）
    if (typeof n.name === 'string' && (n.dataType || n.columnType)) { out.push(n.name); return; }
    // Param：value 即参数值
    if ('value' in n) walk(n.value);
  };
  walk(node);
  return out.join('');
}

describe('GET /api/mini/stores — regionTags 暴露与 region 筛选', () => {
  it('不带 region 时 select 暴露 regionTags 字段', async () => {
    const rows = [{ id: 'store_1', name: '村眠', brandName: 'B', address: '', city: null, preferenceTags: [], regionTags: ['黄果树', '安顺'], phone: '', headerImages: [], intro: '' }];
    mockList(rows);
    const res = await app.request('/api/mini/stores');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data[0].regionTags).toEqual(['黄果树', '安顺']);
  });

  it('region 筛选：where 收到 region_tags @> 地域的条件', async () => {
    const rows: any[] = [];
    const chain = mockList(rows);
    await app.request('/api/mini/stores?region=%E9%BB%84%E6%9E%9C%E6%A0%91'); // 黄果树
    // where 只被调用一次（and() 拼好的条件）；验证传入的条件渲染后含 region_tags @>
    const whereCalls = chain.where.mock.calls.map((c: any) => sqlText(c[0]));
    const hasRegionCond = whereCalls.some((s: string) => s.includes('region_tags') && s.includes('@>'));
    expect(hasRegionCond).toBe(true);
  });

  it('无 region 时不拼 region 条件（where 不含 region_tags）', async () => {
    const chain = mockList([]);
    await app.request('/api/mini/stores');
    const whereCalls = chain.where.mock.calls.map((c: any) => sqlText(c[0]));
    expect(whereCalls.some((s: string) => s.includes('region_tags'))).toBe(false);
  });
});
