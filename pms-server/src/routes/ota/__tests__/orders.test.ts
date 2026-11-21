import { describe, it, expect } from 'vitest';
import { mapOtaStatus, shouldApplyOtaUpdate } from '../orders.js';

describe('mapOtaStatus（OTA 状态 → 住宿订单状态）', () => {
  it('五态映射表', () => {
    expect(mapOtaStatus('new')).toBe('pending_confirm');
    expect(mapOtaStatus('confirmed')).toBe('pending_confirm');
    expect(mapOtaStatus('checked_in')).toBe('checked_in');
    expect(mapOtaStatus('completed')).toBe('checked_out');
    expect(mapOtaStatus('cancelled')).toBe('cancelled');
  });
  it('未知状态回退 pending_confirm', () => {
    expect(mapOtaStatus('unknown')).toBe('pending_confirm');
  });
});

describe('shouldApplyOtaUpdate（重复抓取更新判定）', () => {
  it('员工已接单（confirmed）不被重复抓取降级回 pending_confirm', () => {
    expect(shouldApplyOtaUpdate('confirmed', 'pending_confirm')).toBe(false);
  });
  it('pending_confirm 重复抓取 pending_confirm 不写', () => {
    expect(shouldApplyOtaUpdate('pending_confirm', 'pending_confirm')).toBe(false);
  });
  it('confirmed → checked_in 可推进（到店）', () => {
    expect(shouldApplyOtaUpdate('confirmed', 'checked_in')).toBe(true);
  });
  it('checked_in → checked_out 可推进（离店）', () => {
    expect(shouldApplyOtaUpdate('checked_in', 'checked_out')).toBe(true);
  });
  it('取消始终同步（含从已确认取消）', () => {
    expect(shouldApplyOtaUpdate('confirmed', 'cancelled')).toBe(true);
  });
  it('终态不回退：已取消不被回写', () => {
    expect(shouldApplyOtaUpdate('cancelled', 'pending_confirm')).toBe(false);
    expect(shouldApplyOtaUpdate('checked_out', 'checked_in')).toBe(false);
  });
});
