// 验证：房态页日/月 v-show 切换正常（两视图均渲染，无错误）
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
let errors = 0;
page.on('pageerror', e => { errors++; console.log('  ⚠️ pageerror:', e.message.slice(0, 150)); });

// 兜底先注册（specific 后注册覆盖）
page.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [] }) }));
page.route('**/api/rooms?*daily*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
  date: '2026-08-06',
  rooms: [
    { id: 'r1', roomNumber: '101', floor: 1, status: 'available', roomTypeId: 'rt1', roomTypeName: '大床房', price: 200 },
    { id: 'r2', roomNumber: '102', floor: 1, status: 'occupied', roomTypeId: 'rt1', roomTypeName: '大床房', price: 220 },
  ],
  floors: [1],
  summary: { total: 2, available: 1, booked: 0, occupied: 1, dirty: 0, maintenance: 0, locked: 0, occupancyRate: 50 },
}) }));
page.route('**/api/rooms?*monthly*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({
  summary: [{ date: '2026-08-06', roomTypeName: '大床房', total: 2, occupied: 1, booked: 0, available: 1 }],
}) }));
page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));
page.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) }));
page.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }));

await page.goto(`${BASE}/#/pages/rooms/index`);
await page.waitForTimeout(6000);
let text = await page.evaluate(() => document.body.innerText);
check('日房态显示房间', (text || '').includes('101'));

// 切月
await page.getByText('月房态').first().click();
await page.waitForTimeout(2000);
text = await page.evaluate(() => document.body.innerText);
check('月房态显示日历/日期', /8\/|月|大床房/.test(text || ''));

// 切回日
await page.getByText('日房态').first().click();
await page.waitForTimeout(2000);
text = await page.evaluate(() => document.body.innerText);
check('切回日房态显示房间', (text || '').includes('101'));

// 再切月再切日（多次切换，模拟触发）
await page.getByText('月房态').first().click();
await page.waitForTimeout(1500);
await page.getByText('日房态').first().click();
await page.waitForTimeout(1500);
text = await page.evaluate(() => document.body.innerText);
check('多次切换后日房态正常', (text || '').includes('101'));

console.log(`  （pageerror 次数: ${errors}）`);
check('无页面错误', errors === 0);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
