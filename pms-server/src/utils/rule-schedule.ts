// src/utils/rule-schedule.ts
/** 北京时间 = UTC+8（与 price-robot-scheduler 的 BJ_OFFSET_MS 一致） */
export const BJ_OFFSET_MS = 8 * 3600 * 1000;

/**
 * 计算下次执行时间：北京时区今天 publishTime（已过则次日）。非法格式回退 09:00，绝不产生 Invalid Date。
 * 实现：把 from 的 instant 平移 +8h，使其 UTC 字段恰好等于 from 的北京墙钟（含北京日期）；
 * 再以该北京日期 + publishTime 构造「假想的 UTC 墙钟」，减回 +8h 得到真实 UTC instant。
 * 全程只用 getUTC 系列和 Date.UTC，不依赖进程本地时区（容器 TZ=UTC 或 TZ=Asia/Shanghai 结果一致），
 * 返回的 Date 其北京墙钟恒等于 publishTime。
 */
export function calcNextRunAt(publishTime: string, from = new Date()): Date {
  const mt = (publishTime || '09:00').match(/^(\d{1,2}):(\d{2})$/);
  const h = mt ? Math.min(Number(mt[1]), 23) : 9;
  const min = mt ? Math.min(Number(mt[2]), 59) : 0;
  const bj = new Date(from.getTime() + BJ_OFFSET_MS); // bj 的 UTC 字段 = from 的北京墙钟
  // 北京 h:min 对应的真实 instant = 假想 UTC 墙钟(Date.UTC) - 8h
  const next = new Date(Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), h, min, 0, 0) - BJ_OFFSET_MS);
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1); // 今日已过 → 次日
  return next;
}

/** 规则是否到期（enabled 且 nextRunAt 不晚于 now） */
export function isDueRule(rule: { status: string; nextRunAt?: Date | string | null }, now = new Date()): boolean {
  if (rule.status !== 'enabled') return false;
  if (!rule.nextRunAt) return false;
  return new Date(rule.nextRunAt).getTime() <= now.getTime();
}

/** 规则 → 任务创建体（taskDate = 触发当天；shotRequirements 由 scheduler 从模板构建） */
export function buildTaskFromRule(rule: any, taskDate: string) {
  return {
    title: rule.name,
    taskDate,
    // 任务当日北京 23:59:59 截止（显式 +08:00 字面量，与进程时区无关）
    deadline: new Date(`${taskDate}T23:59:59+08:00`),
    templateRefs: rule.templateRefs || [],
    roomTypeIds: rule.roomTypeIds || [],
    roomTypeNames: rule.roomTypeNames || [],
    purposeTags: rule.purposeTags || [],
    guideText: rule.guideText || '',
    assigneeScope: rule.assigneeScope || 'all',
    assigneeStaffIds: rule.assigneeStaffIds || [],
    shotRequirements: [],
  };
}
