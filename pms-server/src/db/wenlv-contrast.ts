// WCAG 2.x 对比度纯函数（供 design token 准入门槛 / 诊断脚本使用）。
//
// ⚠️ 亮度/对比度公式必须与 `pms-nimi/src/utils/wenlv-theme.ts` 中的 `pickReadableText` 家族
// （linearize / parseHexColor / luminance / contrastRatio）**同源**保持一致。
// 两处各存一份是刻意的：pms-nimi 与 pms-server 禁止跨模块 import（见项目宪法），
// 故改动任一处时**必须同步另一处**，否则「准入判定」与「前端推导」会得出不同结论。
//
// **接受面刻意不对称：公式同源，口径不同**（是有意为之，不是疏漏）：
//  - 本文件（server，卡准入门槛）：**只认 `#rgb` / `#rrggbb`**（3 或 6 位、不含 alpha），
//    其余一律抛中文错 —— 门槛只面对内置模板这批形态确定的 hex，宁可失败也不静默错算；
//  - pms-nimi（前端，尽最大努力渲染）：接受面宽得多，额外收 `rgb()` / `hsl()` / 不透明
//    alpha-hex（4/8 位且 alpha 为 F/FF）。这不是前端「松懈」，而是**必须**跟上服务端的放行面：
//    `wenlv-theme-sanitize.ts` 有意放行 `rgb()` / `hsl()`（都是合法 CSS，能正常渲染），
//    AI 精修也确实会把 LLM 输出的 `visual.colors.primary`（可能是 `rgb(79,70,229)`）直接落库；
//    前端若只认 hex 就推导不出前景色 → 按钮回落白字 → `rgb(0,240,255)` 只有 1.41:1。
//    推导不出的值前端返回 null、不产出 on-* 变量，消费端回落 `$color-text-white`，页面照常渲染。
//  一句话：nimi 更宽（要兜住服务端有意放行的 AI 写入值），server 更严（门槛只面对内置 hex 模板）。
//
// 有意只接受 `#rgb` / `#rrggbb`：
//  1) 5/7 位 hex 在 CSS 里本就是非法长度，静默四舍五入会掩盖上游的脏数据；
//  2) 带 alpha 的色值（rgba()/hsla()、4/8 位 hex）与背景混合后实际观感取决于叠加的底色，
//     按不透明色计算会得出偏乐观的对比度，宁可抛错也不静默错算。

/**
 * 只接受 3 位或 6 位不透明 hex —— 长度口径与 `pms-wenlv-web/src/components/wenlv-editor/
 * product-head-form.tsx` 的 `HEX_OPAQUE` 守卫一致（同样的 3/6 位、不含 alpha）。
 * 注意**不是** pms-nimi 的 `HEX_COLOR`：那个含 4/8 位 alpha 形式，与本守卫口径不同。
 */
const OPAQUE_HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
/** 带 alpha 的 hex 简写/全写（#rgba / #rrggbbaa） */
const ALPHA_HEX = /^#(?:[0-9a-fA-F]{4}|[0-9a-fA-F]{8})$/;
const ALPHA_FUNC = /^rgba?\(|^hsla?\(/i;

/**
 * 解析 `#rgb` / `#rrggbb` 为 [r,g,b]。
 * 非法输入一律抛**中文**错误并带上原值 —— 静默返回 NaN 会让对比度算成 NaN 后仍「看起来没报错」。
 */
function parseHex(hex: string): [number, number, number] {
  if (typeof hex !== 'string') {
    throw new Error(`色值必须是字符串，收到：${String(hex)}`);
  }
  const s = hex.trim();
  if (ALPHA_FUNC.test(s) || ALPHA_HEX.test(s)) {
    throw new Error(`不支持带 alpha 的色值对比度计算，避免静默错算：${hex}`);
  }
  if (!OPAQUE_HEX.test(s)) {
    throw new Error(`非法色值（只接受 #rgb / #rrggbb 形式的十六进制色）：${hex}`);
  }
  const h = s.slice(1);
  const full = h.length === 3 ? h.split('').map((c) => c + c).join('') : h;
  return [
    parseInt(full.slice(0, 2), 16),
    parseInt(full.slice(2, 4), 16),
    parseInt(full.slice(4, 6), 16),
  ];
}

/** sRGB 通道 → 线性值（WCAG 2.x 相对亮度公式的中间步骤） */
function linearize(channel: number): number {
  const c = channel / 255;
  return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
}

/**
 * WCAG 2.x 相对亮度：0（纯黑）～ 1（纯白）。
 * 系数 0.2126 / 0.7152 / 0.0722 是 WCAG 规定的 R/G/B 加权（人眼对绿最敏感）。
 */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = parseHex(hex);
  return 0.2126 * linearize(r) + 0.7152 * linearize(g) + 0.0722 * linearize(b);
}

/**
 * WCAG 2.x 对比度：(L_亮 + 0.05) / (L_暗 + 0.05)，取值 1（同色）～ 21（黑白）。
 * 参数顺序无关 —— 内部按亮度自动分出亮暗，传反了不会得到 <1 的荒谬值。
 */
export function contrastRatio(fg: string, bg: string): number {
  const [hi, lo] = [relativeLuminance(fg), relativeLuminance(bg)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
