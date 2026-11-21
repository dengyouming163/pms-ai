// 文旅设计 token 解析与加载。
// 职责：把 design_templates.tokens 经产品 theme 覆盖解析成最终 tokens，供各端下发。
// 分层：纯函数（可单测，零 IO）+ 薄 DB 加载器（批量取模板，避免列表 N+1）。
import { inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiWenlvDesignTemplates } from '../db/schema/index.js';
import { resolveProductTokens } from './wenlv-design-system.js';
import type { WenlvTheme, WenlvTokens } from '../db/schema/wenlv.js';

/** 产品最小入参：只需 id 与 theme（theme 列 notNull default {}，但仍容错 null） */
export type DesignTokenInput = { id: string; theme?: WenlvTheme | null };

/**
 * 纯函数：解析每个产品的最终 tokens。
 * - 引用模板 → 模板 tokens 为底，theme 覆盖其上（resolveProductTokens 语义）
 * - 未引用 / 模板缺失 → 仅 theme 覆盖字段，无覆盖则为 {}
 * 恒返回 Map，且每个产品都有条目（值为 {} 而非 undefined），调用端无需判空。
 */
export function resolveDesignTokensForProducts(
  products: DesignTokenInput[],
  templateTokens: Map<string, WenlvTokens>,
): Map<string, WenlvTokens> {
  const out = new Map<string, WenlvTokens>();
  for (const p of products) {
    const tplId = p.theme?.templateId;
    // 模板缺失时传 undefined（而非 {}），与「无模板」语义一致
    const base = tplId ? templateTokens.get(tplId) : undefined;
    out.set(p.id, resolveProductTokens(base, p.theme));
  }
  return out;
}

/**
 * DB 加载器（批量）：一次性取齐所需模板，再走纯函数解析。
 * 列表场景必须用这个，不要循环调 loadDesignTokensForProduct（N+1）。
 */
export async function loadDesignTokensForProducts(
  products: DesignTokenInput[],
): Promise<Map<string, WenlvTokens>> {
  if (products.length === 0) return new Map();
  const tplIds = [
    ...new Set(
      products
        .map((p) => p.theme?.templateId)
        .filter((x): x is string => typeof x === 'string' && x.length > 0),
    ),
  ];
  const templateTokens = new Map<string, WenlvTokens>();
  if (tplIds.length > 0) {
    try {
      const rows = await db
        .select()
        .from(pmsBuiWenlvDesignTemplates)
        .where(inArray(pmsBuiWenlvDesignTemplates.id, tplIds));
      for (const r of rows) templateTokens.set(r.id, r.tokens ?? {});
    } catch (e: any) {
      // 设计 token 属视觉增强层：模板查询失败时降级为「无模板」（theme 覆盖仍生效），
      // 绝不因装饰性数据把 C 端产品列表/详情打成 500。前端拿到 {} 会回落 SCSS 兜底，视觉零变化。
      console.warn('[wenlv-design-load] 设计模板查询失败，降级为仅 theme 覆盖:', e?.message || e);
    }
  }
  return resolveDesignTokensForProducts(products, templateTokens);
}

/** 单产品便利封装：与批量共用同一实现，保证语义完全一致 */
export async function loadDesignTokensForProduct(product: DesignTokenInput): Promise<WenlvTokens> {
  const m = await loadDesignTokensForProducts([product]);
  return m.get(product.id) ?? {};
}
