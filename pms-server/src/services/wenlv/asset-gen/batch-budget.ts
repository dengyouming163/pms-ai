/**
 * 批次花费熔断（子项目①）。
 *
 * ## 为什么不复用总闸
 *
 * `isAssetGenPaused()` 是 env + 内存的**总闸**，只有全开 / 全停两种状态 ——
 * 一个批次失控就把**全平台**的素材生成停掉，代价与问题不成比例。
 *
 * ## 为什么按批次而不是按小时
 *
 * `asset_jobs.batch_id` 是 notNull 列，`SUM(cost_amount) GROUP BY batch_id` 是现成的，
 * 一次查询就能拿到本批已花金额。按批次还顺带回答了「是哪个批次在烧钱」。
 */

/** 默认上限（元）。可用 env `WENLV_BATCH_BUDGET_YUAN` 覆盖。 */
const DEFAULT_LIMIT_YUAN = 20;

/** 单价合法性上界，与 pricing.ts 同口径（防手滑多打几个 0）。 */
const MAX_LIMIT_YUAN = 1e4;

export function batchBudgetLimit(): number {
  // 必须 trim 后判空：`Number('  ')` 是 0（不是 NaN），会被当成**显式设置成 0**，
  // 静默变成「这个批次一分钱都不许花」。与 pricing.ts 的 envPrice 同一条口径。
  const raw = (process.env.WENLV_BATCH_BUDGET_YUAN ?? '').trim();
  if (raw === '') return DEFAULT_LIMIT_YUAN;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0 && n <= MAX_LIMIT_YUAN) return n;
  // 文案必须与上面的条件（`n > 0`）一致：`0` 会走到这里，说「须为 0–10000」等于
  // 一边告警「0 非法」一边宣称 0 合法。**0 是无效值不是「冻结本批」** ——
  // 急停请用 WENLV_ASSET_GEN_PAUSED（总闸），不要用「把上限设成 0」。
  console.warn(
    `[wenlv-asset-gen] WENLV_BATCH_BUDGET_YUAN 的值「${raw}」不是有效金额（须为大于 0 且不超过 ${MAX_LIMIT_YUAN} 的金额），本次按默认 ¥${DEFAULT_LIMIT_YUAN} 处理`,
  );
  return DEFAULT_LIMIT_YUAN;
}

/**
 * 是否已超预算。用 `>=` —— 正好等于上限就停，
 * 免得「上限 ¥20」被读成「¥20 可以再花一笔」。
 */
export function exceededBatchBudget(spentYuan: number, limitYuan: number): boolean {
  if (!Number.isFinite(spentYuan)) return false;   // 读不到金额时不误停
  return spentYuan >= limitYuan;
}
