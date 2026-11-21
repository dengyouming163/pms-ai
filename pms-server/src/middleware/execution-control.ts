import type { Context, Next } from 'hono';

export function checkExecutionLevel(actionLevel: string, currentUserScope: string): { allowed: boolean; reason?: string } {
  if (actionLevel === 'L1') return { allowed: true };
  if (actionLevel === 'L2') {
    if (['merchant', 'store', 'staff'].includes(currentUserScope)) return { allowed: true };
    return { allowed: false, reason: 'L2 操作需要至少前台及以上权限确认' };
  }
  if (actionLevel === 'L3') {
    if (currentUserScope === 'merchant') return { allowed: true };
    return { allowed: false, reason: 'L3 高风险操作仅老板可审核' };
  }
  return { allowed: false, reason: '未知执行级别' };
}
