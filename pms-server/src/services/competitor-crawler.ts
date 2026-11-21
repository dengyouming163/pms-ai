/**
 * 竞品价格爬虫引擎
 * 从携程/美团/飞猪公开页面抓取酒店价格
 * 限频+轮换UA+延迟请求，降低反爬风险
 */

// 轮换 User-Agent
const UA_LIST = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Edge/120.0.0.0',
];
function randomUA() { return UA_LIST[Math.floor(Math.random() * UA_LIST.length)]; }
function sleep(ms: number) { return new Promise(r => setTimeout(r, ms)); }

interface CrawlResult { price: number; source: string; rawText: string; crawledAt: string; }

/** 爬取携程酒店价格（搜索页HTML解析） */
export async function crawlCtrip(hotelId: string, roomType: string): Promise<CrawlResult | null> {
  try {
    const url = `https://hotels.ctrip.com/hotel/${hotelId}.html`;
    const res = await fetch(url, {
      headers: { 'User-Agent': randomUA(), 'Accept': 'text/html,application/xhtml+xml', 'Accept-Language': 'zh-CN,zh;q=0.9' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // 从HTML中提取价格信息 — 携程价格通常在 script#__NEXT_DATA__ 或 data-price 属性中
    const priceMatch = html.match(/"price":\s*(\d+)/) || html.match(/data-price="(\d+)"/) || html.match(/¥(\d+)/g);
    if (!priceMatch) return null;
    const price = parseInt(priceMatch[1] || priceMatch[0]?.replace('¥','') || '0');
    if (price < 50 || price > 99999) return null;
    return { price, source: 'ctrip_crawler', rawText: priceMatch[0], crawledAt: new Date().toISOString() };
  } catch { return null; }
}

/** 爬取美团酒店价格 */
export async function crawlMeituan(hotelId: string, roomType: string): Promise<CrawlResult | null> {
  try {
    const url = `https://hotel.meituan.com/${hotelId}/`;
    const res = await fetch(url, {
      headers: { 'User-Agent': randomUA(), 'Accept': 'text/html', 'Accept-Language': 'zh-CN' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    // 美团价格标记
    const priceMatch = html.match(/"price":(\d+)/) || html.match(/<em[^>]*>(\d+)<\/em>/) || html.match(/¥(\d+)/g);
    if (!priceMatch) return null;
    const price = parseInt(priceMatch[1] || priceMatch[0]?.replace('¥','') || '0');
    if (price < 50 || price > 99999) return null;
    return { price, source: 'meituan_crawler', rawText: priceMatch[0], crawledAt: new Date().toISOString() };
  } catch { return null; }
}

/** 爬取飞猪酒店价格 */
export async function crawlFliggy(hotelId: string, roomType: string): Promise<CrawlResult | null> {
  try {
    const url = `https://hotel.fliggy.com/hotel_detail_${hotelId}.htm`;
    const res = await fetch(url, {
      headers: { 'User-Agent': randomUA(), 'Accept': 'text/html', 'Accept-Language': 'zh-CN' },
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) return null;
    const html = await res.text();
    const priceMatch = html.match(/"sellPrice":(\d+)/) || html.match(/"price":(\d+)/) || html.match(/¥(\d+)/g);
    if (!priceMatch) return null;
    const price = parseInt(priceMatch[1] || priceMatch[0]?.replace('¥','') || '0');
    if (price < 50 || price > 99999) return null;
    return { price, source: 'fliggy_crawler', rawText: priceMatch[0], crawledAt: new Date().toISOString() };
  } catch { return null; }
}

/** 爬虫调度器：对竞品配置列表执行爬取 */
export async function crawlAllCompetitors(configs: Array<{ id: string; platform: string; platformHotelId: string; competitorRoomType: string }>): Promise<Array<{ competitorId: string; result: CrawlResult | null }>> {
  const results: Array<{ competitorId: string; result: CrawlResult | null }> = [];
  for (const cfg of configs) {
    await sleep(2000 + Math.random() * 3000); // 2-5秒间隔
    let result: CrawlResult | null = null;
    if (cfg.platform === '携程') result = await crawlCtrip(cfg.platformHotelId, cfg.competitorRoomType);
    else if (cfg.platform === '美团') result = await crawlMeituan(cfg.platformHotelId, cfg.competitorRoomType);
    else if (cfg.platform === '飞猪') result = await crawlFliggy(cfg.platformHotelId, cfg.competitorRoomType);
    results.push({ competitorId: cfg.id, result });
  }
  return results;
}
