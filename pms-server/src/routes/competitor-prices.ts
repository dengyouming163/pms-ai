import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiCompetitorConfig, pmsBuiCompetitorSnapshots, pmsBuiRoomTypes } from '../db/schema/index.js';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { crawlAllCompetitors } from '../services/competitor-crawler.js';
import { findCorruptedTextFields } from '../lib/text-integrity.js';

/** 400 文案里给运营看的字段名。漏映射的字段回落到英文键，不会静默丢字段。 */
const FIELD_LABELS: Record<string, string> = {
  hotelName: '酒店名称', platform: '平台', platformHotelId: '平台酒店ID',
  platformUrl: '链接', competitorRoomType: '竞品房型',
};

const route = new Hono();

// GET /api/competitor-prices — 获取竞品配置列表
route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const list = await db.select().from(pmsBuiCompetitorConfig)
    .where(and(...tenantWhere(scope, pmsBuiCompetitorConfig)))
    .orderBy(pmsBuiCompetitorConfig.platform);
  return c.json({ success: true, data: list });
});

// POST /api/competitor-prices — 添加竞品配置
route.post('/', async (c) => {
  const body = await c.req.json();

  // 编码损坏的入参在这里变成响亮的 400，而不是静默落库。
  // 放在 getTenantScope **之前**：这是最便宜的检查，且不依赖租户身份 ——
  // 顺带让这条拒绝路径成为 DB-free 可测的（见 src/routes/__tests__/competitor-prices.test.ts）。
  // 为什么闸打在这几个**文本**字段上：这是本表全部文本列的唯一写入口（其余 update 只写
  // lastPrice/lastCrawledAt）。生产已有 4 行 hotel_name/platform/competitor_room_type
  // 是这个形状 —— 客户端送来的 GBK 字节被 `c.req.json()` 非致命解码成 U+FFFD 后入库。
  // ⚠️ 只拒「已损坏」，空串与正常中文照旧放行（前端三个非必填字段就是送空串的）。
  const corrupted = findCorruptedTextFields(body);
  if (corrupted.length) {
    const names = corrupted.map((k) => FIELD_LABELS[k] ?? k).join('、');
    return c.json({ success: false, error: `「${names}」含无法识别的字符（编码损坏），请重新输入` }, 400);
  }

  const scope = getTenantScope(c);
  const id = `comp_${Date.now()}`;
  await db.insert(pmsBuiCompetitorConfig).values({
    id, merchantId: scope.merchantId, storeId: scope.storeId !== '*' ? scope.storeId : null,
    hotelName: body.hotelName, platform: body.platform,
    platformHotelId: body.platformHotelId, platformUrl: body.platformUrl,
    ourRoomTypeId: body.ourRoomTypeId, competitorRoomType: body.competitorRoomType,
    status: 'active',
  } as any);
  return c.json({ success: true, data: { id } });
});

// POST /api/competitor-prices/crawl — 触发爬取
route.post('/crawl', async (c) => {
  const scope = getTenantScope(c);
  const configs = await db.select().from(pmsBuiCompetitorConfig)
    .where(and(...tenantWhere(scope, pmsBuiCompetitorConfig), eq(pmsBuiCompetitorConfig.status, 'active')));

  const results = await crawlAllCompetitors(configs.map(cfg => ({
    id: cfg.id, platform: cfg.platform,
    platformHotelId: cfg.platformHotelId || '', competitorRoomType: cfg.competitorRoomType || '',
  })));

  // 保存爬取结果
  let saved = 0;
  for (const r of results) {
    if (r.result?.price) {
      await db.insert(pmsBuiCompetitorSnapshots).values({
        id: `snap_${Date.now()}_${r.competitorId}`,
        competitorId: r.competitorId, price: r.result.price,
        source: r.result.source,
      } as any);
      await db.update(pmsBuiCompetitorConfig).set({
        lastPrice: r.result.price, lastCrawledAt: new Date(),
      } as any).where(eq(pmsBuiCompetitorConfig.id, r.competitorId));
      saved++;
    }
  }
  return c.json({ success: true, data: { total: results.length, saved, results: results.filter(r => r.result).map(r => ({ competitorId: r.competitorId, price: r.result!.price })) } });
});

