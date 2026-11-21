// 验证：工作台 tab 替换拍摄打卡 + 打卡卡片跳拍摄打卡 + task-list 返回按钮
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
page.on('pageerror', e => console.log('  ⚠️ pageerror:', e.message.slice(0, 120)));

// 兜底先注册（specific 覆盖）
page.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [], summary: [] }) }));
page.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stats: {} }) }));
page.route('**/api/orders*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [], orders: [] }) }));
page.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/assets/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
page.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) }));

// 1. 工作台 tab（tabBar 第 2 位）
await page.goto(`${BASE}/#/pages/index/index`);
await page.waitForTimeout(6000);
const bodyText = await page.evaluate(() => document.body.innerText);
const tabLabels = ['AI 助手', '工作台', '房态', '订单', '我的'];
console.log('页面含 tab 标签:', JSON.stringify(tabLabels.filter(l => (bodyText || '').includes(l))));
check('tabBar 显示 5 个 tab', tabLabels.every(l => (bodyText || '').includes(l)));
check('tabBar 含工作台', (bodyText || '').includes('工作台'));
// 系统原生 tabBar 的 DOM
const nativeTab = await page.evaluate(() => document.querySelectorAll('.uni-tabbar, .uni-tabbar__item, .t-tabbar').length);
check('系统原生 tabBar 渲染', nativeTab > 0);

// 2. 工作台打卡卡片 → 拍摄打卡（navigateTo）
console.log('== 打卡卡片跳转 ==');
await page.getByText('今日素材打卡').first().click();
await page.waitForTimeout(4000);
console.log('点击后 URL:', page.url());
check('跳转到拍摄打卡 task-list', page.url().includes('pages/assets/task-list'));
// 3. task-list 有返回按钮
const hasBack = await page.evaluate(() => !!document.querySelector('.ph-back'));
check('task-list 有返回按钮', hasBack);
// 4. 返回工作台
if (hasBack) {
  await page.locator('.ph-back').click();
  await page.waitForTimeout(3000);
  console.log('返回后 URL:', page.url());
  check('返回按钮回到工作台', page.url().includes('pages/index/index'));
}

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
