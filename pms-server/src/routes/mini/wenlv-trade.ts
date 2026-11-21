// 文旅交易代理路由 — C 端只走这里，服务端解 miniUserId，X-Internal-Token 转发 BFF
// 玩法（打卡/答题/进度）走 /api/mini/wenlv（内容+引擎），交易（下单/订单/券）走本路由
import { Hono } from 'hono';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvVenues } from '../../db/schema/index.js';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { handleWenlvJsapi } from '../../services/wenlv-pay.js';
import { ticketPremiumOf, displayPriceWithPremium } from '../../services/wenlv/ticket-premium.js';
import { refundWenlvOrder, WenlvRefundError } from '../../services/wenlv-refund.js';
import type { ContentfulStatusCode } from 'hono/utils/http-status';
import { PLATFORM_SERVER_URL, INTERNAL_SERVICE_TOKEN } from '../../constants.js';

const route = new Hono();

/** 代理请求到 pms-platform（X-Internal-Token 头）。返回 { ok, status, data }：ok=false 表示网络/超时或 BFF 业务失败 */
async function platformFetch(path: string, options?: { method?: string; body?: any }): Promise<{ ok: boolean; status: number; data: any }> {
  let res: Response;
  try {
    res = await fetch(`${PLATFORM_SERVER_URL}${path}`, {
      method: options?.method || 'GET',
      headers: { 'X-Internal-Token': INTERNAL_SERVICE_TOKEN, 'Content-Type': 'application/json' },
      body: options?.body ? JSON.stringify(options.body) : undefined,
      signal: AbortSignal.timeout(10000),
    });
  } catch {
    // 网络不可达 / 超时：上层统一按 502 处理，不把内部异常回吐给 C 端
    return { ok: false, status: 0, data: null };
  }
  const data = await res.json().catch(() => null);
  // res.ok 校验 + 业务 success 双重判断：BFF 返回 {success:false} 也算失败，避免把上游故障伪装成空数据
  return { ok: res.ok && data?.success !== false, status: res.status, data };
}

/** 需登录端点：手动解析 C 端 JWT，未登录返 null（调用方转 401） */
function requireMiniUser(c: any): { miniUserId: string; openid: string } | null {
  return parseMiniToken(c.req.header('Authorization'));
}

/** 透传代理：BFF 成功则原样返回，失败则透传其 error 与状态码（网络/超时归为 502 中文提示） */
async function proxy(c: any, path: string, method: string, body?: any): Promise<Response> {
  const r = await platformFetch(path, { method, body });
  if (!r.ok) return c.json({ success: false, error: r.data?.error || '服务繁忙，请稍后再试' }, r.status || 502);
  return c.json(r.data);
}

