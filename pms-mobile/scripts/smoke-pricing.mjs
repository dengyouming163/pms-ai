// 价格管理 + 收益管家 简化页面冒烟（H5 headless）
// 前置：pnpm dev:h5 已运行
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
page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 150)));

// 种登录态（避免 401 跳登录）
await page.addInitScript(() => {
  localStorage.setItem('token', 'mock-token');
  localStorage.setItem('userInfo', JSON.stringify({ type: 'object', data: { name: '测试店长', phone: '13800000001', roleName: '店长', role: { id: 'r', name: '店长', permissions: ['assets:manage'] } } }));
});

// 精确 mock（注意：`*` 不跨 `/`，price-robot 用宽泛 `**` 兜底；auth/today 单独精确匹配）
page.route('**/api/pricing*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([
  { id: 'r1', roomType: '标准大床房', basePrice: 298, weekdayPrice: 298, weekendPrice: 358, holidayPrice: 447, minPrice: 0 },
]) }));
page.route('**/api/price-robot/auth/today', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'a1', roomTypeId: 'r1', status: 'confirmed' }]) }));
page.route('**/api/price-robot/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, data: { autoConfirm: true, globalFloor: 100, executedCount: 3, avgPrice: 328 } }) }));
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([]) }));

console.log('== 价格管理 /pages/profile/pricing ==');
await page.goto(`${BASE}/#/pages/profile/pricing`);
await page.waitForTimeout(3000);
check('房型名渲染', (await page.getByText('标准大床房').count()) >= 1);
check('日常价标签', (await page.getByText('日常价（每晚）').count()) >= 1);
check('周末加价标签', (await page.getByText('周末加价').count()) >= 1);
check('节假日加价标签', (await page.getByText('节假日加价').count()) >= 1);
check('派生预览出现', (await page.getByText(/按当前设置/).count()) >= 1);
check('无「渠道房价」tab', (await page.getByText('渠道房价').count()) === 0);
check('保存按钮', (await page.getByText('保存', { exact: true }).count()) >= 1);

console.log('== 收益管家 /pages/profile/price-robot ==');
await page.goto(`${BASE}/#/pages/profile/price-robot`);
await page.waitForTimeout(3000);
check('智能自动调价标题', (await page.getByText('智能自动调价').count()) >= 1);
check('开关已开启状态文案', (await page.getByText(/已开启/).count()) >= 1);
check('最低卖价', (await page.getByText('最低卖价').count()) >= 1);
check('今天已调价统计', (await page.getByText('今天已调价').count()) >= 1);
check('熔断按钮(已开启时)', (await page.getByText(/暂停今天的自动调价/).count()) >= 1);
check('无「今日底价确认」旧区块', (await page.getByText('今日底价确认').count()) === 0);
check('无「执行时间轴」旧区块', (await page.getByText('执行时间轴').count()) === 0);
check('无「未来价格日历」旧区块', (await page.getByText('未来价格日历').count()) === 0);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
