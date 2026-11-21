// 诊断：orders 页底部 TabBar 布局是否变形（对比 task-list）
import { chromium } from 'playwright';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = 'http://localhost:8081';

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => console.log('[pageerror]', e.message.slice(0, 120)));

// 精确 mock（无兜底，避免干扰）
page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
page.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/assets/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [] }) }));
page.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
page.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) }));
page.route('**/api/orders*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ orders: [], list: [], stats: { total: 0 } }) }));

async function inspectTabBar(label) {
  const info = await page.evaluate(() => {
    // 找 TabBar.vue 渲染的底部导航 .tab-bar（position:fixed; bottom:0）
    const all = document.querySelectorAll('.app-tab-bar');
    const bottomBar = Array.from(all).find(el => getComputedStyle(el).position === 'fixed');
    if (!bottomBar) return { found: false, allTabBars: all.length };
    const r = bottomBar.getBoundingClientRect();
    const cs = getComputedStyle(bottomBar);
    const items = bottomBar.querySelectorAll('.tab-item');
    return {
      found: true,
      rect: { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) },
      style: { position: cs.position, zIndex: cs.zIndex, display: cs.display, height: cs.height },
      itemCount: items.length,
      itemWidths: Array.from(items).map(el => Math.round(el.getBoundingClientRect().width)),
      activeText: Array.from(items).find(el => el.className.includes('active'))?.textContent?.trim(),
    };
  });
  console.log(`${label}:`, JSON.stringify(info));
  return info;
}

// 1. task-list 页（基准）
await page.goto(`${BASE}/#/pages/assets/task-list`);
await page.waitForTimeout(6000);
const taskListBar = await inspectTabBar('task-list 页底部导航');

// 2. orders 页
await page.goto(`${BASE}/#/pages/orders/index`);
await page.waitForTimeout(6000);
console.log('orders URL:', page.url());
const ordersBar = await inspectTabBar('orders 页底部导航');

// 3. 检查 orders 页是否有多个 .tab-bar（可能被头部筛选影响）
const ordersTabBars = await page.evaluate(() => Array.from(document.querySelectorAll('.app-tab-bar')).map(el => ({
  pos: getComputedStyle(el).position,
  cls: el.className,
  text: el.textContent?.slice(0, 30),
})));
console.log('orders 页所有 .tab-bar:', JSON.stringify(ordersTabBars, null, 2));

await browser.close();
