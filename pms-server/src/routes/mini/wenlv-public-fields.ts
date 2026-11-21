/** 公开端点（游客侧）下发 product 的**字段白名单**。
 *
 *  为什么是白名单而不是「删掉几个敏感列」：漏删一列是**静默**的，
 *  而 products 表将来**加任何一列都会自动跟着流出去** —— 那正是本条修复
 *  要根治的那一类缺陷。白名单把「默认不下发」变成结构性保证。
 *
 *  这份清单的依据是**消费方反查**，不是猜测（`playMode` 为下单页预留，暂无消费方）：唯一消费方
 *  `pms-nimi/src/pages/wenlv/play.vue` 读 coverImage / name / subtitle / mode /
 *  designTokens（端点另算）/ bgmUrl / venueName（端点另算）与子数组
 *  nodes / collectibles / endings / tiers；`theme`、`config`（内层再过一遍 `pickPublicConfig`：
 *  裁掉 AI 出稿快照 `characters`）由 `pms-nimi/src/api/modules/wenlv.ts` 的 `WenlvDetail` 接口声明，保留。
 *
 *  ⚠️ 本函数只裁剪**输出**，不参与 DB 查询。详情 handler 内部还要用
 *  `product.venueId` 去查 `venueName`（见 `wenlv.ts` 的详情段）——
 *  若改用收窄 select 的写法，`venueName` 会**静默变 null**。
 *
 *  本文件**无任何 import**（纯函数，便于脱离 DB 直接单测）。 */

/** 允许下发的键。顺序即输出顺序。 */
export const PUBLIC_PRODUCT_KEYS = [
  'id', 'name', 'subtitle', 'coverImage', 'mode', 'playMode', 'theme', 'config',
] as const;

export type PublicProduct = Partial<Record<(typeof PUBLIC_PRODUCT_KEYS)[number], unknown>>;

/** `config` 的公开投影：剔掉 AI 出稿快照 `characters`。
 *
 *  快照里的 `ip_prompt` / `role` 与角色表侧**明文不下发**的口径冲突（表走 `safeCharacters` 白名单），
 *  而 `config` 是整块下发的 jsonb ⇒ 不裁就跟着出境。裁在**输出端**而不是写入端：快照按 spec §4.2
 *  保留原样（只作追溯），裁在出口才对存量行同样生效。
 *  非对象（null / 数组 / 字符串）原样透传 —— 与 `pickPublicProduct` 同一条口径：不替调用方做决定。 */
export function pickPublicConfig(v: unknown): unknown {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return v;
  const out: Record<string, unknown> = {};
  for (const k of Object.keys(v)) {
    if (k !== 'characters') out[k] = (v as Record<string, unknown>)[k];
  }
  return out;
}

export function pickPublicProduct<T extends Record<string, unknown>>(
  row: T | null | undefined,
): PublicProduct {
  const out: Record<string, unknown> = {};
  if (!row) return out;
  for (const k of PUBLIC_PRODUCT_KEYS) {
    // 用 hasOwnProperty 只是为了让「缺列」与「列存在但为 null」都原样透传；
    // 不引入默认值 —— 端点会原样 JSON 化，补默认值等于替前端做决定。
    if (Object.prototype.hasOwnProperty.call(row, k)) {
      out[k] = k === 'config' ? pickPublicConfig(row[k]) : row[k];
    }
  }
  return out;
}
