import { describe, it, expect } from 'vitest';
import { buildOauthAuthorizeUrl, resolveStaffJwtPayload } from '../oauth.js';

describe('企微 OAuth 纯函数', () => {
  it('buildOauthAuthorizeUrl 拼装企微授权链接', () => {
    const url = buildOauthAuthorizeUrl({
      corpId: 'ww_abc',
      redirectUri: 'https://pms.kyyp.cn/kf-staff/oauth/callback',
    });
    expect(url).toContain('open.weixin.qq.com/connect/oauth2/authorize');
    expect(url).toContain('appid=ww_abc');
    expect(url).toContain(encodeURIComponent('https://pms.kyyp.cn/kf-staff/oauth/callback'));
    expect(url).toContain('snsapi_base');
  });

  it('resolveStaffJwtPayload 命中 wecom_userid 返回员工载荷', () => {
    const payload = resolveStaffJwtPayload({
      staff: {
        id: 's_1', name: '张三', phone: '13800000000', merchantId: 'default',
        roleId: 'r1', scope: 'store', stores: ['pms-001', 'pms-002'], wecomUserid: 'wm_staff_1',
      },
      wecomUserid: 'wm_staff_1',
    });
    expect(payload).not.toBe(null);
    expect(payload!.userId).toBe('s_1');
    expect(payload!.accessibleStores).toEqual(['pms-001', 'pms-002']);
    expect(payload!.homeStoreId).toBe('pms-001');
  });

  it('wecom_userid 不匹配返回 null（走绑定流程）', () => {
    const payload = resolveStaffJwtPayload({
      staff: { id: 's_1', name: '张三', phone: '138', merchantId: 'default', roleId: 'r1', scope: 'store', stores: [], wecomUserid: 'wm_bound_other' },
      wecomUserid: 'wm_other',
    });
    expect(payload).toBe(null);
  });

  it('员工未绑定 wecom_userid 时直接放行（历史数据兼容）', () => {
    const payload = resolveStaffJwtPayload({
      staff: { id: 's_1', name: '张三', phone: '138', merchantId: 'default', roleId: 'r1', scope: 'store', stores: [] },
      wecomUserid: 'wm_any',
    });
    expect(payload).not.toBe(null);
  });
});
