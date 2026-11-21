import { describe, it, expect } from 'vitest';
import { canTransition, APPLICATION_STATUSES } from './merchant-apply.js';

describe('进件状态机', () => {
  it('合法流转', () => {
    expect(canTransition('draft', 'reviewing')).toBe(true);       // 商家提交
    expect(canTransition('reviewing', 'rejected')).toBe(true);    // 平台驳回
    expect(canTransition('reviewing', 'wx_submitted')).toBe(true);// 平台通过并提交微信
    expect(canTransition('rejected', 'reviewing')).toBe(true);    // 改后重提
    expect(canTransition('wx_submitted', 'wx_signing')).toBe(true);
    expect(canTransition('wx_signing', 'finished')).toBe(true);
    expect(canTransition('wx_submitted', 'wx_rejected')).toBe(true);
    expect(canTransition('wx_rejected', 'reviewing')).toBe(true); // 微信驳回后改资料重走
  });
  it('非法流转拒绝', () => {
    expect(canTransition('draft', 'finished')).toBe(false);
    expect(canTransition('finished', 'draft')).toBe(false);
    expect(canTransition('reviewing', 'draft')).toBe(false);
  });
  it('状态集合完整', () => {
    expect(APPLICATION_STATUSES).toEqual([
      'draft', 'reviewing', 'rejected', 'wx_submitted', 'wx_verifying', 'wx_signing', 'finished', 'wx_rejected',
    ]);
  });
});
