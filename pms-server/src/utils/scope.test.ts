import { describe, it, expect } from 'vitest';
import { isAllStoresScope } from './scope.js';

describe('isAllStoresScope（全部门店范围判断）', () => {
  it('内部值 tenant 视为全部门店', () => {
    expect(isAllStoresScope('tenant')).toBe(true);
  });

  it('历史中文值「全部门店」视为全部门店', () => {
    expect(isAllStoresScope('全部门店')).toBe(true);
  });

  it('store/brand 为门店/品牌级，非全部门店', () => {
    expect(isAllStoresScope('store')).toBe(false);
    expect(isAllStoresScope('brand')).toBe(false);
  });

  it('空/未赋值不是全部门店', () => {
    expect(isAllStoresScope(undefined)).toBe(false);
    expect(isAllStoresScope(null)).toBe(false);
    expect(isAllStoresScope('')).toBe(false);
  });
});