// GET /api/mini/wenlv-trade/products — 可购文旅产品（价格 + 内容主题/banner 聚合，公开浏览）
route.get('/products', async (c) => {
  // 全量拉取避免默认 20 条分页静默截断，产品规模为个位数级
  const r = await platformFetch('/api/wenlv/products?status=active&pageSize=100');
  if (!r.ok) {
    const status = (r.status || 502) as ContentfulStatusCode;
    return c.json({ success: false, error: r.data?.error || '加载失败' }, status);
  }
  const list = Array.isArray(r.data?.data?.list) ? r.data.data.list : [];
  const ids = list.map((p: any) => p.contentProductId).filter(Boolean);
  let contentRows: any[] = [];
  if (ids.length) {
    contentRows = await db.select({
      id: pmsBuiWenlvProducts.id,
      mode: pmsBuiWenlvProducts.mode,
      playMode: pmsBuiWenlvProducts.playMode,
      isFree: pmsBuiWenlvProducts.isFree,
      theme: pmsBuiWenlvProducts.theme,
      config: pmsBuiWenlvProducts.config,
      coverImage: pmsBuiWenlvProducts.coverImage,
      subtitle: pmsBuiWenlvProducts.subtitle,
      // ⑤-A 增列：场地归属 + 首次上架时间。
      // ⚠️ `venueId` / `publishedAt` **必须显式增列** —— 收窄 select 漏了它，
      //    下面 `ct?.x ?? null` 会让它**静默变 null**，不报错、类型也不拦，
      //    只表现为「前端拿不到场地/排序恒等于创建时间」。
      // ⚠️ 交易侧**没有** publishedAt：`pms-platform/pms-platform-server/src/db/schema/wenlv.ts:5-18`
      //    只有 createdAt/updatedAt。上架时间只能取内容侧，别去交易表找列。
      venueId: pmsBuiWenlvProducts.venueId,
      publishedAt: pmsBuiWenlvProducts.publishedAt,
      // 过闸用：只为判 `status='published'`，**不**进响应对象（见下面的显式对象字面量）
      status: pmsBuiWenlvProducts.status,
    }).from(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, ids));
  }
  const contentMap = new Map(contentRows.map((row) => [row.id, row]));
  // 场地批查（**一次**查齐，不许逐条查 —— 那是 N+1）：
  // 下游既要 `venueName`（展示）也要 `status`（过闸），所以两列都投影。
  const venueIds = [...new Set(contentRows.map((r) => r.venueId).filter((x): x is string => !!x))];
  const venueRows = venueIds.length
    ? await db.select({
        id: pmsBuiWenlvVenues.id,
        name: pmsBuiWenlvVenues.name,
        status: pmsBuiWenlvVenues.status,
      }).from(pmsBuiWenlvVenues).where(inArray(pmsBuiWenlvVenues.id, venueIds))
    : [];
  const venueMap = new Map(venueRows.map((r) => [r.id, r]));
  const merged = list.map((p: any) => {
    const ct = contentMap.get(p.contentProductId);
    return {
      productId: p.id,                          // BFF 交易产品 UUID（下单用）
      contentProductId: p.contentProductId,     // 内容产品 id（详情/玩用）
      name: p.name,
      // 🔴 `isFree`（内容产品行 `pms_bui_wenlv_products`）与 `price`/`originalPrice`（交易产品行）
      //    是**两根独立的轴**：标免费**不会**自动清零交易侧的价格 —— 平台侧写入口仍要求真价格 > 0
      //    （`pms-platform/pms-platform-server/src/routes/wenlv.ts:92` 的
      //    `price: z.number().positive('价格必须大于 0')`，本 Task 不动它）⇒ 库里必然躺着一个
      //    正数价格，照原值渲染就会出「主按钮说免费、价格区报真价」。
      //    本行是**读路径**（显示）的处置，与**写路径**的 400 守卫（本文件 POST /orders 那段
      //    「该剧本免费游玩，无需购买」）是两件事 —— 后者拦「误付」的下单，不负责显示。
      // 🔴 改这里的值**改不动服务端收的钱**：POST /orders 用显式白名单重建 body
      //    （`{ productId, packageId, quantity, slotId, miniUserId }`，见本文件下方），
      //    载荷里**没有金额**；C 端 `pms-nimi/src/pages/wenlv/booking.vue` 的
      //    `unitPrice`/`totalAmount` 只喂显示，提交只带 id ⇒ 金额权威在平台侧。
      // 🔴 `'0.00'` 而非 `0`：`p.price` 这个**值**未经解析地透传（本投影是显式键集重建、非整对象转发），而平台 `price` 列是
      //    `decimal(10,2)`、经 drizzle 出来是**字符串**（端面 `api/modules/wenlv.ts` 的
      //    `getWenlvProducts` 再 `Number()` 归一）⇒ 保持字符串，与 `p.price` 同形。
      // 🔴 `price` 这个键**必须保留**：响应键集合是白名单，`wenlv-trade-products.db.test.ts`
      //    钉住了整个键集（删键会红）。
      // 🔴 Task 11 剧本房溢价：展示价 = 票价 + config.premium（存内容产品 config jsonb，
      //    本行上面已 select config）。premium 缺省/非法按 0 处理 ⇒ 付费行原样透传。
      //    ✅ 收款口径已一致化（Task 11 收口）：POST /orders 代理把本层算出的 premium
      //    随白名单 body 下传 BFF，BFF 收款价 = 票价 + premium（同尺两位小数）——
      //    展示与收款逐分一致。免费行优先级更高：仍投影 '0.00'（免费单在本文件
      //    POST /orders 守卫处直接 400，本就不会产生收款）。
      price: ct?.isFree ? '0.00' : displayPriceWithPremium(p.price, ticketPremiumOf(ct?.config)),
      originalPrice: ct?.isFree ? null : (p.originalPrice ?? null),
      validDays: p.validDays,
      coverImage: ct?.coverImage ?? null,
      subtitle: ct?.subtitle ?? null,
      theme: ct?.theme ?? null,
      config: ct?.config ?? null,
      mode: ct?.mode ?? 'narrative',                  // 集章 rally / 剧情 narrative（内容权威；旧行缺省归叙事）
      playMode: ct?.playMode ?? 'solo',   // 旧行缺省归单人：存量剧本都是随到随玩的模型
      // 🔴 默认值方向是**故意的**：`?? false` = 查不到内容行时按**付费**处理。
      //    与本片所有其它默认值同向 —— 拿不准就收紧付费墙，绝不默认免费。
      isFree: ct?.isFree ?? false,
      venueId: ct?.venueId ?? null,
      // 🔴 用 `ct?.venueId` 而不是 `p.venueId`：交易侧根本没有场地字段，
      //    权威只有内容侧一处。查不到场地（或场地行已删）⇒ null。
      venueName: (ct?.venueId ? venueMap.get(ct.venueId)?.name : null) ?? null,
      publishedAt: ct?.publishedAt ?? null,
    };
  });
  // 🔴 三件齐备闸（架构 spec §5.5）：内容行存在且 `published`、场地存在且 `live`、交易 `active`。
  //    交易那一条**不在本层判** —— 它在出站 URL 的 `status=active` 上（BFF 是交易层的权威）。
  //
  // 🔴 判据必须落在**合并之后**，不能只写进上面 `inArray` 的 where：
  //    where 只让 `contentMap` 少一行，而 `merged` 里的 `ct?.x ?? 默认值` 会把
  //    「没有内容行」渲染成一条**带默认值的产品** —— 那正是要被挡掉的东西。
  const visible = merged.filter((m: any) => {
    const ct = contentMap.get(m.contentProductId);
    if (!ct || ct.status !== 'published') return false;     // 内容行必须存在且已发布（deleted 是软删除，一并挡掉）
    if (!ct.venueId) return false;                          // 无场地 = 游客买了不知道去哪玩
    return venueMap.get(ct.venueId)?.status === 'live';     // 场地必须已运营
  });
  // 排序（⑤-A 决策 3：按上架时间倒序）。
  // 🔴 排序键是**首次**上架时间：写入口是 `pms-server/src/routes/admin/wenlv.ts:1477` 的
  //    `publishedAt: product.publishedAt ?? new Date()`（`??=` 语义：下架后重上**不**刷新）。
  //    而那个写入口是**后来才补的** —— `pms-server/src/services/wenlv-delivery.ts:115` 写明
  //    「本 Task 之前全仓没有任何地方写过 publishedAt，所以线上真实存在一批」无章的存量行。
  //    ⇒ 存量集上，这个排序**退化为按 createdAt 倒序**。这不是缺陷（`status` 才是权威），
  //      但上线前必须量给运营看（设计 §6.3 第 4 项）。
  const tradeById = new Map<any, any>(list.map((p: any) => [p.id, p]));  // 类型实参不可省：`list` 是 `any` ⇒ `new Map(any)` 推成 `Map<{}, {}>`，下面 `.createdAt` 会 TS2339
  const stamp = (m: any): number | null => (m.publishedAt && Number.isFinite(new Date(m.publishedAt).getTime()) ? new Date(m.publishedAt).getTime() : null);  // 不可解析 ⇒ NaN；NaN !== null 会被当「有章」而永不沉底 ⇒ 归一成 null
  const sorted = [...visible].sort((a: any, b: any) => {
    const x = stamp(a);
    const y = stamp(b);
    if (x !== null && y !== null && x !== y) return y - x;   // 都有章：降序
    if (x === null && y !== null) return 1;                   // 缺章的沉底
    if (x !== null && y === null) return -1;
    // 同章（含并列缺章）：交易侧 createdAt 降序。
    // 🔴 这一句**必须显式写出来**，不能靠「V8 的 sort 是稳定的」：
    //    稳定性只保证「同键保持输入序」，而输入序来自 BFF 的 createdAt —— 不写这一句，
    //    哪天 BFF 换了 ORDER BY，首屏顺序就跟着漂（夹具 e 组同章、桩序与期望序相反 ⇒ 改坏这条会红）。
    const at = new Date(tradeById.get(a.productId)?.createdAt ?? 0).getTime();
    const bt = new Date(tradeById.get(b.productId)?.createdAt ?? 0).getTime();
    return bt - at;
  });
  return c.json({ success: true, data: { list: sorted, total: sorted.length } });
});

