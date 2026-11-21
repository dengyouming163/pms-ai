import { describe, it, expect, beforeEach, vi } from 'vitest';

// ── 假 db ─────────────────────────────────────────────────────────────────────
// POST/PATCH 会真正走到 insert/update，故用假 db 记录落库 payload，
// 就能在**不连库**（更不连生产）的前提下验证「两条路径是否都经过了 sanitize」。
// 为什么必须连 POST 一起测：schema transform 只护得住 PATCH，
// POST 若仍写原始 body.theme，等于没接剥离 —— 这正是要堵的陷阱，且 AI 建档走的正是这条 POST。
// 注：本文件加载的是被替换掉的 db/index.js，不创建 pg Pool、不连任何库。
//
// 状态为什么挂在假模块上、而不是文件级 const：vi.mock 工厂会被提升到 import 之前执行，
// 引用文件后方的 const 会踩 TDZ；本仓库的 vitest 类型未暴露 vi.hoisted，故走这条路。
vi.mock('../../../db/index.js', () => {
  const state: { selectRows: unknown[]; venueRows: unknown[]; inserted: any; updated: any } = {
    selectRows: [],
    venueRows: [],
    inserted: null,
    updated: null,
  };
  const db = {
    // `select()` 与 `select({ id: ... })` 必须分开喂：POST 路径上有**两次**查库 ——
    // 先是产品 id 的幂等存在性检查（无列投影），再是 venueId 的场地存在性校验（有列投影）。
    // 若只喂一组行，id 检查会先命中并早返回「既有行」⇒ 根本不 insert（`state.inserted` 恒 null）。
    // 故按「是否传了列投影」分派：本文件里只有场地存在性校验会传投影。
    select: (cols?: unknown) => ({
      from: () => ({
        where: () => ({
          limit: async () => (cols ? state.venueRows : state.selectRows),
          orderBy: async () => state.selectRows,
        }),
      }),
    }),
    insert: () => ({
      values: (v: any) => ({
        returning: async () => {
          state.inserted = v;
          return [{ ...v }];
        },
      }),
    }),
    update: () => ({
      set: (v: any) => ({
        where: () => ({
          returning: async () => {
            state.updated = v;
            return [{ ...v }];
          },
        }),
      }),
    }),
  };
  return { db, state };
});

// vi.mock 由 vitest 提升到文件顶部，下面 import 到的即已替换 db 的版本
import adminWenlvRoute, { productHeadSchema } from '../wenlv.js';
// 取整个命名空间（而非 { db }）：假 db 的落库记录挂在 state 上，要连 state 一起拿到
import * as fakeDbModule from '../../../db/index.js';
import { sanitizeWenlvTheme, isSafeCssColor } from '../wenlv-theme-sanitize.js';

const fake = fakeDbModule as unknown as {
  state: { selectRows: unknown[]; venueRows: unknown[]; inserted: any; updated: any };
};

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'internal-secret-dev';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

