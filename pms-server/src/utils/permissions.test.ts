import { describe, it, expect } from 'vitest';
import { hasPermission, getAllPermissionKeys } from './permissions.js';

describe('assets 权限', () => {
  it('权限树包含 assets:manage', () => {
    expect(getAllPermissionKeys()).toContain('assets:manage');
  });
  it('拥有 assets:manage 可管理素材任务', () => {
    expect(hasPermission(['assets:manage'], 'assets:manage')).toBe(true);
    expect(hasPermission(['dashboard:view'], 'assets:manage')).toBe(false);
  });
});
