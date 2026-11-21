/** 进件状态全集 */
export const APPLICATION_STATUSES = [
  'draft',        // 草稿（商家填写中）
  'reviewing',    // 平台审核中
  'rejected',     // 平台驳回
  'wx_submitted', // 已提交微信（M1 为人工在服务商后台提交）
  'wx_verifying', // 微信侧待账户验证
  'wx_signing',   // 微信侧待签约
  'finished',     // 进件完成（已获 sub_mchid）
  'wx_rejected',  // 微信驳回
] as const;

export type ApplicationStatus = (typeof APPLICATION_STATUSES)[number];

// 状态机：from → 允许的 to 集合
const TRANSITIONS: Record<ApplicationStatus, ApplicationStatus[]> = {
  draft: ['reviewing'],
  reviewing: ['rejected', 'wx_submitted'],
  rejected: ['reviewing'],
  wx_submitted: ['wx_verifying', 'wx_signing', 'finished', 'wx_rejected'],
  wx_verifying: ['wx_signing', 'finished', 'wx_rejected'],
  wx_signing: ['finished', 'wx_rejected'],
  finished: [],
  wx_rejected: ['reviewing'],
};

/** 校验状态流转是否合法 */
export function canTransition(from: string, to: string): boolean {
  const allowed = TRANSITIONS[from as ApplicationStatus];
  return Array.isArray(allowed) && allowed.includes(to as ApplicationStatus);
}
