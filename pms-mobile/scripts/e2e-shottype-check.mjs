// 验证：拍摄类型英文映射为中文显示
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
// task-detail: 返回包含 3 种 shotType 的拍摄清单
page.route('**/api/tasks/task_1*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ task: {
  id: 'task_1', title: 'E2E任务', taskDate: '2026-08-06', roomNames: [], roomTypeNames: ['大床房'],
  purposeTags: ['短视频剪辑'], guideText: '',
  shotRequirements: [
    { shotType: 'full_view', count: 2, guideText: '横拍开灯' },
    { shotType: 'bathroom', count: 1, guideText: '对焦洗手台' },
    { shotType: 'custom_other', count: 1, guideText: '自定义类型' },
  ],
  mySubmission: null,
}}) }));
page.route('**/api/tasks*', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ list: [] }) }));

// task-detail 页
await page.goto(`${BASE}/#/pages/assets/task-detail?id=task_1`);
await page.waitForTimeout(6000);
const text = await page.evaluate(() => document.body.innerText);
console.log('页面文本片段:', JSON.stringify(text.slice(0, 300)));
check('full_view 显示为房间全景', (text || '').includes('房间全景'));
check('bathroom 显示为卫浴细节', (text || '').includes('卫浴细节'));
check('未映射类型保留原值', (text || '').includes('custom_other'));
check('英文 full_view 不再出现', !(text || '').includes('full_view'));

// 返回后检查 task-submit 映射
await page.goto(`${BASE}/#/pages/assets/task-submit?id=task_1`);
await page.waitForTimeout(6000);
const submitText = await page.evaluate(() => document.body.innerText);
check('打卡页 full_view 显示为房间全景', (submitText || '').includes('房间全景'));
check('打卡页英文 full_view 不出现', !(submitText || '').includes('full_view'));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
