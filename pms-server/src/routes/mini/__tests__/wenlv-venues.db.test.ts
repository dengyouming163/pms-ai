// `GET /api/mini/wenlv/venues` 的真库测试（⑤-A「按场地」视角的数据源）。
// 三条硬约束各自有独立判据：
//   ① 它必须**躲过 `/:id`**（Hono 按注册顺序匹配）—— 被吃掉时表现为「产品不存在」404，
//      而「不存在的 id → 404」的既有用例**照样绿**，光看全绿发现不了错位；
//   ② 投影必须是**白名单** —— 场地行含 contactName / contactPhone / ownerStaffId / remark；
//   ③ 只给 `live` 场地 —— pilot / deploying 等未运营场地不给游客看。
// ⚠️ 本文件碰库 ⇒ 必须挂 `describe.skipIf(!process.env.RUN_DB)`（理由见姊妹文件
//    wenlv-trade-products.db.test.ts 顶部）。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { like } from 'drizzle-orm';
import route from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvVenues } from '../../../db/schema/index.js';

const TS = Date.now();
const vn = (k: string) => `vn5aq-${k}-${TS}`;
const T_OLD = new Date('2026-01-01T00:00:00Z');
const T_NEW = new Date('2026-03-01T00:00:00Z');

describe.skipIf(!process.env.RUN_DB)('GET /api/mini/wenlv/venues 公开场地列表', () => {
  beforeAll(async () => {
    // 🔴 **桩序刻意与期望序相反**（期望序：阿运营点 → 新运营点 → 老运营点 → 无章运营点）；
    //    若照期望序写，DB 无 ORDER BY 时的物理序恰好等于期望序 ⇒ 整段 sort 删掉也全绿（同片 Task 3）。
    //    liveNew / liveTie 同章、桩序里 liveNew 在前 ⇒ 靠 name 兜底定先后，兜底退化成 `return 0` 即红。
    await db.insert(pmsBuiWenlvVenues).values([
      { id: vn('liveNoStamp'), name: '无章运营点', status: 'live', city: null, liveAt: null },
      { id: vn('liveOld'), name: '老运营点', status: 'live', city: '黔东南', liveAt: T_OLD },
      { id: vn('liveNew'), name: '新运营点', status: 'live', city: '安顺', address: '某某路 1 号', liveAt: T_NEW,
        contactName: '内部联系人', contactPhone: '13800000000', ownerStaffId: 'staff-1', remark: '内部备注' },
      { id: vn('liveTie'), name: '阿运营点', status: 'live', city: '贵阳', liveAt: T_NEW },
      { id: vn('pilot'), name: '试运营点', status: 'pilot' },
      { id: vn('deploying'), name: '部署中点', status: 'deploying' },
      { id: vn('archived'), name: '已归档点', status: 'archived' },
    ]);
  });
  afterAll(async () => {
    await db.delete(pmsBuiWenlvVenues).where(like(pmsBuiWenlvVenues.id, `vn5aq-%-${TS}`));
  });

  it('无 token 直连 handler 也是 200（handler 内不解析 token）', async () => {
    const res = await route.request('/venues');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(Array.isArray(body.data.list)).toBe(true);
    expect(body.data.total).toBe(body.data.list.length);   // 契约字段：整条删掉也全绿 ⇒ 必须有判据
  });

  it('🔴 不是「产品不存在」404 —— 证明它注册在 `/:id` 之前', async () => {
    const res = await route.request('/venues');
    const body = await res.json();
    // 被 `route.get('/:id')` 吃掉时：`/venues` 被当成产品 id ⇒ 404 + error「产品不存在」。
    // 断言 `=== 200` 而不是 `!== 404`：后者会**放行 500/403**（服务出错时反而绿）；`=== 200` 同时钉住「路由对」与「没出错」。
    expect(res.status, `被 /:id 吃掉会得到 404：${JSON.stringify(body)}`).toBe(200);
    expect(body.error ?? '').not.toBe('产品不存在');
  });

  it('只给 live：deploying / pilot / archived 不出现', async () => {
    const body = await (await route.request('/venues')).json();
    const ids = body.data.list.map((v: any) => v.id);
    expect(ids).toContain(vn('liveNew'));
    expect(ids).not.toContain(vn('deploying'));
    expect(ids).not.toContain(vn('pilot'));
    expect(ids).not.toContain(vn('archived'));
  });

  it('🔴 白名单投影：键集**恰好**是 id/name/city/address/liveAt', async () => {
    const body = await (await route.request('/venues')).json();
    const row = body.data.list.find((v: any) => v.id === vn('liveNew'));
    expect(row).toBeTruthy();
    // 键集相等（不是「含这几个」）：它同时挡「多列外泄」与「实现被改成 db.select() 整行」。
    // 逐键点名内部字段只是为了失败信息能直接说出漏了什么。
    for (const k of ['contactName', 'contactPhone', 'ownerStaffId', 'remark', 'latitude', 'longitude']) {
      expect(row, `${k} 不得下发`).not.toHaveProperty(k);
    }
    expect(Object.keys(row).sort()).toEqual(['address', 'city', 'id', 'liveAt', 'name']);
  });

  it('排序：liveAt 降序，同章按 name 兜底，无章的排最后', async () => {
    const body = await (await route.request('/venues')).json();
    const ids = body.data.list.map((v: any) => v.id);
    const at = (k: string) => ids.indexOf(vn(k));
    for (const k of ['liveNew', 'liveTie', 'liveOld', 'liveNoStamp']) expect(at(k), `${k} 丢了`).toBeGreaterThanOrEqual(0);
    expect(at('liveNew')).toBeLessThan(at('liveOld'));     // 降序（T_NEW 2026-03 > T_OLD 2026-01）
    expect(at('liveOld')).toBeLessThan(at('liveNoStamp'));  // 无章的沉底
    expect(at('liveTie')).toBeLessThan(at('liveNew'));      // 同章按 name 兜底：阿 < 新（桩序相反 ⇒ 退化即红）
  });

  it('liveAt 序列化成 ISO 字符串（Date 经 c.json() 的形态）', async () => {
    const body = await (await route.request('/venues')).json();
    const row = body.data.list.find((v: any) => v.id === vn('liveNew'));
    expect(row.liveAt).toBe(T_NEW.toISOString());
  });
});