// GET /api/mini/wenlv-trade/slots?productId=<uuid> — 可选场次与余位（与 /products 同口径）
// from 由服务端固定为「现在」：C 端只该看到还能订的场次。把过去时刻的过滤放在服务端，
// 避免前端各页面各写一份过滤条件 —— 写歪了就是把过期场次卖给游客。
route.get('/slots', async (c) => {
  const productId = c.req.query('productId');
  if (!productId) return c.json({ success: false, error: '参数错误' }, 400);
  const from = new Date().toISOString();
  return proxy(c, `/api/wenlv/slots?productId=${encodeURIComponent(productId)}&from=${encodeURIComponent(from)}`, 'GET');
});

// GET /api/mini/wenlv-trade/packages — 可售套餐列表（含明细）
// 🔴 **不透传 `includeUnavailable`**：那一档是给运营看全量的，C 端恒取服务端默认（只可售）。
//    透传 query 会把运营开关漏给 C 端 —— 默认值由服务端定，不由调用方定。
// 鉴权：本路径在 `middleware/mini-auth.ts` 的 `MINI_PUBLIC_PREFIXES`（`/api/mini/wenlv-trade`）里 ⇒ 免登录可达。
//    与 `/products`、`/slots` 同档：**列表本身不需要知道你是谁**（下单才需要）。
route.get('/packages', async (c) => {
  return proxy(c, '/api/wenlv/packages', 'GET');
});

