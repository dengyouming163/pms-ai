/**
 * 权限体系 — 可配置权限树 + 校验工具
 * 格式：module:action（如 rooms:view、orders:edit）
 * 特殊值：'all' 或 '*' = 超级管理员全部权限
 */

export interface PermissionNode {
  key: string;
  label: string;
  children?: PermissionNode[];
}

/** 完整权限树（PC端+移动端共用，AI工作台子模块独立） */
export const PERMISSION_TREE: PermissionNode[] = [
  { key: 'dashboard', label: '工作台', children: [{ key: 'dashboard:view', label: '查看工作台' }] },
  { key: 'stores', label: '门店管理', children: [
    { key: 'stores:view', label: '查看门店' },
    { key: 'stores:edit', label: '编辑门店' },
  ]},
  { key: 'rooms', label: '房态管理', children: [
    { key: 'rooms:view', label: '查看房态' },
    { key: 'rooms:edit', label: '编辑房态' },
  ]},
  { key: 'orders', label: '订单管理', children: [
    { key: 'orders:view', label: '查看订单' },
    { key: 'orders:create', label: '创建订单' },
    { key: 'orders:edit', label: '编辑订单' },
  ]},
  { key: 'pricing', label: '价格管理', children: [
    { key: 'pricing:view', label: '查看价格' },
    { key: 'pricing:edit', label: '编辑价格' },
  ]},
  { key: 'channels', label: '渠道管理', children: [
    { key: 'channels:view', label: '查看渠道' },
    { key: 'channels:edit', label: '配置渠道' },
  ]},
  { key: 'finance', label: '财务管理', children: [{ key: 'finance:view', label: '查看财务' }] },
  { key: 'customers', label: '客户管理', children: [
    { key: 'customers:view', label: '查看客户' },
    { key: 'customers:edit', label: '编辑客户' },
  ]},
  { key: 'staff', label: '团队管理', children: [
    { key: 'staff:view', label: '查看团队' },
    { key: 'staff:edit', label: '管理团队' },
  ]},
  { key: 'assets', label: '素材库', children: [
    { key: 'assets:manage', label: '管理素材与打卡任务' },
  ]},
  { key: 'settings', label: '系统设置', children: [
    { key: 'settings:view', label: '查看设置' },
    { key: 'settings:edit', label: '修改设置' },
  ]},
  { key: 'housekeeping', label: '客房服务', children: [
    { key: 'housekeeping:view', label: '查看服务' },
    { key: 'housekeeping:edit', label: '管理服务' },
  ]},
  // AI 工作台子模块（独立权限）
  { key: 'ai-pricing', label: 'AI智能定价', children: [{ key: 'ai-pricing:view', label: '使用' }] },
  { key: 'ai-content', label: 'AI内容创作', children: [
    { key: 'ai-content:view', label: '查看' },
    { key: 'ai-content:create', label: '创作' },
  ]},
  { key: 'ai-video', label: 'AI视频生成', children: [
    { key: 'ai-video:view', label: '查看' },
    { key: 'ai-video:create', label: '生成' },
  ]},
  { key: 'ai-competitor', label: '竞品分析', children: [{ key: 'ai-competitor:view', label: '使用' }] },
  { key: 'ai-voice', label: '声音克隆', children: [{ key: 'ai-voice:view', label: '使用' }] },
];

/**
 * 检查用户是否有指定权限
 * userPermissions: 用户拥有的权限列表
 * required: 需要的权限（支持多个，满足任一即可）
 */
export function hasPermission(userPermissions: string[], ...required: string[]): boolean {
  if (!userPermissions || userPermissions.length === 0) return false; // 空=未配置=拒绝（严格权限，防越权）
  if (userPermissions.includes('all') || userPermissions.includes('*')) return true;
  return required.some(p => userPermissions.includes(p));
}

/** 获取所有叶子权限 key 列表 */
export function getAllPermissionKeys(): string[] {
  const keys: string[] = [];
  for (const node of PERMISSION_TREE) {
    if (node.children) {
      for (const child of node.children) keys.push(child.key);
    } else {
      keys.push(node.key);
    }
  }
  return keys;
}

/** 预置角色默认权限 */
export const PRESET_ROLE_PERMISSIONS: Record<string, string[]> = {
  '超级管理员': ['all'],
  '酒店经理': ['dashboard:view','stores:view','rooms:view','rooms:edit','orders:view','orders:create','orders:edit','pricing:view','pricing:edit','customers:view','customers:edit','housekeeping:view','housekeeping:edit','assets:manage'],
  '前台接待': ['rooms:view','orders:view','orders:create','customers:view'],
  '财务专员': ['finance:view','orders:view','pricing:view'],
  '渠道运营': ['channels:view','channels:edit','orders:view'],
};
