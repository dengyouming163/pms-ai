// C 端「我的订单」合并列表（住宿 / 文旅 / 套餐产品单）。**单独挂载**在 /api/mini/orders/unified，
// 理由是顺序：若把它做成 mini/orders.ts 里的 /unified，就必须声明在 `route.get('/:id')`（pms-server/src/routes/mini/orders.ts:208）之前，
// 否则 /:id 先把 /unified 吃掉（把 'unified' 当订单 id ⇒ 恒 404）。那是靠注释维持的顺序契约。
// 单独挂载 + **窄前缀先注册**（见 src/index.ts）把它变成结构。
import { Hono } from 'hono';
import { and, desc, eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiOrders, pmsBuiStores } from '../../db/schema/index.js';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { listWenlvOrders, listProductOrders } from '../../services/platform-client.js';
import { toUnifiedLodging, toUnifiedWenlv, toUnifiedProduct, sortUnified } from '../../services/order-feed.js';

const route = new Hono();

route.get('/', async (c) => {
  // 鉴权：用 parseMiniToken + 显式 401，**不是** getMiniUser —— 后者在无用户时 `throw`（拿不到 401），
  // 且本文件没有 `.use()` 挂中间件（本仓对这种情形的惯用法见 mini/wenlv.ts、mini/wenlv-trade.ts）。
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);

  // 住宿侧：本库直查（联门店名 —— 标题要用）。与 mini/orders.ts 的列表同谓词。
  const rows = await db.select({
    id: pmsBuiOrders.id, orderNo: pmsBuiOrders.orderNo, roomType: pmsBuiOrders.roomType,
    checkIn: pmsBuiOrders.checkIn, checkOut: pmsBuiOrders.checkOut, nights: pmsBuiOrders.nights,
    totalPrice: pmsBuiOrders.totalPrice, status: pmsBuiOrders.status, paymentStatus: pmsBuiOrders.paymentStatus,
    guestName: pmsBuiOrders.guestName, payDeadline: pmsBuiOrders.otaTimeout, createdAt: pmsBuiOrders.createdAt,
    storeName: pmsBuiStores.name,
  }).from(pmsBuiOrders)
    .leftJoin(pmsBuiStores, eq(pmsBuiOrders.storeId, pmsBuiStores.id))
    .where(and(eq(pmsBuiOrders.guestId, miniUser.miniUserId), eq(pmsBuiOrders.source, 'mini')))
    .orderBy(desc(pmsBuiOrders.createdAt)).limit(50);
  const lodging = rows.map((r) => toUnifiedLodging(r, r.storeName ?? null));

  // 文旅侧与套餐侧：都要经平台（内部 HTTP）。失败**不**降级成空列表 —— 那会把「平台挂了」
  // 显示成「你没有这类订单」。折中：住宿照常返回 + **按源**标记，页面据此逐源提示。
  //
  // 🔴 两个平台调用必须**并行**，且各自超时缩短到 6000：
  //    C 端闸是 10s（pms-nimi/src/api/request.ts 的 `timeout: 10000`），platformFetch 默认也是 10s。
  //    顺序 await 的最坏情形是 10 + 10 = 20s ⇒ C 端在 10s 就断开，用户看到「请求超时」
  //    而**不是**下面那句诚实的降级提示 —— 恰恰在平台慢（最需要降级）的时候降级失效。
  //    🔴 不要写成 `for` + await（那是串行，读起来像并行）。
  const TIMEOUT_MS = 6000;
  const [rw, rp] = await Promise.all([
    listWenlvOrders(miniUser.miniUserId, TIMEOUT_MS),
    listProductOrders(miniUser.miniUserId, 50, TIMEOUT_MS),
  ]);

  const degradedSources: string[] = [];
  const degradedWenlv = !(rw.ok && Array.isArray(rw.data?.data?.list));
  if (degradedWenlv) degradedSources.push('wenlv');
  const wenlv = degradedWenlv ? [] : rw.data.data.list.map(toUnifiedWenlv);

  // ⚠️ 套餐端点的信封是 `{ success, list, data }` —— list 在**顶层**，不是 data.data.list（见 platform-client.ts 的函数注释）
  const degradedProduct = !(rp.ok && Array.isArray(rp.data?.list));
  if (degradedProduct) degradedSources.push('product');
  const product = degradedProduct ? [] : rp.data.list.map(toUnifiedProduct);

  if (degradedSources.length > 0) {
    console.error('[unified-orders] 部分来源不可用，本次返回降级结果', { degradedSources, wenlvStatus: rw.status, productStatus: rp.status });
  }

  // 住宿侧是**同库直查**，不进 degradedSources：它失败即整个请求 5xx，不存在「部分成功」
  const list = sortUnified([...lodging, ...product, ...wenlv]);
  // ⚠️ 这是**窗口**不是全局分页（三个来源各带自己的窗口；跨库做不了真游标分页）。
  //    要改成分页，得先有贯穿三个来源的游标 —— 本片不做。
  return c.json({ success: true, data: {
    list, total: list.length,
    ...(degradedSources.length > 0 ? { degraded: true, degradedSources } : {}),
  } });
});

export default route;
