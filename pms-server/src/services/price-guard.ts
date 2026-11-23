/**
 * 调价护栏（纯函数，不访问数据库）。
 *
 * 供 POST /api/internal/agent-tools/price-adjust 在写入前做业务校验：
 * 1. 当前价 / 目标价必须为正且有限；
 * 2. 目标价不得与当前价相同（无意义调价）；
 * 3. 目标价不得低于房型最低价；
 * 4. 调价幅度（绝对值）不得超过 maxDeltaPct。
 *
 * 恒返回 deltaPct（带符号百分比，四舍五入取整），即便校验不通过也回传，
 * 便于端点在 422 响应与成功响应中统一回显。
 */
export interface PriceAdjustmentInput {
  currentPrice: number;
  nextPrice: number;
  minPrice: number;
  maxDeltaPct: number;
}

export interface PriceAdjustmentResult {
  ok: boolean;
  reason?: string;
  deltaPct: number;
}

/**
 * 校验一次调价请求是否被允许。
 * @returns ok=true 表示通过；否则 ok=false 并给出 reason，deltaPct 始终带值。
 */
export function checkPriceAdjustment(input: PriceAdjustmentInput): PriceAdjustmentResult {
  const { currentPrice, nextPrice, minPrice, maxDeltaPct } = input;

  // 1. 当前价必须为正且有限（来自日历行，理论上恒正，这里防御性兜底避免除零）
  if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
    return { ok: false, reason: '当前价必须为正数', deltaPct: 0 };
  }
  // 2. 目标价必须为正且有限
  if (!Number.isFinite(nextPrice) || nextPrice <= 0) {
    return { ok: false, reason: '目标价必须为正数', deltaPct: 0 };
  }
  // 3. 目标价不得与当前价相同
  if (nextPrice === currentPrice) {
    return { ok: false, reason: '目标价与当前价相同，无需调价', deltaPct: 0 };
  }
  // 4. 目标价不得低于最低价
  if (nextPrice < minPrice) {
    return { ok: false, reason: `目标价 ${nextPrice} 低于最低价 ${minPrice}`, deltaPct: 0 };
  }

  // 5. 调价幅度校验：用未取整的原始幅度做边界判断，避免 30.4% 四舍五入成 30% 后漏放
  const rawDeltaPct = ((nextPrice - currentPrice) / currentPrice) * 100;
  const deltaPct = Math.round(rawDeltaPct);
  if (Math.abs(rawDeltaPct) > maxDeltaPct) {
    return {
      ok: false,
      reason: `调价幅度 ${Math.round(Math.abs(rawDeltaPct))}% 超过上限 ${maxDeltaPct}%`,
      deltaPct,
    };
  }

  return { ok: true, deltaPct };
}
