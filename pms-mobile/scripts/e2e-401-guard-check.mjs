// 验证：网络请求守卫 — 未登录(401)自动跳转登录页（真实接口，无 mock）
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

// 记录 401 请求（真实接口，未 mock）
let saw401 = false;
page.on('response', res => { if (res.status() === 401 && res.url().includes('/api/')) saw401 = true; });

// 打开需要登录的页面（真实接口 → 401 → 守卫跳登录）
await page.goto(`${BASE}/#/pages/rooms/index`);
await page.waitForTimeout(6000);
console.log('访问 rooms 后 URL:', page.url());
const text = await page.evaluate(() => document.body.innerText.slice(0, 120));
console.log('跳转后页面:', JSON.stringify(text));
check('真实接口返回 401', saw401);
check('守卫跳转到登录页', (text || '').includes('手机号') || (text || '').includes('登录'));

// 再次确认 token 已清除
const token = await page.evaluate(() => localStorage.getItem('token') || localStorage.getItem('uni-storage-token') || '');
console.log('token 残留:', JSON.stringify(token));
check('token 已清除', !token);

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
