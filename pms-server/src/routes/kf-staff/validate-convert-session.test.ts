import { describe, it, expect } from 'vitest';
import { validateConvertSessionBody } from './index.js';

describe('validateConvertSessionBody', () => {
  it('合法 body 返回 { externalUserid, storeId }', () => {
    expect(validateConvertSessionBody({ externalUserid: 'wm_x', storeId: 'store-1' }))
      .toEqual({ externalUserid: 'wm_x', storeId: 'store-1' });
  });

  it('缺字段返回 null', () => {
    expect(validateConvertSessionBody({ externalUserid: 'wm_x' })).toBe(null);
    expect(validateConvertSessionBody({ storeId: 'store-1' })).toBe(null);
    expect(validateConvertSessionBody({})).toBe(null);
    expect(validateConvertSessionBody(null)).toBe(null);
  });

  it('空白 trim 后合法', () => {
    expect(validateConvertSessionBody({ externalUserid: '  wm_x  ', storeId: ' store-1 ' }))
      .toEqual({ externalUserid: 'wm_x', storeId: 'store-1' });
  });
});
