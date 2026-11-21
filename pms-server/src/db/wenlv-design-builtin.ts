// 内置设计系统模板：纯数据 + 纯函数，**无任何副作用、不 import db**。
//
// 之所以从 `seed-wenlv-design.ts` 抽出来：seed 脚本在模块顶层就 `main()` 写库，
// 直接 import 它会触发真实数据库写入，没法在单测里跑门槛。这里只留数据与门槛函数，
// 让「三套模板必须通过 WCAG 准入」这件事变得可测。
import type { WenlvTokens } from './schema/wenlv.js';
import { contrastRatio } from './wenlv-contrast.js';

type WenlvTokensColors = NonNullable<WenlvTokens['colors']>;

/** 内置模板定义 */
export type BuiltinWenlvTemplate = {
  id: string;
  name: string;
  styleTag: string;
  tokens: WenlvTokens;
};

/**
 * 三套内置模板。
 *
 * 两个刻意的约束（改色前务必先读）：
 *  1. 实心底（`primary` / `accent`）一律保留**亮色原值**，配白字不可读的问题由渲染层自动推导的
 *     `--wl-color-on-primary` / `--wl-color-on-accent` 解决 —— **不要为了迁就白字把它们调深**，
 *     那会牺牲主题辨识度。
 *     各模板的实际值（勿混淆槽位）：亮色落在**不同槽位**上 —— 亮金 `#F5C518` 落在国潮的 `accent`；
 *     赛博霓虹 `#00F0FF` 落在赛博的 **`primary`**（不是 accent）；赛博 `accent` = `#FF2D78` 是玫红；
 *     水墨 `accent` = `#8B4513` 是深棕、本就压得住白字。
 *     （原先此处写「三套 accent 列没有一个是亮金/霓虹」是自相矛盾：国潮 accent 就是亮金。）
 *  2. 新增的 `primarySoft` 必须是**不含 alpha 的 hex**，不能用 `rgba()` ——
 *     带 alpha 的值进不了 `contrastRatio`（会抛错），准入门槛直接跑不起来。
 */
export const BUILTIN_WENLV_TEMPLATES: BuiltinWenlvTemplate[] = [
  {
    id: 'tpl-guochao', name: '国潮风', styleTag: 'guochao',
    tokens: {
      colors: {
        primary: '#C8102E', primarySoft: '#FBEAEC',
        accent: '#F5C518', accentText: '#8A6A00',
        background: '#FFF8F0', surface: '#FFFDF8', text: '#2B2B2B',
      },
      fonts: { heading: '思源宋体', body: '思源黑体' },
      radius: 8, iconStyle: 'linear', stampStyle: 'traditional', mood: '国潮',
      motion: { easing: 'ease-out', duration: 300, transition: 'slide' },
      soundStyle: '东方古韵', haptic: { stamp: true, checkin: true },
    },
  },
  {
    id: 'tpl-shuimo', name: '水墨风', styleTag: 'shuimo',
    tokens: {
      colors: {
        primary: '#2B2B2B', primarySoft: '#F0EEE9',
        accent: '#8B4513', accentText: '#8B4513',
        background: '#F7F5F0', surface: '#FFFFFF', text: '#1A1A1A',
      },
      fonts: { heading: '思源宋体', body: '思源宋体' },
      radius: 4, iconStyle: 'line', stampStyle: 'ink', mood: '水墨',
      motion: { easing: 'ease-in-out', duration: 500, transition: 'fade' },
      soundStyle: '空灵古琴', haptic: { stamp: false, checkin: true },
    },
  },
  {
    id: 'tpl-cyber', name: '赛博风', styleTag: 'cyber',
    tokens: {
      colors: {
        primary: '#00F0FF', primarySoft: '#12212E',
        accent: '#FF2D78', accentText: '#FF2D78',
        // surface 必须是深色：此前卡片硬编码纯白，导致 #E0F7FA 的标题只有 1.11:1（不可见）
        background: '#0A0E1A', surface: '#141A2E', text: '#E0F7FA',
      },
      fonts: { heading: '思源黑体', body: '思源黑体' },
      radius: 12, iconStyle: 'line', stampStyle: 'neon', mood: '赛博',
      motion: { easing: 'ease-out', duration: 200, transition: 'glitch' },
      soundStyle: '电子脉冲', haptic: { stamp: true, checkin: true },
    },
  },
];

/**
 * 对比度规则表：[前景槽位, 背景槽位, 人类可读说明, 阈值]。
 * 阈值统一 4.5:1（WCAG AA 正文级）。
 */
const RULES: Array<[keyof WenlvTokensColors, keyof WenlvTokensColors, string, number]> = [
  ['text', 'surface', '卡片正文/标题', 4.5],
  ['text', 'background', '页面根文字', 4.5],
  ['accentText', 'surface', '价格等强调文字', 4.5],
  ['accentText', 'background', '页面根上的强调文字', 4.5],
  ['primary', 'primarySoft', 'chip 文字压浅底', 4.5],
  ['primary', 'surface', '主色文字压卡片底', 4.5],
];

