import { describe, it, expect } from 'vitest';
import { mergeCustomers } from '../index.js';

describe('kf-staff customers 合并', () => {
  it('mergeCustomers 客服会话客户在前、外部联系人在后，均带来源标签', () => {
    const kf = [{ customerId: 1, name: 'A', channel: 'kf', sessionId: 5 }];
    const ext = [{ externalUserid: 'wm_x', name: 'B', channel: 'external' }];
    const out = mergeCustomers(kf, ext);
    expect(out).toEqual([...kf, ...ext]);
    expect(out[0].channel).toBe('kf');
    expect(out[1].channel).toBe('external');
  });

  it('mergeCustomers 空输入返回空数组', () => {
    expect(mergeCustomers([], [])).toEqual([]);
  });
});
