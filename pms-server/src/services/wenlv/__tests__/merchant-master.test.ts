// merchant-master 纯函数测试：buildMerchantMasterWhere 的空参/q/status/组合四分支。
// 纯内存，不打库、不 mock db（同 funnel.test 范式）；where 经 PgDialect 编译成 SQL 文本
// 断言 —— 让「like 落在 name/contact_name 两列」这类口径可读、可回归。
import { describe, it, expect } from 'vitest';
import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { buildMerchantMasterWhere } from '../merchant-master.js';

const dialect = new PgDialect();
const compile = (w: ReturnType<typeof buildMerchantMasterWhere>) => (w ? dialect.sqlToQuery(w as SQL) : null);

describe('buildMerchantMasterWhere', () => {
  it('空参 ⇒ undefined（无 where，列表全量）；纯空白 q 视同未传', () => {
    expect(buildMerchantMasterWhere({})).toBeUndefined();
    expect(buildMerchantMasterWhere({ q: '   ' })).toBeUndefined();
  });

  it('仅 q ⇒ like 落在 name 与 contact_name 两列，参数带 % 通配', () => {
    const r = compile(buildMerchantMasterWhere({ q: '民宿' }));
    expect(r?.sql).toContain('"pms_bui_wenlv_merchants"."name" like $1');
    expect(r?.sql).toContain('"pms_bui_wenlv_merchants"."contact_name" like $2');
    expect(r?.params).toEqual(['%民宿%', '%民宿%']);
  });

  it('仅 status ⇒ 单一等值条件', () => {
    const r = compile(buildMerchantMasterWhere({ status: 'suspended' }));
    expect(r?.sql).toContain('"pms_bui_wenlv_merchants"."status" = $1');
    expect(r?.params).toEqual(['suspended']);
  });

  it('q + status 组合 ⇒ or 与 eq 以 and 叠加，参数顺序与条件一致', () => {
    const r = compile(buildMerchantMasterWhere({ q: '老周', status: 'active' }));
    expect(r?.sql).toContain(' or ');
    expect(r?.sql).toContain(' and ');
    expect(r?.params).toEqual(['%老周%', '%老周%', 'active']);
  });
});
