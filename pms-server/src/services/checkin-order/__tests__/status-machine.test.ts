import { describe, it, expect } from 'vitest';
import {
  CHECKIN_ORDER_STATUSES, ALLOWED_TRANSITIONS, isCheckinOrderStatus,
  transitionError, requiredReasonField, STATUS_LABELS,
} from '../status-machine.js';

describe('状态枚举', () => {
  it('恰好 6 个状态，且含新增的 booked', () => {
    expect([...CHECKIN_ORDER_STATUSES]).toEqual([
      'booked', 'checked_in', 'checked_out', 'completed', 'cancelled', 'refunded',
    ]);
  });

  it('每个状态都有中文标签', () => {
    for (const s of CHECKIN_ORDER_STATUSES) expect(STATUS_LABELS[s]).toBeTruthy();
  });

  it('isCheckinOrderStatus 只认枚举内取值', () => {
    expect(isCheckinOrderStatus('booked')).toBe(true);
    expect(isCheckinOrderStatus('paid')).toBe(false);
    expect(isCheckinOrderStatus(undefined)).toBe(false);
  });
});

describe('合法流转（规格 §6 表格逐条）', () => {
  const LEGAL: [string, string][] = [
    ['booked', 'checked_in'], ['booked', 'cancelled'],
    ['checked_in', 'checked_out'], ['checked_in', 'cancelled'],
    ['checked_out', 'completed'], ['checked_out', 'cancelled'],
    ['completed', 'refunded'],
  ];

  it.each(LEGAL)('%s → %s 允许', (from, to) => {
    expect(transitionError(from, to as any)).toBeNull();
  });

  it('合法流转表与规格逐字一致', () => {
    expect(ALLOWED_TRANSITIONS.booked).toEqual(['checked_in', 'cancelled']);
    expect(ALLOWED_TRANSITIONS.checked_in).toEqual(['checked_out', 'cancelled']);
    expect(ALLOWED_TRANSITIONS.checked_out).toEqual(['completed', 'cancelled']);
    expect(ALLOWED_TRANSITIONS.completed).toEqual(['refunded']);
    expect(ALLOWED_TRANSITIONS.cancelled).toEqual([]);
    expect(ALLOWED_TRANSITIONS.refunded).toEqual([]);
  });
});

describe('非法流转', () => {
  it('已结算不能改回待入住，且提示明确', () => {
    expect(transitionError('completed', 'booked')).toBe('「已结算」不能变更为「待入住」');
  });

  it('已取消是终态', () => {
    expect(transitionError('cancelled', 'checked_in')).toBe('「已取消」不能变更为「已入住」');
    expect(transitionError('cancelled', 'completed')).toBe('「已取消」不能变更为「已结算」');
  });

  it('有退款是终态', () => {
    expect(transitionError('refunded', 'completed')).toBe('「有退款」不能变更为「已结算」');
  });

  it('不可跳级', () => {
    expect(transitionError('booked', 'completed')).toBe('「待入住」不能变更为「已结算」');
    expect(transitionError('booked', 'checked_out')).toBe('「待入住」不能变更为「已离店」');
  });

  it('同状态重复流转被拒', () => {
    expect(transitionError('checked_in', 'checked_in')).toBe('订单已处于「已入住」');
  });

  it('未知的前置状态被拒', () => {
    expect(transitionError('paid', 'checked_in')).toBe('未知的当前状态「paid」');
  });
});

describe('原因字段要求', () => {
  it('转 cancelled 需 cancelReason', () => {
    expect(requiredReasonField('cancelled')).toBe('cancelReason');
  });
  it('转 refunded 需 refundReason', () => {
    expect(requiredReasonField('refunded')).toBe('refundReason');
  });
  it('其他状态不需要原因', () => {
    expect(requiredReasonField('checked_in')).toBeNull();
    expect(requiredReasonField('checked_out')).toBeNull();
    expect(requiredReasonField('completed')).toBeNull();
  });
});