// GET /api/competitor-prices/:id/history — 价格历史
route.get('/:id/history', async (c) => {
  const id = c.req.param('id');
  const snapshots = await db.select().from(pmsBuiCompetitorSnapshots)
    .where(eq(pmsBuiCompetitorSnapshots.competitorId, id))
    .orderBy(desc(pmsBuiCompetitorSnapshots.crawledAt))
    .limit(30);
  return c.json({ success: true, data: snapshots.map(s => ({ price: s.price, crawledAt: s.crawledAt, source: s.source })) });
});

// POST /api/competitor-prices/delete — 删除竞品
route.post('/delete', async (c) => {
  const body = await c.req.json();
  await db.delete(pmsBuiCompetitorConfig).where(eq(pmsBuiCompetitorConfig.id, body.id));
  return c.json({ success: true });
});

// POST /api/competitor-prices/crawl-one — 单品爬取
route.post('/crawl-one', async (c) => {
  const body = await c.req.json();
  const { id, platform, platformHotelId } = body as any;
  const [config] = await db.select().from(pmsBuiCompetitorConfig).where(eq(pmsBuiCompetitorConfig.id, id));
  if (!config) return c.json({ success: false, error: '竞品不存在' }, 404);

  let price = 0;
  // 尝试爬取，失败时返回空
  try {
    if (platform === '携程') {
      const { crawlCtrip } = await import('../services/competitor-crawler.js');
      const r = await crawlCtrip(platformHotelId, config.competitorRoomType || '');
      if (r?.price) price = r.price;
    } else if (platform === '美团') {
      const { crawlMeituan } = await import('../services/competitor-crawler.js');
      const r = await crawlMeituan(platformHotelId, config.competitorRoomType || '');
      if (r?.price) price = r.price;
    } else if (platform === '飞猪') {
      const { crawlFliggy } = await import('../services/competitor-crawler.js');
      const r = await crawlFliggy(platformHotelId, config.competitorRoomType || '');
      if (r?.price) price = r.price;
    }
  } catch {}

  if (price > 0) {
    await db.update(pmsBuiCompetitorConfig).set({ lastPrice: price, lastCrawledAt: new Date() } as any).where(eq(pmsBuiCompetitorConfig.id, id));
    await db.insert(pmsBuiCompetitorSnapshots).values({ id: `snap_${Date.now()}_${id}`, competitorId: id, price, source: 'crawler' } as any);
  }
  return c.json({ success: true, data: { price } });
});

// POST /api/competitor-prices/update-price — 手动更新竞品价格
route.post('/update-price', async (c) => {
  const body = await c.req.json();
  const { id, price } = body as { id: string; price: number };
  await db.update(pmsBuiCompetitorConfig).set({
    lastPrice: price, lastCrawledAt: new Date(),
  } as any).where(eq(pmsBuiCompetitorConfig.id, id));
  // 同时记录快照
  await db.insert(pmsBuiCompetitorSnapshots).values({
    id: `snap_${Date.now()}_manual`, competitorId: id, price, source: 'manual',
  } as any);
  return c.json({ success: true, message: '价格已更新' });
});

// GET /api/competitor-prices/for-pricing — 定价引擎专用：获取当前门店所有竞品均价
route.get('/for-pricing', async (c) => {
  const scope = getTenantScope(c);
  const roomTypeId = c.req.query('roomTypeId');
  const configs = await db.select().from(pmsBuiCompetitorConfig)
    .where(and(...tenantWhere(scope, pmsBuiCompetitorConfig), eq(pmsBuiCompetitorConfig.status, 'active')));

  // 按房型聚合竞品均价
  const byRoomType: Record<string, number[]> = {};
  for (const cfg of configs) {
    if (cfg.lastPrice && cfg.ourRoomTypeId) {
      if (!byRoomType[cfg.ourRoomTypeId]) byRoomType[cfg.ourRoomTypeId] = [];
      byRoomType[cfg.ourRoomTypeId].push(cfg.lastPrice);
    }
  }

  const result: Record<string, number> = {};
  for (const [rtId, prices] of Object.entries(byRoomType)) {
    result[rtId] = Math.round(prices.reduce((a, b) => a + b, 0) / prices.length);
  }
  return c.json({ success: true, data: result, configCount: configs.length });
});

export default route;
