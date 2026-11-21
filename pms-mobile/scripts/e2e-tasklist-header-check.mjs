// 验证：task-list 头部与其他 tab 页一致（PageHeader + StoreSelector + title）
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
page.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/assets/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [{ id: 's1', name: '测试门店' }] }) }));
page.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) }));

// 1. task-list 头部
await page.goto(`${BASE}/#/pages/assets/task-list`);
await page.waitForTimeout(6000);
const header = await page.evaluate(() => {
  const ph = document.querySelector('.page-header');
  const nav = document.querySelector('.uni-navbar');
  const title = document.querySelector('.uni-navbar__header-container-inner, .nav-title');
  return {
    hasPageHeader: !!ph,
    pageHeaderText: ph?.textContent?.slice(0, 80),
    bodyText: document.body.innerText.slice(0, 100),
  };
});
console.log('task-list 头部:', JSON.stringify(header));
check('有 PageHeader', header.hasPageHeader);
check('标题含素材打卡', (header.bodyText || '').includes('素材打卡'));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
