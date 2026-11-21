import type { WenlvTokens, WenlvTheme } from '../db/schema/wenlv.js';

// 把产品 theme 的扁平覆盖字段映射到 tokens 结构，并浅/深合并到模板 tokens 上。
// 纯函数：入参模板 tokens + 产品 theme，出参最终 tokens（供渲染引擎消费）。
// 仅在模板或 theme 确实提供对应字段时才输出该 token，避免产生空对象污染结果。
export function resolveProductTokens(
  templateTokens: WenlvTokens | null | undefined,
  theme: WenlvTheme | null | undefined,
): WenlvTokens {
  const base: WenlvTokens = templateTokens ?? {};
  const t: WenlvTheme = theme ?? {};
  const out: WenlvTokens = { ...base };

  // 颜色：theme.primaryColor 覆盖 colors.primary，模板其余颜色字段保留
  if (base.colors || t.primaryColor) {
    out.colors = { ...(base.colors ?? {}), ...(t.primaryColor ? { primary: t.primaryColor } : {}) };
  }
  // 字体：theme.font 覆盖 fonts.body，模板 heading 保留
  if (base.fonts || t.font) {
    out.fonts = { ...(base.fonts ?? {}), ...(t.font ? { body: t.font } : {}) };
  }
  // 动效：浅合并，theme.motion 按字段覆盖模板 motion
  if (base.motion || t.motion) {
    out.motion = { ...(base.motion ?? {}), ...(t.motion ?? {}) };
  }
  // 听觉：theme 提供即整体覆盖模板 soundStyle（字符串标量）
  if (t.soundStyle) out.soundStyle = t.soundStyle;
  // 触觉：浅合并（与 motion 一致），theme 只覆盖提供的字段，模板其余布尔字段保留
  if (base.haptic || t.haptic) {
    out.haptic = { ...(base.haptic ?? {}), ...(t.haptic ?? {}) };
  }

  return out;
}
