// price-robot 布局程序化检查（含徽标换行回归）
import { chromium } from 'playwright';

const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const BASE = 'http://localhost:8081';

// 用长房型名 + 剩余 1/1 验证不换行
const mockData = {
  suggestion: { date: '2026-08-06', suggestions: [
    { roomTypeId: 'rt1', roomType: '行政大床房（零压舒适床枕+干湿分离）', suggestedFloor: 328, remaining: 1, total: 1, strategy: 'standard' },
    { roomTypeId: 'rt2', roomType: '豪华标准间', suggestedFloor: 268, remaining: 8, total: 10, strategy: 'aggressive' },
  ] },
  auth: [{ id: 'a1', roomTypeId: 'rt1', status: 'confirmed', floorPrice: 320, strategy: 'standard' }],
  tasks: [
    { id: 't1', slot: '17:00', channel: '美团', targetPrice: 320, status: 'success' },
    { id: 't3', slot: '19:00', channel: '飞猪', targetPrice: 315, status: 'rolled_back' },
  ],
  stats: { executedCount: 5, avgPrice: 305 },
  plan: [
    { planDate: '2026-08-06', roomTypeId: 'rt1', roomTypeName: '行政大床房（零压舒适床枕+干湿分离）', price: 320, status: 'confirmed', predictedOccupancy: 85 },
    { planDate: '2026-08-07', roomTypeId: 'rt2', roomTypeName: '豪华标准间', price: 268, status: 'pending', predictedOccupancy: 62 },
  ],
};

let passed = 0, failed = 0;
function check(name, cond) {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}`); }
}

const browser = await chromium.launch({ headless: true, executablePath: EXE });
const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
page.on('pageerror', e => console.log('  ❌ pageerror:', e.message.slice(0, 120)));

page.route('**/api/price-robot/**', r => {
  const u = r.request().url();
  let body = '{}';
  if (u.includes('/suggestion')) body = JSON.stringify(mockData.suggestion);
  else if (u.includes('/auth/today')) body = JSON.stringify(mockData.auth);
  else if (u.includes('/tasks')) body = JSON.stringify(mockData.tasks);
  else if (u.includes('/stats')) body = JSON.stringify(mockData.stats);
  else if (u.includes('/plan')) body = JSON.stringify(mockData.plan);
  r.fulfill({ status: 200, contentType: 'application/json', body });
});
page.route('**/api/auth/**', r => r.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ success: true }) }));

await page.goto(`${BASE}/#/pages/profile/price-robot`);
await page.waitForTimeout(6000);

const layout = await page.evaluate(() => {
  const rect = sel => { const el = document.querySelector(sel); if (!el) return null; const r = el.getBoundingClientRect(); return { h: Math.round(r.height), y: Math.round(r.y), bottom: Math.round(r.bottom) }; };
  const cs = sel => { const el = document.querySelector(sel); return el ? getComputedStyle(el) : null; };
  // 同一行判定：两个元素垂直范围重叠
  const sameRow = (a, b) => a && b && a.y < b.bottom && b.y < a.bottom;
  return {
    sectionState: { ws: cs('.section-state')?.whiteSpace, shrink: cs('.section-state')?.flexShrink },
    roomRemain: { ws: cs('.room-remain')?.whiteSpace, shrink: cs('.room-remain')?.flexShrink },
    roomName: { ws: cs('.room-name')?.whiteSpace, ellipsis: cs('.room-name')?.textOverflow },
    planOcc: { ws: cs('.plan-occ')?.whiteSpace, shrink: cs('.plan-occ')?.flexShrink },
    heroBadge: { ws: cs('.hero-badge')?.whiteSpace, shrink: cs('.hero-badge')?.flexShrink },
    roomRow: sameRow(rect('.room-name'), rect('.room-remain')),
    sectionRow: sameRow(rect('.section-title'), rect('.section-state')),
  };
});

console.log('徽标布局检查:');
check('已确认徽标 white-space:nowrap', layout.sectionState.ws === 'nowrap');
check('已确认徽标 flex-shrink:0', layout.sectionState.shrink === '0');
check('1/1间徽标 white-space:nowrap', layout.roomRemain.ws === 'nowrap');
check('1/1间徽标 flex-shrink:0', layout.roomRemain.shrink === '0');
check('房型名省略号截断', layout.roomName.ellipsis === 'ellipsis');
check('房型名与徽标同行', layout.roomRow);
check('section标题与徽标同行', layout.sectionRow);
check('入住率徽标 nowrap+shrink', layout.planOcc.ws === 'nowrap' && layout.planOcc.shrink === '0');
check('顶部徽标 nowrap+shrink', layout.heroBadge.ws === 'nowrap' && layout.heroBadge.shrink === '0');

await browser.close();
console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