// POST /api/mini/wenlv-trade/orders — 下单（服务端解 miniUserId，防 IDOR）
// slotId 仅透传，**不**在 pms-server 判「这个产品要不要场次」—— 那是交易层的产品属性，
// 在这里再判一次会造出第二个权威，两边不一致时以谁为准就没有答案了。
route.post('/orders', async (c) => {
  const miniUser = requireMiniUser(c);
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const quantity = Math.max(1, Number(body.quantity) || 1);
  const slotId = typeof body.slotId === 'string' && body.slotId ? body.slotId : null;
  // 🔴 显式白名单重建 body：**不 spread `...body`**。理由同上方的 slotId 那段 ——
  //    C 端传来的字段一概不可信（尤其 `miniUserId` 必须由本层解析覆盖，防 IDOR）。
  // ⚠️ `productId` 与 `packageId` 在这里**都不判**「该不该有」：二选一是交易层的契约
  //    （createOrderSchema 的 XOR），在这里再判一次就是第二个权威。两者都为 undefined 时会被
  //    `JSON.stringify` 丢掉（body 里还剩 `quantity` / `slotId` / `miniUserId`）；上游收到的 body 里**没有这两个键** ⇒ 由 createOrderSchema 回「产品与套餐必须二选一」。
  // 🔴 免费剧本的单品下单守卫：**防用户误付**，不是防平台白送。
  //
  // 免费剧本仍须有一个 active 的交易产品（首页/探秘页/场地页全部由这条列表驱动 ——
  // 没有交易产品就不出现在任何列表，引流无从谈起），而价格护栏 `positive()` 三处一律不动
  // ⇒ 库里必然躺着一个真价格、前端却显示「免费」。用户若从某个未隐藏的入口点进来，
  // 就会**花钱买一个本来免费的东西**。本守卫是那条路的兜底。
  //
  // ⚠️ 只管单品路（`productId`）：套餐里搭一个免费剧本作赠品是**合法商业构造**，
  //    拦掉它是错的。别为了「对称」把 `packageId` 也拦上。
  // ⚠️ C 端给的是**交易产品 id**，不是 contentProductId ⇒ 必须解析一次。
  //    解析走的就是本文件 GET /products 那条已有的列表接口（同一上游、同一契约），
  //    不新增跨服务依赖。
  // 🔴 Task 11 收口：premium 的权威在内容库 config jsonb（平台交易表没有这根轴），
  //    收款侧（BFF POST /orders）拿不到 ⇒ 由**本层**从内容行算出后随白名单 body 下传。
  //    钳制（缺省/非法/负值回 0）在 ticketPremiumOf；BFF 端 sanitizeOrderPremium 再独立兜一次。
  //    只在**单卖分支**算：套餐价是独立 SKU 定价，展示侧不合成溢价，收款侧同样不合成
  //    （套餐单照传 0，BFF 套餐分支不读它）。
  let premium = 0;
  if (typeof body.productId === 'string' && body.productId) {
    const r = await platformFetch('/api/wenlv/products?status=active&pageSize=100');
    // 信封形状与本文件 GET /products 完全一致：`r.data.data.list`（已核）
    const list = Array.isArray(r.data?.data?.list) ? r.data.data.list : [];
    const hit = list.find((p: any) => p.id === body.productId);
    if (hit?.contentProductId) {
      const [ct] = await db.select({ isFree: pmsBuiWenlvProducts.isFree, config: pmsBuiWenlvProducts.config })
        .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, hit.contentProductId)).limit(1);
      if (ct?.isFree) {
        return c.json({ success: false, error: '该剧本免费游玩，无需购买' }, 400);
      }
      if (ct) premium = ticketPremiumOf(ct.config);
    }
  }
  return proxy(c, '/api/wenlv/orders', 'POST', {
    productId: body.productId, packageId: body.packageId, quantity, slotId, miniUserId: miniUser.miniUserId,
    premium,
  });
});