const call = (method: string, path: string, body?: unknown) =>
  adminWenlvRoute.request(path, {
    method,
    headers: H,
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

// ── 纯函数：剥离规则 ───────────────────────────────────────────────────────────
describe('sanitizeWenlvTheme（纯函数，无 DB）', () => {
  it('合法 CSS 颜色原样保留（hex 3/4/6/8 位、rgb、hsl）', () => {
    for (const c of ['#4F46E5', '#fff', '#4F46E5FF', 'rgb(79, 70, 229)', 'rgba(79,70,229,0.5)', 'hsl(243 75% 59%)']) {
      const out = sanitizeWenlvTheme({ primaryColor: c }) as Record<string, unknown>;
      expect(out.primaryColor).toBe(c);
      expect(isSafeCssColor(c)).toBe(true);
    }
  });

  it('非法 primaryColor 被剥离（中文色名 / 关键字 / 位数不对的 hex / 残缺 rgb）', () => {
    for (const c of ['深蓝', 'red', '#12345', '#1234567', 'rgb(1,2)', 'javascript:alert(1)']) {
      const out = sanitizeWenlvTheme({ primaryColor: c }) as Record<string, unknown>;
      expect('primaryColor' in out).toBe(false);
      expect(isSafeCssColor(c)).toBe(false);
    }
  });

  it('空串 primaryColor 被剥离（空串经 var() 注入同样会 IACVT）', () => {
    const out = sanitizeWenlvTheme({ primaryColor: '' }) as Record<string, unknown>;
    expect('primaryColor' in out).toBe(false);
    // 纯空白同理
    const blank = sanitizeWenlvTheme({ primaryColor: '   ' }) as Record<string, unknown>;
    expect('primaryColor' in blank).toBe(false);
  });

  it('primaryColor 为 null / undefined 时删键且不炸', () => {
    for (const v of [null, undefined]) {
      const out = sanitizeWenlvTheme({ primaryColor: v, logo: 'a.png' }) as Record<string, unknown>;
      expect('primaryColor' in out).toBe(false);
      expect(out.logo).toBe('a.png');
    }
  });

  it('其余 theme 字段一字不变（含未知键 foo，不得白名单重建对象）', () => {
    const theme: Record<string, unknown> = {
      primaryColor: '深蓝',
      logo: 'https://x/logo.png',
      bgImage: 'https://x/bg.jpg',
      font: 'serif',
      mascotIp: 'ip-1',
      templateId: 'tpl-neon',
      motion: { duration: 240, easing: 'ease-out' },
      soundStyle: 'cyber',
      haptic: { stamp: true },
      colors: { accent: '#0FF', surface: '#111' },
      foo: 1,
    };
    const expected = { ...theme };
    delete expected.primaryColor;

    const out = sanitizeWenlvTheme(theme) as Record<string, unknown>;
    expect(out).toEqual(expected);
    expect(out.foo).toBe(1);
    expect(out.colors).toEqual({ accent: '#0FF', surface: '#111' });
    expect(out.motion).toEqual({ duration: 240, easing: 'ease-out' });
  });

  it('非普通对象原样返回不炸（null / undefined / 字符串 / 数字 / 数组）', () => {
    expect(sanitizeWenlvTheme(null)).toBe(null);
    expect(sanitizeWenlvTheme(undefined)).toBe(undefined);
    expect(sanitizeWenlvTheme('theme')).toBe('theme');
    expect(sanitizeWenlvTheme(7)).toBe(7);
    const arr = [1, 2];
    expect(sanitizeWenlvTheme(arr)).toBe(arr);
  });

  it('无 primaryColor 的对象返回等价拷贝，且不就地改写入参', () => {
    expect(sanitizeWenlvTheme({})).toEqual({});
    const input: Record<string, unknown> = { primaryColor: 'red', logo: 'a.png' };
    const out = sanitizeWenlvTheme(input) as Record<string, unknown>;
    expect(input.primaryColor).toBe('red'); // 入参未被就地删除
    expect('primaryColor' in out).toBe(false);
  });

  it('与 pms-nimi 同口径：长度 >64 的超长值被拒', () => {
    expect(isSafeCssColor('#' + 'a'.repeat(64))).toBe(false);
  });
});

// ── schema 层：transform 确实接上了 ────────────────────────────────────────────
describe('productHeadSchema.theme transform 接线', () => {
  it('POST 形态（全量 parse）剥离非法 primaryColor', () => {
    const r = productHeadSchema.safeParse({ name: 'x', venueId: 'v-any', theme: { primaryColor: '深蓝', logo: 'l.png' } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.theme).toEqual({ logo: 'l.png' });
  });

  it('PATCH 形态（partial parse）剥离非法 primaryColor', () => {
    const r = productHeadSchema.partial().safeParse({ theme: { primaryColor: '#12345', templateId: 't1' } });
    expect(r.success).toBe(true);
    expect(r.success && r.data.theme).toEqual({ templateId: 't1' });
  });

  it('PATCH 不传 theme 时该键缺失（transform 不得凭空造 {} 覆盖库里的 theme）', () => {
    const r = productHeadSchema.partial().safeParse({ name: '新名' });
    expect(r.success).toBe(true);
    expect(r.success && 'theme' in r.data).toBe(false);
  });
});

// ── 路由接线：两条落库路径都必须吃到 sanitize ─────────────────────────────────
describe('POST/PATCH 落库路径（假 db，无 DB 连接）', () => {
  beforeEach(() => {
    fake.state.selectRows = [];
    fake.state.venueRows = [];
    fake.state.inserted = null;
    fake.state.updated = null;
  });

  it('POST /products 落库的 theme 已剥离非法 primaryColor，其余字段（含未知键）保留', async () => {
    // 场地存在性校验（POST 路径上带列投影的那次查库）⇒ 喂 venueRows；
    // 产品 id 幂等检查（无投影）由 selectRows=[] 保证「不存在」，否则会早返回而不 insert。
    fake.state.venueRows = [{ id: 'v-any' }];
    const res = await call('POST', '/products', {
      id: 'sanitize-post-1',
      name: '剥离测试',
      venueId: 'v-any',
      theme: { primaryColor: '深蓝', logo: 'l.png', templateId: 'tpl-1', motion: { duration: 200 }, foo: 1 },
    });
    expect(res.status).toBe(200);
    // 关键断言：写库用的是 parsed.data.theme（走 transform），不是原始 body.theme
    expect(fake.state.inserted.theme).toEqual({
      logo: 'l.png', templateId: 'tpl-1', motion: { duration: 200 }, foo: 1,
    });
  });

  it('POST /products 合法 primaryColor 原样落库', async () => {
    fake.state.venueRows = [{ id: 'v-any' }];
    const res = await call('POST', '/products', {
      id: 'sanitize-post-2',
      name: '保留测试',
      venueId: 'v-any',
      theme: { primaryColor: '#4F46E5', logo: 'l.png' },
    });
    expect(res.status).toBe(200);
    expect(fake.state.inserted.theme).toEqual({ primaryColor: '#4F46E5', logo: 'l.png' });
  });

  it('PATCH /products/:id 落库的 theme 已剥离非法 primaryColor', async () => {
    fake.state.selectRows = [{ id: 'sanitize-patch-1' }]; // getProductOr404 命中
    const res = await call('PATCH', '/products/sanitize-patch-1', {
      theme: { primaryColor: 'red', templateId: 'tpl-2', foo: 'bar' },
    });
    expect(res.status).toBe(200);
    expect(fake.state.updated.theme).toEqual({ templateId: 'tpl-2', foo: 'bar' });
  });

  it('PATCH /products/:id 不传 theme 时不写该列（不覆盖库里已有 theme）', async () => {
    fake.state.selectRows = [{ id: 'sanitize-patch-2' }];
    const res = await call('PATCH', '/products/sanitize-patch-2', { name: '只改名' });
    expect(res.status).toBe(200);
    expect('theme' in fake.state.updated).toBe(false);
  });
});
