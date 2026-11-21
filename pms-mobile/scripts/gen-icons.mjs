// 图标生成脚本：从工作台/我的页的内联 SVG path 数据烘焙 16 张 PNG
// 原因：uni-app App 端不支持内联 SVG + currentColor，改用 <image> + PNG
// 用法：node scripts/gen-icons.mjs
// 输出：src/static/icon/*.png（96x96，透明背景，颜色已烘焙）
import { chromium } from 'playwright';
import { mkdirSync, writeFileSync, statSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR = join(__dirname, '..', 'src', 'static', 'icon');
const EXE = 'C:/Users/Administrator/AppData/Local/ms-playwright/chromium-1228/chrome-win64/chrome.exe';
const SIZE = 96; // 输出像素

// 子元素构造辅助
const RECT = (a) => `<rect x="${a.x}" y="${a.y}" width="${a.width}" height="${a.height}" rx="${a.rx}" ry="${a.ry}"/>`;
const CIRCLE = (a) => `<circle cx="${a.cx}" cy="${a.cy}" r="${a.r}" fill="none"/>`;
const POLYLINE = (a) => `<polyline points="${a.points}" fill="none"/>`;
const POLYGON = (a) => `<polygon points="${a.points}" fill="none"/>`;
const LINE = (a) => `<line x1="${a.x1}" y1="${a.y1}" x2="${a.x2}" y2="${a.y2}"/>`;
const PATH = (a) => `<path d="${a.d}"/>`;

// 与 src/pages/index/index.vue 的 menuGroups 一一对应
const WORKBENCH = [
  { name: 'material',       color: '#F43F5E', kids: [RECT({x:'3',y:'3',width:'18',height:'18',rx:'2',ry:'2'}), CIRCLE({cx:'8.5',cy:'8.5',r:'1.5'}), POLYLINE({points:'21 15 16 10 5 21'})] },
  { name: 'task-create',    color: '#10B981', kids: [PATH({d:'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z'}), CIRCLE({cx:'12',cy:'13',r:'4'})] },
  { name: 'completion',     color: '#F59E0B', kids: [LINE({x1:'18',y1:'20',x2:'18',y2:'10'}), LINE({x1:'12',y1:'20',x2:'12',y2:'4'}), LINE({x1:'6',y1:'20',x2:'6',y2:'14'})] },
  { name: 'template',       color: '#8B5CF6', kids: [RECT({x:'3',y:'3',width:'18',height:'18',rx:'2',ry:'2'}), LINE({x1:'3',y1:'9',x2:'21',y2:'9'}), LINE({x1:'9',y1:'21',x2:'9',y2:'9'})] },
  { name: 'auto-task',      color: '#0284C7', kids: [POLYGON({points:'13 2 3 14 12 14 11 22 21 10 12 10 13 2'})] },
  { name: 'staff',          color: '#4F6EF7', kids: [PATH({d:'M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2'}), CIRCLE({cx:'12',cy:'7',r:'4'})] },
  { name: 'customers',      color: '#F59E0B', kids: [PATH({d:'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2'}), CIRCLE({cx:'9',cy:'7',r:'4'}), PATH({d:'M23 21v-2a4 4 0 0 0-3-3.87'}), PATH({d:'M16 3.13a4 4 0 0 1 0 7.75'})] },
  { name: 'pricing',        color: '#10B981', kids: [PATH({d:'M20.59 13.41l-7.17 7.17a2 2 0 0 1-2.83 0L2 12V2h10l8.59 8.59a2 2 0 0 1 0 2.82z'}), LINE({x1:'7',y1:'7',x2:'7.01',y2:'7'})] },
  { name: 'room-types',     color: '#0EA5E9', kids: [PATH({d:'M2 20v-8a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v8'}), PATH({d:'M4 10V6a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v4'}), PATH({d:'M12 4v6'}), PATH({d:'M2 18h20'})] },
  { name: 'price-robot',    color: '#10B981', kids: [POLYLINE({points:'23 6 13.5 15.5 8.5 10.5 1 18'}), POLYLINE({points:'17 6 23 6 23 12'})] },
];

// 与 src/pages/profile/index.vue 的设置列表 + 退出按钮一一对应
const PROFILE = [
  { name: 'verify',          color: '#07C160', kids: [PATH({d:'M4 19.5A2.5 2.5 0 0 1 6.5 17H20'}), PATH({d:'M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z'})] },
  { name: 'notification',    color: '#F43F5E', kids: [PATH({d:'M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9'}), PATH({d:'M13.73 21a2 2 0 0 1-3.46 0'})] },
  { name: 'change-password', color: '#4F6EF7', kids: [RECT({x:'3',y:'11',width:'18',height:'11',rx:'2',ry:'2'}), PATH({d:'M7 11V7a5 5 0 0 1 10 0v4'})] },
  { name: 'help',            color: '#10B981', kids: [CIRCLE({cx:'12',cy:'12',r:'10'}), PATH({d:'M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3'}), LINE({x1:'12',y1:'17',x2:'12.01',y2:'17'})] },
  { name: 'about',           color: '#0EA5E9', kids: [CIRCLE({cx:'12',cy:'12',r:'10'}), LINE({x1:'12',y1:'16',x2:'12',y2:'12'}), LINE({x1:'12',y1:'8',x2:'12.01',y2:'8'})] },
  { name: 'logout',          color: '#FA5151', kids: [PATH({d:'M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4'}), POLYLINE({points:'16 17 21 12 16 7'}), LINE({x1:'21',y1:'12',x2:'9',y2:'12'})] },
];

// 其余 5 个文件的内联 SVG（AI会话/价格卡片/房态卡/语音输入/用户中心）
const MISC = [
  { name: 'ai-bolt',              color: '#C8A96E', sw: 1.5, kids: [POLYGON({points:'13 2 3 14 12 14 11 22 21 10 12 10 13 2'})] },
  { name: 'chat-user',            color: '#3C5068', sw: 1.5, kids: [CIRCLE({cx:'12',cy:'8',r:'4'}), PATH({d:'M6 21v-2a4 4 0 014-4h4a4 4 0 014 4v2'})] },
  { name: 'chat-send',            color: '#FFFFFF', sw: 2,   kids: [LINE({x1:'22',y1:'2',x2:'11',y2:'13'}), POLYGON({points:'22 2 15 22 11 13 2 9 22 2'})] },
  { name: 'chat-send-disabled',   color: '#C8CFD6', sw: 2,   kids: [LINE({x1:'22',y1:'2',x2:'11',y2:'13'}), POLYGON({points:'22 2 15 22 11 13 2 9 22 2'})] },
  { name: 'price-arrow',          color: '#C8A96E', sw: 1.5, kids: [LINE({x1:'5',y1:'12',x2:'19',y2:'12'}), POLYLINE({points:'12 5 19 12 12 19'})] },
  { name: 'price-info',           color: '#C8A96E', sw: 2,   kids: [CIRCLE({cx:'12',cy:'12',r:'10'}), LINE({x1:'12',y1:'16',x2:'12',y2:'12'}), LINE({x1:'12',y1:'8',x2:'12.01',y2:'8'})] },
  { name: 'room-check',           color: '#C8A96E', sw: 2.5, kids: [POLYLINE({points:'9 11 12 14 22 4'}), PATH({d:'M21 12v7a2 2 0 01-2 2H5a2 2 0 01-2-2V5a2 2 0 012-2h11'})] },
  { name: 'voice-mic',            color: '#1D2A3A', sw: 2,   kids: [PATH({d:'M12 1a3 3 0 00-3 3v8a3 3 0 006 0V4a3 3 0 00-3-3z'}), PATH({d:'M19 10v2a7 7 0 01-14 0v-2'}), LINE({x1:'12',y1:'19',x2:'12',y2:'23'}), LINE({x1:'8',y1:'23',x2:'16',y2:'23'})] },
  { name: 'voice-recording',      color: '#D35A5A', sw: 2,   kids: [CIRCLE({cx:'12',cy:'12',r:'10'}), LINE({x1:'12',y1:'8',x2:'12',y2:'12'}), LINE({x1:'12',y1:'16',x2:'12.01',y2:'16'})] },
  { name: 'store-building',       color: '#B8956A', sw: 1.8, kids: [RECT({x:'3',y:'3',width:'18',height:'18',rx:'3',ry:'3'}), LINE({x1:'3',y1:'9',x2:'21',y2:'9'}), LINE({x1:'9',y1:'21',x2:'9',y2:'9'})] },
  { name: 'chevron-small',        color: '#9BA8B5', sw: 2,   kids: [POLYLINE({points:'9 18 15 12 9 6'})] },
  { name: 'close-x',              color: '#9BA8B5', sw: 2,   kids: [LINE({x1:'18',y1:'6',x2:'6',y2:'18'}), LINE({x1:'6',y1:'6',x2:'18',y2:'18'})] },
  { name: 'check-white',          color: '#FFFFFF', sw: 3,   kids: [POLYLINE({points:'20 6 9 17 4 12'})] },
  { name: 'menu-stores',          color: '#3C5068', sw: 1.8, kids: [RECT({x:'3',y:'3',width:'18',height:'18',rx:'3',ry:'3'}), LINE({x1:'3',y1:'9',x2:'21',y2:'9'}), LINE({x1:'9',y1:'21',x2:'9',y2:'9'})] },
  { name: 'menu-room-types',      color: '#5B7FA5', sw: 1.8, kids: [RECT({x:'3',y:'3',width:'8',height:'8',rx:'1.5',ry:'1.5'}), RECT({x:'13',y:'3',width:'8',height:'8',rx:'1.5',ry:'1.5'}), RECT({x:'3',y:'13',width:'8',height:'8',rx:'1.5',ry:'1.5'}), RECT({x:'13',y:'13',width:'8',height:'8',rx:'1.5',ry:'1.5'})] },
  { name: 'menu-price-calendar',  color: '#C8A96E', sw: 1.8, kids: [RECT({x:'3',y:'4',width:'18',height:'18',rx:'2',ry:'2'}), LINE({x1:'16',y1:'2',x2:'16',y2:'6'}), LINE({x1:'8',y1:'2',x2:'8',y2:'6'}), LINE({x1:'3',y1:'10',x2:'21',y2:'10'})] },
  { name: 'menu-notifications',   color: '#6B9B7A', sw: 1.8, kids: [PATH({d:'M18 8A6 6 0 006 8c0 7-3 9-3 9h18s-3-2-3-9'}), PATH({d:'M13.73 21a2 2 0 01-3.46 0'})] },
  { name: 'menu-help',            color: '#8B7B9B', sw: 1.8, kids: [CIRCLE({cx:'12',cy:'12',r:'10'}), PATH({d:'M9.09 9a3 3 0 015.83 1c0 2-3 3-3 3'}), LINE({x1:'12',y1:'17',x2:'12.01',y2:'17'})] },
  { name: 'menu-about',           color: '#3C5068', sw: 1.8, kids: [CIRCLE({cx:'12',cy:'12',r:'10'}), LINE({x1:'12',y1:'16',x2:'12',y2:'12'}), LINE({x1:'12',y1:'8',x2:'12.01',y2:'8'})] },
  { name: 'chevron-gray',         color: '#C8CFD6', sw: 2,   kids: [POLYLINE({points:'9 18 15 12 9 6'})] },
];

const ICONS = [...WORKBENCH, ...PROFILE, ...MISC];

function buildSvg(icon, size) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="${icon.color}" stroke-width="${icon.sw || 1.8}" stroke-linecap="round" stroke-linejoin="round">${icon.kids.join('')}</svg>`;
}

mkdirSync(OUT_DIR, { recursive: true });
const browser = await chromium.launch({ headless: true, executablePath: EXE });
let ok = 0, fail = 0;
for (const icon of ICONS) {
  try {
    const page = await browser.newPage({ viewport: { width: SIZE, height: SIZE } });
    // 内联 svg 直接作为 body 内容，无任何页面样式，透明背景
    await page.setContent(buildSvg(icon, SIZE), { waitUntil: 'load' });
    const el = page.locator('svg');
    const box = await el.boundingBox();
    if (!box || box.width < 10 || box.height < 10) {
      console.log(`  ❌ ${icon.name}: 渲染尺寸异常 ${JSON.stringify(box)}`);
      fail++; await page.close(); continue;
    }
    await el.screenshot({ path: join(OUT_DIR, `${icon.name}.png`), omitBackground: true });
    await page.close();
    ok++;
    console.log(`  ✅ ${icon.name}.png (${icon.color})`);
  } catch (e) {
    console.log(`  ❌ ${icon.name}: ${e.message}`);
    fail++;
  }
}
await browser.close();

// 校验输出
console.log('\n== 校验 ==');
const expect = ICONS.length;
const files = ICONS.filter(i => {
  const p = join(OUT_DIR, `${i.name}.png`);
  try { return statSync(p).size > 0; } catch { return false; }
});
console.log(`生成成功 ${files.length}/${expect}`);
if (fail > 0) console.log(`渲染失败 ${fail} 个`);
process.exit(fail > 0 ? 1 : 0);
