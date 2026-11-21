// 游客端现场问题上报端点 POST /api/mini/wenlv/report。
//
// ## 判据设计说明（很重要，别删）
// 端点未实现时 Hono 返 **404**，实现后才 200 —— 所以「存在性」本身就有区分力，
// 但真正的语义判据是**用例 3**：删掉票券旁路 env 后同一请求仍须 200。
// 若端点挂了 `assertTicket`，此时 bypass 失效 ⇒ 真去跨服务查票 ⇒ fail-closed 403。
// 实现前它必须是 404（已实测），否则该用例恒绿、等于没写。
//
// ## 票券旁路 env
// 本文件顶部置 `WENLV_BYPASS_TICKET=1`（对齐同目录 wenlv.test.ts 的基调），
// **仅用于隔离用例 3 之外的对票券门无感的用例**；用例 3 内部自行 `delete` 并在 finally 还原。
// 文件末尾（afterAll）一律清掉：vitest 同 worker 内 `process.env` 跨测试文件共享，
// 留着会让后跑的文件被静默旁路（本仓已有先例：wenlv-m5 / wenlv-enter 都写了防御性 delete）。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
process.env.WENLV_BYPASS_TICKET = '1';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import jwt from 'jsonwebtoken';
import { eq } from 'drizzle-orm';
import wenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvClientReports } from '../../../db/schema/index.js';

const mkMini = (id: string) => {
  const p = jwt.sign({ miniUserId: id, openid: 'o_' + id, platform: 'h5' }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });
  return { Authorization: `Bearer ${p}`, 'Content-Type': 'application/json' };
};

// 每次运行一套独立 id：去重窗口是 60s，跨次运行复用同 (mini, product, category) 会让
// 用例 1 因「读到上一轮的残留行」而误判 duplicate ⇒ 假红。用 run 唯一 id 天然规避。
const RUN = Date.now().toString(36);
const MINI = `rep-mini-${RUN}`;
const H = mkMini(MINI);
const P = (n: string) => `rep-${n}-${RUN}`;

const post = (body: unknown, headers: Record<string, string> = H) =>
  wenlvRoute.request('/report', { method: 'POST', headers, body: JSON.stringify(body) });

/** 本 run 的上报行数（按 miniUserId 收敛，不依赖 productId 形状）。 */
const countRows = async () => {
  const rows = await db.select().from(pmsBuiWenlvClientReports)
    .where(eq(pmsBuiWenlvClientReports.miniUserId, MINI));
  return rows.length;
};
const findRow = async (productId: string, category: string) => {
  const rows = await db.select().from(pmsBuiWenlvClientReports)
    .where(eq(pmsBuiWenlvClientReports.miniUserId, MINI));
  return rows.find((r) => r.productId === productId && r.category === category);
};

