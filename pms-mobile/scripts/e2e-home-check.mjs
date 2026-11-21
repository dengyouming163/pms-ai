// 验证：登录后首页（工作台）正常渲染 + 打卡卡片跳转
import { chromium } from 'playwright';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = 'http://localhost:8081';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => console.log('  ❌ pageerror:', e.message.slice(0, 150)));

page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
page.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stats: { todayOrders: 5, todayRevenue: 3200, occupancy: 78 } }) }));
page.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [] }) }));
page.route('**/api/orders*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [], orders: [] }) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
page.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/assets/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));

// 1. 首页可访问（登录后 reLaunch 目标）
await page.goto(`${BASE}/#/pages/index/index`);
await page.waitForTimeout(6000);
console.log('首页 URL:', page.url());
const homeText = await page.evaluate(() => document.body.innerText.slice(0, 200));
console.log('首页文本:', JSON.stringify(homeText));
check('首页已注册可访问', page.url().includes('pages/index/index'));
check('首页显示今日素材打卡', (homeText || '').includes('今日素材打卡'));
check('首页显示快捷操作', (homeText || '').includes('快捷操作'));

// 2. 打卡卡片跳转拍摄打卡（switchTab）
console.log('== 打卡卡片跳转 ==');
const checkinCard = page.getByText('今日素材打卡').first();
await checkinCard.click();
await page.waitForTimeout(4000);
console.log('点击后 URL:', page.url());
check('打卡卡片跳转到拍摄打卡tab', page.url().includes('pages/assets/task-list'));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