/**
 * 实心底（primary / accent）上的文字色由渲染层的 pickReadableText 自动在白/深之间挑选，
 * 因此这里校验的是「自动挑选后较优的那一侧」必须达标 —— 若这条失败，说明该色是中亮度
 * （明暗两侧都读不清），必须换色，而不是靠 on-* 推导能救的。
 */
const DARK_ON = '#1A1A1A';
const ON_COLOR_SLOTS = ['primary', 'accent'] as const;
const ON_COLOR_MIN = 4.5;

/** 对比度尝试结果：解析失败不抛穿，而是带原因回来由调用方记为「不达标」 */
type ContrastAttempt = { ok: true; ratio: number } | { ok: false; reason: string };

/**
 * 门槛内的对比度计算包装：色值无法解析为不透明 hex（`parseHex` 抛错）时返回失败而不是让异常穿透。
 * 为什么必须包：门槛要对**任意输入**是全函数 —— 要么通过、要么明确报「不达标」。
 * 若异常直接穿透，一个 `rgb(...)`（AI 精修写得进 theme）或 4 位 hex 就会以未捕获异常的形式
 * 炸掉整个 seed，而不是给出可读的不达标原因。注意 `contrastRatio` 自身的抛错行为**不变**，
 * 这是门槛层的适配，不是放宽底层守卫。
 */
function attemptContrast(fg: string, bg: string): ContrastAttempt {
  try {
    return { ok: true, ratio: contrastRatio(fg, bg) };
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

/**
 * 实心底上的「白字 / 深字里较优一侧」对比度；底色不可解析时不抛穿，返回失败原因。
 * 与渲染层 pickReadableText 的挑色口径一致（取对比度更高的那一侧）。
 */
function bestForegroundRatio(bg: string): ContrastAttempt {
  const white = attemptContrast('#FFFFFF', bg);
  if (!white.ok) return white;
  const dark = attemptContrast(DARK_ON, bg);
  if (!dark.ok) return dark;
  return { ok: true, ratio: Math.max(white.ratio, dark.ratio) };
}

/**
 * 设计 token 对比度准入门槛。
 *
 * - **缺失槽位跳过**：门槛要能复用到只填了部分槽位的自建模板上，缺槽位不算失败。
 * - 不达标**抛错**，并把**全部**失败项一次性抛出（不是遇到第一个就 return），
 *   否则运营要改一轮跑一轮。
 * - 色值**无法解析为不透明 hex** 的，同样进 failures（记为不达标），不冒未捕获异常。
 */
export function assertDesignTokensCompliant(templateId: string, tokens: WenlvTokens): void {
  const colors = tokens.colors;
  if (!colors) return; // 完全没有 colors 视为「部分槽位模板」，跳过

  const failures: string[] = [];

  for (const [fgSlot, bgSlot, label, threshold] of RULES) {
    const fg = colors[fgSlot];
    const bg = colors[bgSlot];
    if (!fg || !bg) continue; // 缺失槽位跳过，不误报
    const attempt = attemptContrast(fg, bg);
    if (!attempt.ok) {
      failures.push(
        `${fgSlot}↔${bgSlot}（${label}）无法解析为不透明 hex（${fg} / ${bg}），门槛不达标：${attempt.reason}`,
      );
      continue;
    }
    if (attempt.ratio < threshold) {
      failures.push(
        `${fgSlot}↔${bgSlot}（${label}）实测 ${attempt.ratio.toFixed(2)}:1，低于阈值 ${threshold}:1`,
      );
    }
  }

  for (const slot of ON_COLOR_SLOTS) {
    const bg = colors[slot];
    if (!bg) continue;
    // 与渲染层 pickReadableText 同口径：白字/深字里较优的一侧
    const bgBest = bestForegroundRatio(bg);
    if (!bgBest.ok) {
      failures.push(
        `实心底 ${slot}=${bg} 无法解析为不透明 hex（门槛只认 #rgb/#rrggbb），无法判定自动前景色：${bgBest.reason}`,
      );
      continue;
    }
    if (bgBest.ratio < ON_COLOR_MIN) {
      failures.push(
        `实心底 ${slot}=${bg} 上的自动前景色（${DARK_ON} 或 #FFFFFF）较优仅 ${bgBest.ratio.toFixed(2)}:1，` +
        `低于阈值 ${ON_COLOR_MIN}:1 —— 该色属中亮度，须换色`,
      );
    }
  }

  if (failures.length > 0) {
    throw new Error(
      `[seed-wenlv-design] 对比度准入失败: ${templateId}\n` + failures.map((f) => `  - ${f}`).join('\n'),
    );
  }
}
