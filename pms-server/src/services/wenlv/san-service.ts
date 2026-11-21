export type SanEnding = 'good' | 'normal' | 'bad';

/**
 * 应用 SAN 增减，钳制在 [0, 100]。
 */
export function applySanDelta(current: number, delta: number): number {
  return Math.max(0, Math.min(100, current + delta));
}

/**
 * 根据 SAN 值判定结局。
 * >=60 good, 30-59 normal, <30 bad。
 */
export function getEndingBySan(san: number): SanEnding {
  if (san >= 60) return 'good';
  if (san >= 30) return 'normal';
  return 'bad';
}
