/**
 * 候选数量配额（子项目①）。
 *
 * 方舟的多图机制是 `sequential_image_generation: 'auto'` +
 * `sequential_image_generation_options.max_images: N`，且有一条**硬约束**：
 *
 *     参考图数 + 生成图数 ≤ 15
 *
 * ⚠️ **不能用 OpenAI 的 `n`** —— 方舟对它报 400
 *（见 image-provider.ts 里那条已经钉过的注释）。
 *
 * 所以候选数不是自由参数，是**算出来的**。本文件把算式独立成一个纯函数，
 * 好让「参考图 14 / 15 / 16 时怎么办」这三个边界能被单测钉死，
 * 而不是等到生产上发现某一类素材永远生成失败。
 */

/** 方舟的硬上限：参考图 + 生成图 ≤ 15。 */
export const SEQUENTIAL_TOTAL_LIMIT = 15;

/** 风格参考图集上限。**刻意不取满 14** —— 要给候选与涂鸦留位。 */
export const MAX_STYLE_REFS = 6;

/** 候选上限。 */
export const MAX_CANDIDATES = 4;

/**
 * 算出本次实际能出几张候选。
 *
 * `availableRefs` 是**实际要发出去的参考图总数**（锚图 + 图集 + 涂鸦图），
 * 不是图集长度 —— 少算了涂鸦图就会发出超出配额的请求。
 *
 * 算不出 ≥1 时**抛错，绝不静默降级成「少发几张参考图」**：
 * 那等于悄悄换掉风格基线（锚图被丢），而出的图看起来完全正常，事后无从分辨。
 *
 * ⚠️ **入参两侧都必须是整数**，用 `Number.isInteger` 而不是 `isFinite`：
 *    `isFinite` 放行小数，于是 4 张参考图配 `13.5` 会算出 **1.5 张候选**
 *    （`Math.min(Math.floor(4), 15 - 13.5, 4)`），原样发成 `max_images: 1.5`。
 *    `isFinite` 也放行 `2.5` 张候选请求，`Math.floor` 会把它静默吞成 2 ——
 *    文案承诺「必须是 ≥1 的整数」，条件就得真的是整数。两者必须一致。
 *    （`Number.isInteger` 顺带排掉 NaN / ±Infinity，故不再单写 `isFinite`。）
 *
 *    加了整数守卫之后 `Math.floor(requested)` 是**死操作**，已删 —— 留着会让
 *    下一个人以为小数是被支持的。
 *
 * 错误文案把**两个入参都打出来**：这两条会经 `markFailed` →
 * `lib/http-error.ts` 的 `diagnosableErrorText` 落进 `error_message`，
 * 再由管理端批次接口回给创作台前端 —— 只报一个值时，看日志的人不知道另一个是多少。
 */
export function resolveCandidateCount(requested: number, availableRefs: number): number {
  if (!Number.isInteger(requested) || requested < 1) {
    throw new Error(
      `候选数请求非法：requested=${requested}（必须是 ≥1 的整数；本次 availableRefs=${availableRefs}）`,
    );
  }
  if (!Number.isInteger(availableRefs) || availableRefs < 0) {
    throw new Error(
      `参考图数非法：availableRefs=${availableRefs}（必须是 ≥0 的整数；本次 requested=${requested}）`,
    );
  }
  const room = SEQUENTIAL_TOTAL_LIMIT - availableRefs;
  if (room < 1) {
    throw new Error(
      `参考图 ${availableRefs} 张已占满配额（上限 ${SEQUENTIAL_TOTAL_LIMIT}），出不了候选。` +
      `请减少风格参考图集（上限 ${MAX_STYLE_REFS} 张）或涂鸦标注图`,
    );
  }
  return Math.min(requested, room, MAX_CANDIDATES);
}
