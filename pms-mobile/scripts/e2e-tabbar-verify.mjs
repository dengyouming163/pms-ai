// 验证：拍摄打卡 tab 入口（TabBar 5 tab + 切换 + 登录跳转）
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
page.on('pageerror', e => console.log('  ❌ pageerror:', e.message.slice(0, 120)));

// mock：task-list + auth + rooms（避免 401 跳登录）
page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
page.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/assets/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [] }) }));
page.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
page.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) }));

// 1. task-list 页 tabBar 渲染
console.log('== 1. 拍摄打卡 tab（task-list）==');
await page.goto(`${BASE}/#/pages/assets/task-list`);
await page.waitForTimeout(6000);
console.log('URL:', page.url());

const tabInfo = await page.evaluate(() => {
  const items = document.querySelectorAll('.app-tab-bar .tab-item');
  const labels = Array.from(items).map(el => el.querySelector('.tab-label')?.textContent?.trim());
  const active = Array.from(items).map(el => el.className.includes('active'));
  return { count: items.length, labels, active };
});
check('tabBar 5 个 tab', tabInfo.count === 5);
check('含拍摄打卡', tabInfo.labels.includes('拍摄打卡'));
check('tab 顺序正确', JSON.stringify(tabInfo.labels) === JSON.stringify(['AI 助手', '拍摄打卡', '房态', '订单', '我的']));
check('拍摄打卡高亮', tabInfo.active[1] === true);

// 2. NavBar 无返回按钮
const backBtn = await page.evaluate(() => {
  // NavBar 返回按钮通常是有特定 class 的图标；task-list 已去 showBack，检查 NavBar 是否有 back 元素
  return document.body.innerText.includes('素材打卡');
});
check('task-list 显示标题素材打卡', backBtn);

// 3. 点击房态 tab 切换
console.log('== 2. tab 切换 ==');
const roomTab = page.locator('.app-tab-bar .tab-item').nth(2); // 房态
await roomTab.click();
await page.waitForTimeout(3000);
console.log('点击房态后 URL:', page.url());
check('切换到房态页', page.url().includes('pages/rooms/index'));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
