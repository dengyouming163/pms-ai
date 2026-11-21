// 工作台/我的页 迁移冒烟检查（H5 headless）
// 前置：pnpm dev:h5 已运行（http://localhost:8081）
import { chromium } from 'playwright';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = 'http://localhost:8081';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage();
page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 150)));
page.on('console', m => { if (m.type() === 'error') console.log('  [console.error]', m.text().slice(0, 150)); });

// 种一个店长登录态（工作台按角色隐藏 managerOnly 菜单项）
// 注意：uni-app H5 的 setStorageSync 对对象存 {type, data} 包装，getStorageSync 解析时解包
await page.addInitScript(() => {
  localStorage.setItem('token', 'mock-token');
  localStorage.setItem('userInfo', JSON.stringify({ type: 'object', data: { name: '测试店长', phone: '13800000001', roleName: '店长', role: { id: 'role2', name: '店长', scope: 'store', permissions: ['dashboard:view', 'assets:manage'] } } }));
  localStorage.setItem('currentStore', JSON.stringify({ type: 'object', data: { id: 's1', name: '测试门店' } }));
});

// 精确 mock API（绕过登录/401 跳转，形状与后端一致；不要用 **/api/** 通配，会拦截 dev 源码模块）
function mockApi(p) {
  p.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
  p.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 's1', name: '测试门店', brandName: '智宿管家' }]) }));
  p.route('**/api/notifications/unread*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, count: 2 }) }));
  p.route('**/api/staff*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ staff: [] }) }));
  p.route('**/api/assets*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assets: [] }) }));
  p.route('**/api/rooms*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ rooms: [], roomTypes: [] }) }));
  p.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
  p.route('**/api/task-rules*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
  p.route('**/api/assets/templates*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));
  p.route('**/api/dashboard*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({}) }));
}
mockApi(page);

// 工作台
console.log('== 工作台 /pages/index/index ==');
await page.goto(`${BASE}/#/pages/index/index`);
await page.waitForTimeout(3500);

check('素材工具 分组标题', (await page.getByText('素材工具', { exact: true }).count()) >= 1);
check('经营管理 分组标题', (await page.getByText('经营管理', { exact: true }).count()) >= 1);

const menuLabels = ['素材库','发打卡任务','完成率','拍摄模板','自动化任务','员工管理','客户管理','价格管理','房型管理','收益管家'];
for (const lb of menuLabels) {
  check(`菜单项「${lb}」渲染`, (await page.getByText(lb, { exact: true }).count()) >= 1);
}
check('今日素材打卡卡', (await page.getByText('今日素材打卡').count()) >= 1);
// 网格图标已从内联 SVG 改为 <image>（App 端不支持 SVG + currentColor），验证数量与加载
check('网格 <image> 图标渲染(≥10)', (await page.locator('.gc-icon-box .gc-icon').count()) >= 10);
// uni-app H5 的 <image> 编译为 uni-image 包裹层，naturalWidth 在内部 <img> 上
check('网格图标图片全部加载', await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('.gc-icon'));
  return els.length > 0 && els.every(el => (el.querySelector('img') || el).naturalWidth > 0);
}));
// 快捷操作已移除
check('无「快捷操作」', (await page.getByText('快捷操作').count()) === 0);
check('无「入住办理」', (await page.getByText('入住办理').count()) === 0);
// 旧板块应已删除
check('无统计卡片「实时入住率」', (await page.getByText('实时入住率').count()) === 0);
check('无「最近订单」', (await page.getByText('最近订单').count()) === 0);
check('无「房态概览」', (await page.getByText('房态概览').count()) === 0);

// 点击菜单项 → 路由跳转
await page.getByText('员工管理', { exact: true }).first().click();
await page.waitForTimeout(1200);
check('点击员工管理 → /pages/profile/staff', page.url().includes('/pages/profile/staff'));
await page.goto(`${BASE}/#/pages/index/index`);
await page.waitForTimeout(2500);
await page.getByText('素材库', { exact: true }).first().click();
await page.waitForTimeout(1200);
check('点击素材库 → /pages/profile/assets', page.url().includes('/pages/profile/assets'));

// 我的页
console.log('== 我的 /pages/profile/index ==');
await page.goto(`${BASE}/#/pages/profile/index`);
await page.waitForTimeout(3500);
check('设置-修改密码', (await page.getByText('修改密码').count()) >= 1);
check('设置-帮助与反馈', (await page.getByText('帮助与反馈').count()) >= 1);
check('设置-关于', (await page.getByText('关于').count()) >= 1);
check('设置-消息通知', (await page.getByText('消息通知').count()) >= 1);
check('退出登录按钮', (await page.getByText('退出登录').count()) >= 1);
check('设置列表 <image> 图标(5)', (await page.locator('.mi-icon-box .mi-icon').count()) === 5);
check('退出图标 <image>', (await page.locator('.logout-btn .logout-icon').count()) === 1);
check('我的页图标图片全部加载', await page.evaluate(() => {
  const els = Array.from(document.querySelectorAll('.mi-icon, .logout-icon'));
  return els.length > 0 && els.every(el => (el.querySelector('img') || el).naturalWidth > 0);
}));
check('无「员工管理」网格残留', (await page.getByText('员工管理').count()) === 0);
check('无「收益管家」网格残留', (await page.getByText('收益管家').count()) === 0);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
