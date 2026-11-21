/**
 * 员工范围（scope）公共判断工具。
 *
 * DB 中 scope 取值不统一：新员工写入内部值 'tenant'，历史员工写入中文值「全部门店」，
 * 两者语义相同（均为全部门店范围）。任何「是否全部门店」的判断必须用本函数兼容两种值，
 * 避免仅比对 'tenant' 导致全部门店员工被误判为门店级（如登录门店列表为空）。
 *
 * 注意：platform.ts 的平台运营权限**刻意**保持只认 'tenant'，不用本函数——
 * 全部门店（如客服）≠ 平台运营方，后者是敏感的进件审核/跨平台管理权限，不应因「全部门店」自动授予。
 */
export function isAllStoresScope(scope?: string | null): boolean {
  return scope === 'tenant' || scope === '全部门店';
}
