// 素材库绑定房型 — 冒烟检查（H5 headless）
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
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => console.log('  [pageerror]', e.message.slice(0, 150)));

// 精确 mock（勿用 **/api/** 通配，会拦截 dev 源码模块）
page.route('**/api/stores*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify([{ id: 'rt_1', name: '大床房' }, { id: 'rt_2', name: '标准间' }]) }));
page.route('**/api/assets*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ assets: [
  { id: 'a1', url: 'https://example.com/a1.jpg', name: '大床房全景', assetCategory: 'room', tags: [], quality: 'featured', roomTypeIds: ['rt_1'], roomTypeNames: ['大床房'] },
  { id: 'a2', url: 'https://example.com/a2.jpg', name: '标准间', assetCategory: 'room', tags: [], quality: 'normal', roomTypeIds: ['rt_1', 'rt_2'], roomTypeNames: ['大床房', '标准间'] },
  { id: 'a3', url: 'https://example.com/a3.jpg', name: '外景', assetCategory: 'view', tags: [], quality: 'normal', roomTypeIds: [], roomTypeNames: [] },
  { id: 'a4', url: 'https://example.com/a4.jpg', name: '三人间', assetCategory: 'room', tags: [], quality: 'normal', roomTypeIds: ['rt_1', 'rt_2', 'rt_3'], roomTypeNames: ['大床房', '标准间', '三人间'] },
] }) }));
page.route('**/api/notifications/unread*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true, count: 0 }) }));

// 模板库页 mock（注册在通用 **/api/assets* 之后 —— Playwright 后注册者优先；
// 用双星 ** 结尾以匹配 /api/assets/templates 与 /api/assets/templates/system，
// 单星 * 不匹配斜杠，会导致 /system 请求漏过 mock 打到生产 401）
const MINE_TMPLS = [
  { id: 't1', name: '房间全景', shotType: 'full_view', mediaType: 'image', guideText: '门口横拍、开灯、略仰角' },
  { id: 't2', name: '卫浴特写', shotType: 'bathroom', mediaType: 'image', guideText: '对焦洗手台、拍出干净明亮' },
  { id: 't3', name: '庭院环视（视频）', shotType: 'courtyard', mediaType: 'video', guideText: '院子全景环视', durationMin: 5, durationMax: 10 },
];
const SYSTEM_TMPLS = [
  { id: 's1', name: '门头招牌', shotType: 'entrance', mediaType: 'image', guideText: '正对门头完整露出招牌与店名' },
  { id: 's2', name: '门头招牌（视频）', shotType: 'entrance', mediaType: 'video', guideText: '门头全景 → 近景招牌', durationMin: 5, durationMax: 10 },
  { id: 's3', name: '床品特写（视频）', shotType: 'bedding', mediaType: 'video', guideText: '床整体 → 被褥细节特写', durationMin: 5, durationMax: 10 },
];
page.route('**/api/assets/templates**', r => {
  const body = r.request().url().includes('/system') ? { list: SYSTEM_TMPLS } : { list: MINE_TMPLS };
  r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
});

await page.goto(`${BASE}/#/pages/profile/assets`);
await page.waitForTimeout(3500);

console.log('== 素材库页 ==');
check('房型筛选「全部」', (await page.getByText('全部', { exact: true }).count()) >= 1);
check('房型筛选「未绑定」', (await page.getByText('未绑定', { exact: true }).count()) >= 1);
check('房型筛选「大床房」', (await page.getByText('大床房', { exact: true }).count()) >= 1);
check('房型筛选「标准间」', (await page.getByText('标准间', { exact: true }).count()) >= 1);
check('素材卡渲染 4 张', (await page.locator('.asset-card').count()) === 4);
check('卡片房型角标「大床房」', (await page.locator('.rt-badge', { hasText: '大床房' }).count()) >= 1);
check('卡片角标「+1」', (await page.getByText('+1', { exact: true }).count()) >= 1);
check('优质角标「优」', (await page.getByText('优', { exact: true }).count()) >= 1);

// 点击第一张卡 → 弹层
await page.locator('.asset-card').first().click();
await page.waitForTimeout(1200);
check('弹层出现', (await page.locator('.sheet').count()) === 1);
check('弹层「绑定房型」标题', (await page.getByText('绑定房型').count()) >= 1);
check('弹层「不绑定」chip', (await page.getByText('不绑定', { exact: true }).count()) >= 1);
check('弹层房型 chips 可选', (await page.locator('.rt-opt').count()) >= 3);
check('弹层「保存」按钮', (await page.getByText('保存', { exact: true }).count()) >= 1);
check('弹层「删除」按钮', (await page.getByText('删除', { exact: true }).count()) >= 1);

// 点「标准间」chip → 选中态（大床房已预选）
await page.locator('.rt-opt', { hasText: '标准间' }).first().click();
await page.waitForTimeout(300);
check('点选标准间后选中 2 个', (await page.locator('.rt-opt.active').count()) === 2);

// 点「不绑定」→ 清空（清空后「不绑定」chip 自身按设计变为选中态，其他房型 chip 取消）
await page.locator('.rt-opt', { hasText: '不绑定' }).first().click();
await page.waitForTimeout(300);
check('不绑定清空后仅不绑定选中', (await page.locator('.rt-opt.active').count()) === 1);
check('清空后无房型 chip 选中', (await page.locator('.rt-opt.active', { hasText: '大床房' }).count()) === 0);

// ===== 模板库页：图/视频双采集 UI（SOP Task 新增）=====
console.log('== 模板库页（图/视频双采集媒体徽标） ==');
await page.goto(`${BASE}/#/pages/assets/templates`);
await page.waitForTimeout(2500);

// 我的模板 tab（默认）
check('模板库「我的模板」卡 3 张', (await page.locator('.tmpl-card').count()) === 3);
check('媒体徽标总数 3', (await page.locator('.media-badge').count()) === 3);
check('图片徽标 2 个', (await page.locator('.media-badge.image').count()) === 2);
check('视频徽标 1 个', (await page.locator('.media-badge.video').count()) === 1);
check('图片徽标文案「图片」', (await page.locator('.media-badge.image').first().textContent())?.trim() === '图片');
check('视频徽标文案「视频」', (await page.locator('.media-badge.video').first().textContent())?.trim() === '视频');
check('模板名渲染「房间全景」', (await page.getByText('房间全景', { exact: true }).count()) >= 1);

// 切到系统模板库 tab
await page.getByText('系统模板库', { exact: true }).click();
await page.waitForTimeout(1200);
check('系统模板库卡 3 张', (await page.locator('.tmpl-card').count()) === 3);
check('系统库图片徽标 1 个', (await page.locator('.media-badge.image').count()) === 1);
check('系统库视频徽标 2 个', (await page.locator('.media-badge.video').count()) === 2);
check('系统库导入按钮 3 个', (await page.locator('.import-btn').count()) === 3);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
