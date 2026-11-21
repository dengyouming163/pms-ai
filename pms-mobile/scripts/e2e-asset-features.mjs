// 素材库打卡体系 — 前端 E2E 自动化测试（H5, mock API 绕过登录）
// 前置：先运行 `pnpm dev:h5`（http://localhost:8081）
// 运行：node scripts/e2e-asset-features.mjs
import { chromium } from 'playwright';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = 'http://localhost:8081';

// ===== mock API（绕过登录，验证 UI 交互）=====
function mockApi(page) {
  page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
  page.route('**/api/assets/templates*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [
    { id: 'tmpl_full_view', name: '房间全景', shotType: 'full_view', category: 'room', guideText: '横拍开灯', exampleImageUrl: '' },
  ] }) }));
  page.route('**/api/assets/templates/system*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [
    { id: 'sys_full_view', name: '系统全景', shotType: 'full_view', category: 'room', guideText: '系统示例', exampleImageUrl: '' },
    { id: 'sys_bath', name: '系统卫浴', shotType: 'bathroom', category: 'room', guideText: '系统卫浴示例', exampleImageUrl: '' },
  ] }) }));
  page.route('**/api/assets/templates/import', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, id: 'tmpl_imported', duplicated: false }) }));
  page.route('**/api/task-rules*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [
    { id: 'rule_1', name: '每日房态', status: 'enabled', publishTime: '09:00', nextRunAt: '2026-08-07T01:00:00.000Z', roomTypeNames: ['大床房'] },
  ] }) }));
  page.route('**/api/task-rules/*/status', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
  page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'rt_1', name: '大床房' }, { id: 'rt_2', name: '标准间' }]) }));
  page.route('**/api/assets*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assets: [] }) }));
  page.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [{ id: 's1', name: '张三' }] }) }));
  page.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
  page.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [] }) }));
  page.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }));
}

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 150)));
mockApi(page);

// ===== 1. 登录页 input（回归）=====
console.log('== 1. 登录页 input 可输入 ==');
await page.goto(`${BASE}/#/`);
await page.waitForTimeout(4000);
const loginInput = page.locator('input').first();
await loginInput.click(); await loginInput.fill('13800000001');
check('登录页手机号可输入', (await loginInput.inputValue()) === '13800000001');

// ===== 2. 模板库：新建弹层 input + 保存 + 系统库 tab =====
console.log('== 2. 模板库功能 ==');
await page.goto(`${BASE}/#/pages/assets/templates`);
await page.waitForTimeout(5000);
check('我的模板列表加载', (await page.getByText('房间全景').count()) >= 1);
await page.getByText('+ 新建').first().click();
await page.waitForTimeout(1200);
const tplInputs = page.locator('input');
check('新建弹层出现 input', (await tplInputs.count()) >= 2);
if (await tplInputs.count() >= 1) {
  await tplInputs.first().click(); await tplInputs.first().fill('我的新模板');
  check('弹层 input 可输入', (await tplInputs.first().inputValue()) === '我的新模板');
}
await page.locator('.t-popup .sheet-close').first().click(); await page.waitForTimeout(800);
await page.getByText('系统模板库').click(); await page.waitForTimeout(1000);
check('系统模板库 tab 展示', (await page.getByText('系统全景').count()) >= 1);
check('系统库有导入按钮', (await page.getByText('导入').count()) >= 1);
await page.getByText('导入').first().click(); await page.waitForTimeout(800);
check('导入确认弹窗出现', (await page.getByText('导入模板').count()) >= 1);
// 关闭 uni.showModal 确认弹窗（避免 uni-mask 残留拦截后续点击）
await page.getByText('取消').click(); await page.waitForTimeout(800);

// ===== 3. 自动化规则：列表 + 弹层 input + 启停 =====
console.log('== 3. 自动化规则功能 ==');
await page.goto(`${BASE}/#/pages/assets/task-rules`);
await page.waitForTimeout(5000);
check('规则列表加载', (await page.getByText('每日房态').count()) >= 1);
check('启停开关存在', (await page.locator('switch, uni-switch').count()) >= 1);
await page.getByText('+ 新建规则').first().click();
await page.waitForTimeout(1200);
const ruleInputs = page.locator('input');
check('规则弹层出现 input', (await ruleInputs.count()) >= 1);
if (await ruleInputs.count() >= 1) {
  await ruleInputs.first().click(); await ruleInputs.first().fill('每日周边拍摄');
  check('规则弹层 input 可输入', (await ruleInputs.first().inputValue()) === '每日周边拍摄');
}
// 模板/房型 chips
check('规则弹层模板 chips', (await page.getByText('房间全景').count()) >= 1);
check('规则弹层房型 chips', (await page.getByText('大床房').count()) >= 1);

// ===== 4. 发任务页：input + 房型选择 =====
console.log('== 4. 发任务页功能 ==');
await page.goto(`${BASE}/#/pages/assets/task-create`);
await page.waitForTimeout(5000);
const createInputs = page.locator('input');
check('发任务页 input 可输入', await createInputs.count() >= 1);
if (await createInputs.count() >= 1) {
  await createInputs.first().click(); await createInputs.first().fill('8月6日 房态拍摄');
  check('任务标题可输入', (await createInputs.first().inputValue()) === '8月6日 房态拍摄');
}
// 房型选择弹层
await page.getByText('+ 房型').click(); await page.waitForTimeout(1000);
check('房型选择弹层打开', (await page.getByText('选择房型').count()) >= 1);
check('房型列表展示', (await page.getByText('大床房').count()) >= 1);
await page.locator('.t-popup .picker-close, .t-popup .sheet-close').first().click(); await page.waitForTimeout(800);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
