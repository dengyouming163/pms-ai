// 验证：工作台 PageHeader 头部（StoreSelector + 标题"工作台"）与其他 tab 页一致
import { chromium } from 'playwright';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = 'http://localhost:8083';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => console.log('  ⚠️ pageerror:', e.message.slice(0, 150)));

page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
page.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ stats: {} }) }));
page.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [], summary: [] }) }));
page.route('**/api/orders*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [], orders: [] }) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [{ id: 's1', name: '测试门店' }] }) }));
page.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) }));

// 1. 工作台头部
await page.goto(`${BASE}/#/pages/index/index`);
await page.waitForTimeout(6000);
const header = await page.evaluate(() => {
  const ph = document.querySelector('.page-header');
  const body = document.body.innerText;
  return {
    hasPageHeader: !!ph,
    headerText: ph?.textContent?.slice(0, 60),
    bodyHasWorkbench: (body || '').includes('工作台'),
    bodyHasStore: (body || '').includes('请选择门店') || (body || '').includes('测试门店'),
  };
});
console.log('工作台头部:', JSON.stringify(header));
check('有 PageHeader', header.hasPageHeader);
check('标题含工作台', header.headerText?.includes('工作台'));
check('含门店选择器', header.bodyHasStore);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