describe('wenlv mini 现场问题上报（DB）', () => {
  beforeAll(async () => {
    // 理论上 run 唯一 id 已保证无残留，仍清一次以吸收「同一 run 内重跑」的极端情形
    await db.delete(pmsBuiWenlvClientReports).where(eq(pmsBuiWenlvClientReports.miniUserId, MINI));
  });

  afterAll(async () => {
    await db.delete(pmsBuiWenlvClientReports).where(eq(pmsBuiWenlvClientReports.miniUserId, MINI));
    // 红线：票券旁路 env 绝不外泄到同 worker 的后继测试文件，更绝不进任何部署配置。
    delete process.env.WENLV_BYPASS_TICKET;
  });

  // 用例 1
  it('已登录 + 合法 category ⇒ 200 落库，productId/miniUserId/category/source 正确', async () => {
    const before = await countRows();
    const res = await post({ productId: P('p1'), category: 'audio', source: 'auto', note: '环境音没声' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.duplicate).toBe(false);
    expect(await countRows()).toBe(before + 1);

    const row = await findRow(P('p1'), 'audio');
    expect(row).toBeTruthy();
    expect(row!.productId).toBe(P('p1'));
    expect(row!.miniUserId).toBe(MINI);
    expect(row!.category).toBe('audio');
    // 请求体显式带 source:'auto' ⇒ 落库必须是 'auto'。⚠️ 这条**单独不能**证明 source 被透传
    // （排除式实现缺省也落 'auto'，会碰巧撞上）—— 真正的判据是用例 8。
    expect(row!.source).toBe('auto');
    expect(row!.platform).toBe('h5');
  });

  // 用例 2
  it('未登录 ⇒ 401', async () => {
    const res = await wenlvRoute.request('/report', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ productId: P('p2'), category: 'audio' }),
    });
    expect(res.status).toBe(401);
    const b = await res.json();
    expect(b.success).toBe(false);
  });

  // 用例 3 —— 本端点最重要的语义判据（E4：登录即可、不需门票）
  it('不需要门票（E4）：删掉票券旁路 env 后同一请求仍 200（证明未挂 assertTicket）', async () => {
    const prev = process.env.WENLV_BYPASS_TICKET;
    delete process.env.WENLV_BYPASS_TICKET;
    try {
      const res = await post({ productId: P('p3'), category: 'audio' });
      // 挂了 assertTicket ⇒ bypass 失效 ⇒ checkTicket 跨服务 fail-closed 403
      expect(res.status).toBe(200);
    } finally {
      if (prev === undefined) delete process.env.WENLV_BYPASS_TICKET;
      else process.env.WENLV_BYPASS_TICKET = prev;
    }
  });

  // 用例 4
  it('未知 category 归 other（不 400，宁可存糙也不丢反馈）', async () => {
    const res = await post({ productId: P('p4'), category: 'weird' });
    expect(res.status).toBe(200);
    const b = await res.json();
    expect(b.success).toBe(true);
    expect(b.data.duplicate).toBe(false);
    const row = await findRow(P('p4'), 'other');
    expect(row).toBeTruthy();
    expect(row!.category).toBe('other');
  });

  // 用例 5
  it('缺 productId ⇒ 400；超长 productId（51 字符）⇒ 400 且库里不新增行', async () => {
    const miss = await post({ category: 'audio' });
    expect(miss.status).toBe(400);
    expect((await miss.json()).success).toBe(false);

    const before = await countRows();
    const long = await post({ productId: 'p'.repeat(51), category: 'audio' });
    // 长度闸必须**挂在 INSERT 之前**：靠数据库 varchar(50) 报错兜底会走到全局错误处理返 500，
    // 而这条路恰恰是「出了问题才走」的路 —— 上报端点在这里 500 等于安全网自己先断。
    expect(long.status).toBe(400);
    expect(await countRows()).toBe(before);
  });

  // 用例 6
  it('60 秒去重（E6）：同 product+category 连发第二条不新增行、返 duplicate:true；换类别则新增', async () => {
    const first = await post({ productId: P('p6'), category: 'cert' });
    expect(first.status).toBe(200);
    expect((await first.json()).data.duplicate).toBe(false);
    const afterFirst = await countRows();

    const second = await post({ productId: P('p6'), category: 'cert' });
    expect(second.status).toBe(200);
    const b2 = await second.json();
    expect(b2.success).toBe(true);
    expect(b2.data.duplicate).toBe(true);
    expect(await countRows()).toBe(afterFirst); // 不新增行

    const other = await post({ productId: P('p6'), category: 'image' });
    expect(other.status).toBe(200);
    expect((await other.json()).data.duplicate).toBe(false);
    expect(await countRows()).toBe(afterFirst + 1); // 类别不同 ⇒ 不算重复
  });

  // 用例 7
  it('不要求产品存在：productId 指向不存在的剧本仍 200（剧本被删后恰恰最需要上报）', async () => {
    const before = await countRows();
    const res = await post({ productId: `rep-ghost-${RUN}`, category: 'other' });
    expect(res.status).toBe(200);
    expect((await res.json()).data.duplicate).toBe(false);
    expect(await countRows()).toBe(before + 1);
  });

  // 用例 8 —— source 列的**唯一**判据。
  // 没有它，Task 3/4 漏传 source 时整列恒为单值而所有用例照旧全绿（原稿就是漏的）。
  it('source 真的被透传：auto ⇒ auto、manual ⇒ manual、省略 ⇒ manual（与 DDL 默认值一致）', async () => {
    const auto = await post({ productId: P('p8'), category: 'audio', source: 'auto' });
    expect(auto.status).toBe(200);
    expect((await findRow(P('p8'), 'audio'))!.source).toBe('auto');

    const manual = await post({ productId: P('p8'), category: 'image', source: 'manual' });
    expect(manual.status).toBe(200);
    expect((await findRow(P('p8'), 'image'))!.source).toBe('manual');

    // 省略 ⇒ 必须与建表 DDL 的 `DEFAULT 'manual'` 一致。
    // 原稿是 `body?.source === 'manual' ? 'manual' : 'auto'`（排除式、缺省落 'auto'）：既与 DDL 相反，
    // 又让 'Manual' 这类大小写走样被静默记成自动上报。
    const omitted = await post({ productId: P('p8'), category: 'cert' });
    expect(omitted.status).toBe(200);
    expect((await findRow(P('p8'), 'cert'))!.source).toBe('manual');
  });

  // 用例 9
  it('超长 nodeId（51 字符）降级成 null，但上报不丢（≠ productId 的 400，这是有意的）', async () => {
    const before = await countRows();
    const res = await post({ productId: P('p9'), category: 'image', nodeId: 'n'.repeat(51) });
    expect(res.status).toBe(200);
    expect((await res.json()).data.duplicate).toBe(false);
    expect(await countRows()).toBe(before + 1);
    const row = await findRow(P('p9'), 'image');
    expect(row).toBeTruthy();
    expect(row!.nodeId).toBeNull();
  });

  // 用例 10
  it('超大 detail（JSON > 2000 字符）被丢弃成 {}，但上报不丢', async () => {
    const before = await countRows();
    const big = { blob: 'x'.repeat(2500) };
    expect(JSON.stringify(big).length).toBeGreaterThan(2000);
    const res = await post({ productId: P('p10'), category: 'other', detail: big });
    expect(res.status).toBe(200);
    expect((await res.json()).data.duplicate).toBe(false);
    expect(await countRows()).toBe(before + 1);
    const row = await findRow(P('p10'), 'other');
    expect(row).toBeTruthy();
    expect(row!.detail).toEqual({});
  });
});
