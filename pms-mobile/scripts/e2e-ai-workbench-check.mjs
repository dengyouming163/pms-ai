// 验证：AI 助手工作台能力菜单改为问题标签形式（紧凑 pill）
import { chromium } from 'playwright';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = 'http://localhost:8084';

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => console.log('  ⚠️ pageerror:', e.message.slice(0, 150)));

page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));
page.route('**/api/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));

await page.goto(`${BASE}/#/pages/ai/index`);
await page.waitForTimeout(7000);
console.log('URL:', page.url());

const info = await page.evaluate(() => {
  const pills = document.querySelectorAll('.cap-card.compact');
  const labels = Array.from(pills).map(p => p.querySelector('.cc-label')?.textContent?.trim());
  // 取第一个 pill 的尺寸（判断是否紧凑 pill 而非大网格）
  const first = pills[0]?.getBoundingClientRect();
  const grid = document.querySelector('.cap-grid');
  return {
    pillCount: pills.length,
    labels: labels.slice(0, 8),
    firstPill: first ? { w: Math.round(first.width), h: Math.round(first.height) } : null,
    bodyText: document.body.innerText.slice(0, 120),
  };
});
console.log('工作台能力菜单:', JSON.stringify(info, null, 2));
check('有能力标签(compact pill)', info.pillCount >= 3);
check('标签为紧凑 pill（宽>高）', !info.firstPill || info.firstPill.w > info.firstPill.h);
check('标签横向流式排列', info.firstPill && info.firstPill.h < 100);
check('显示能力文案', info.labels.some(l => l && l.length > 0));

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