// GET /api/mini/wenlv-trade/orders — 我的订单列表
route.get('/orders', async (c) => {
  const miniUser = requireMiniUser(c);
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  return proxy(c, `/api/wenlv/orders?miniUserId=${encodeURIComponent(miniUser.miniUserId)}`, 'GET');
});

// GET /api/mini/wenlv-trade/orders/:id — 订单详情（含券；带 miniUserId 供 BFF 做归属校验，防跨用户读券码）
route.get('/orders/:id', async (c) => {
  const miniUser = requireMiniUser(c);
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  const id = c.req.param('id');
  return proxy(c, `/api/wenlv/orders/${id}?miniUserId=${encodeURIComponent(miniUser.miniUserId)}`, 'GET');
});

// POST /api/mini/wenlv-trade/orders/:id/pay — 调起微信支付（服务端取价，miniUser 由本层已解析）
route.post('/orders/:id/pay', async (c) => {
  const miniUser = requireMiniUser(c);
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  return handleWenlvJsapi(c, c.req.param('id'), miniUser);
});

// POST /api/mini/wenlv-trade/orders/:id/reschedule — 换场次（同产品、免差价）
// 与 /orders 下单同一条纪律：miniUserId 由**本层**解析并覆盖，绝不透传 C 端传来的身份（防 IDOR）。
route.post('/orders/:id/reschedule', async (c) => {
  const miniUser = requireMiniUser(c);
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const slotId = typeof body.slotId === 'string' && body.slotId ? body.slotId : null;
  if (!slotId) return c.json({ success: false, error: '参数错误' }, 400);
  return proxy(c, `/api/wenlv/orders/${c.req.param('id')}/reschedule`, 'POST', { slotId, miniUserId: miniUser.miniUserId });
});

// GET /api/mini/wenlv-trade/tickets — 我的券列表（券码/核销码）
route.get('/tickets', async (c) => {
  const miniUser = requireMiniUser(c);
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  return proxy(c, `/api/wenlv/tickets?miniUserId=${encodeURIComponent(miniUser.miniUserId)}`, 'GET');
});

// 申请退款（C 端自助）：整单退，资格校验在服务端（券状态 + 游玩进度）
route.post('/orders/:id/refund', async (c) => {
  const u = requireMiniUser(c);
  if (!u) return c.json({ success: false, error: '未登录' }, 401);
  const body = await c.req.json().catch(() => ({}));
  const reason = String((body as any).reason || '').trim() || '用户申请退款';
  try {
    const r = await refundWenlvOrder(c.req.param('id'), { miniUserId: u.miniUserId, reason });
    return c.json({ success: true, data: r });
  } catch (e: any) {
    if (e instanceof WenlvRefundError) return c.json({ success: false, error: e.message }, e.status as 400);
    console.error('[wenlv-trade] 退款异常', e);
    return c.json({ success: false, error: '退款失败，请稍后重试' }, 500);
  }
});

export default route;
