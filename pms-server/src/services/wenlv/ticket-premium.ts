// 剧本房溢价（Task 11 / spec §3.7）：premium 存内容产品 config.premium
// （pms_bui_wenlv_products.config jsonb；写入口 productConfigSchema 是 .passthrough()，
// 未声明键原样透传，前端组装/解析，无需迁移）。
// C 端展示价 = 票价 + premium。本模块只放**纯函数**（提取 + 合成），DB 访问留在路由层 ——
// 纯函数可脱离活库直测（services/__tests__/wenlv-ticket-premium.test.ts）。

/**
 * 溢价上限：加价语义防御管理员手滑天价收款（真实溢价量级几十~几百元）。
 * 写入口（web 抽屉）校验 ≤ 此值，读入口（C 端合成）再钳一次，两端独立兜底。
 */
export const PREMIUM_MAX = 99999;

/**
 * 从内容产品 config（jsonb）里取剧本房溢价。
 * 缺省 / 非法 / 负值 / NaN / 超上限 一律 0 —— 溢价是**加价**语义，不做隐性折扣：
 * 写入口（web 抽屉）校验 ≥0 且 ≤上限，读入口（C 端合成）再钳一次，两端独立兜底。
 */
export function ticketPremiumOf(config: unknown): number {
  const raw = (config as { premium?: unknown } | null | undefined)?.premium;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n <= PREMIUM_MAX ? n : 0;
}

/**
 * C 端展示价合成：premium > 0 时返回 (base + premium) 两位小数字符串；
 * 否则**原样**返回 base（保持既有透传形状 —— 平台 decimal 列出来是字符串，
 * 下游 wenlv-trade-products.db.test.ts 钉住了 `'0.00'` / `'88.00'` 的字面形状，勿归一化）。
 * base 非有限数时原样透传（不合成、不抛错 —— 显示层坏数据不拦交易主流程）。
 */
export function displayPriceWithPremium(basePrice: string | number, premium: number): string {
  const asString = typeof basePrice === 'string' ? basePrice : String(basePrice);
  // 空串经 Number() 会变成 0（有限数）—— 显式按坏数据透传，防止合成出凭空的 '10.00'
  if (typeof basePrice === 'string' && basePrice.trim() === '') return asString;
  const base = Number(basePrice);
  if (!Number.isFinite(base)) return asString;
  if (!(premium > 0)) return asString;
  return (base + premium).toFixed(2);
}
