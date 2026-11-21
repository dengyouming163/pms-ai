/** 点位铺码四态：派生与单向流转的**唯一实现**。
 *
 *  纯函数、不碰 DB —— 所以它可以被单测穷尽覆盖，而端点的落库部分不能。
 *  端点（routes/admin/wenlv.ts）只负责鉴权、调这里的函数、写库。
 *
 *  为什么派生而不是存 status 列：存两份真相必然打架。本项目已有
 *  「守卫文案与条件不一致」的先例（文案说 A、条件测 B，两者各自"对"但合起来是错的）。
 */

/** 六列里被用到的三个时间戳。可空；也接受 pg 原始行给的字符串形式。 */
export type PlacementRow = {
  printedAt?: Date | string | null;
  placedAt?: Date | string | null;
  verifiedAt?: Date | string | null;
};

export type PlacementState = 'none' | 'printed' | 'placed' | 'verified';
/** 可以作为**推进目标**的阶段。`'none'` 不是目标 —— 退回未印要走 reset。 */
export type PlacementTarget = Exclude<PlacementState, 'none'>;

/** 阶段序号。只进不退的判据是「目标序号 ≥ 当前序号」。 */
const ORDER: Record<PlacementState, number> = { none: 0, printed: 1, placed: 2, verified: 3 };

/** 由三个时间戳派生状态。
 *
 *  **优先级从上到下**：verified > placed > printed。三个都为空即未印。
 *  三个时间戳共 8 种组合，**每一种都可达**：
 *  - `000` / `100` / `110` / `111` 是逐级推进的正常形态；
 *  - `010` / `001` / `011` / `101` 是**跳级推进**的产物 —— `canAdvance` 只要求
 *    「目标序号 ≥ 当前序号」，`PATCH /points/:id/placement` 也只挡「倒退」与「同阶段」，
 *    而 `patchForAdvance('placed')` **只写 placedAt、不动 printedAt**。
 *  ⚠️ `reset` **造不出**它们：`clearedByReset` 只清空、从不写入，且清的是
 *    「该阶段及其之后」的**后缀**（`clearedByReset('placed')` 会保住 printedAt）。
 *  故每一种组合都必须有确定且**被测钉住**的答案，不能靠「反正不会发生」。 */
export function derivePlacement(row: PlacementRow): PlacementState {
  if (row.verifiedAt) return 'verified';
  if (row.placedAt) return 'placed';
  if (row.printedAt) return 'printed';
  return 'none';
}

/** 能否从 `from` 推进到 `to`。
 *
 *  同阶段返回 true（幂等成功，不报错）；倒退返回 false（端点据此回 400 + 文案，
 *  **不做静默忽略** —— 静默忽略会让操作者以为点成功了）。 */
export function canAdvance(from: PlacementState, to: PlacementTarget): boolean {
  return ORDER[to] >= ORDER[from];
}

/** 推进到 `to` 时要写的字段。只写该阶段的 at/by，**不动其它阶段**。 */
export function patchForAdvance(
  to: PlacementTarget, by: string | null, now: Date,
): Partial<Record<
  'printedAt' | 'printedBy' | 'placedAt' | 'placedBy' | 'verifiedAt' | 'verifiedBy',
  Date | null | string
>> {
  switch (to) {
    case 'printed':  return { printedAt: now, printedBy: by };
    case 'placed':   return { placedAt: now, placedBy: by };
    case 'verified': return { verifiedAt: now, verifiedBy: by };
  }
}

/** reset 到「该阶段之前」时，要清空哪些字段。
 *
 *  **清空该阶段及其之后的全部时间戳**，而不是只清一个：
 *  派生是优先级的，若只清 `placed_at` 而留着 `verified_at`，
 *  派生结果仍是「已验」—— reset 在**输出上完全不可见**，成了静默失败。
 *
 *  语义读法：`clearedByReset('placed')` = 「撤销『已铺』这件事」
 *  ⇒ 同时撤销由它派生的「已验」。 */
export function clearedByReset(
  to: PlacementTarget,
): Partial<Record<
  'printedAt' | 'printedBy' | 'placedAt' | 'placedBy' | 'verifiedAt' | 'verifiedBy',
  null
>> {
  const out: Record<string, null> = {};
  const level = ORDER[to];
  if (ORDER.printed >= level) { out.printedAt = null; out.printedBy = null; }
  if (ORDER.placed >= level) { out.placedAt = null; out.placedBy = null; }
  if (ORDER.verified >= level) { out.verifiedAt = null; out.verifiedBy = null; }
  return out;
}
