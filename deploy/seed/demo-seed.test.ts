import { describe, it, expect } from 'vitest';
import { buildSeedPlan } from './demo-seed';

// 云栖山舍演示种子数据：只校验纯函数构建结果，不连库
describe('云栖山舍演示种子数据', () => {
  const plan = buildSeedPlan();

  it('固定品牌与商户，3 家门店、8 个房型', () => {
    expect(plan.merchantId).toBe('demo-yunqi');
    expect(plan.brand.name).toBe('云栖山舍');
    expect(plan.stores).toHaveLength(3);
    expect(plan.roomTypes).toHaveLength(8);
    expect(new Set(plan.stores.map((s) => s.name))).toEqual(
      new Set(['云栖山舍·青岩古镇店', '云栖山舍·镇远舞阳河店', '云栖山舍·西江千户苗寨店']),
    );
  });

  it('覆盖最近 90 天订单与价格日历', () => {
    expect(plan.days).toHaveLength(90);
    expect(plan.orders.length).toBeGreaterThan(0);
    // 每天每个门店一条价格日历
    expect(plan.pricingCalendar).toHaveLength(90 * 3);
    expect(plan.channelOrders.length).toBeGreaterThan(0);
  });

  it('周末入住率高于工作日', () => {
    const weekend = plan.days.filter((d) => d.isWeekend);
    const weekday = plan.days.filter((d) => !d.isWeekend);
    const avg = (rows: typeof plan.days) =>
      rows.reduce((sum, d) => sum + d.occupancyRate, 0) / rows.length;

    expect(weekend.length).toBeGreaterThan(0);
    expect(weekday.length).toBeGreaterThan(0);
    expect(avg(weekend)).toBeGreaterThan(avg(weekday));
    // 入住率本身必须落在 0~1
    expect(plan.days.every((d) => d.occupancyRate >= 0 && d.occupancyRate <= 1)).toBe(true);
  });

  it('两次构建结果深度相等（固定随机种子）', () => {
    expect(buildSeedPlan()).toEqual(plan);
  });

  it('订单金额与房价均为正数', () => {
    expect(plan.roomTypes.every((r) => r.basePrice > 0 && r.weekdayPrice > 0 && r.weekendPrice > 0)).toBe(true);
    expect(plan.pricingRules.every((r) => r.basePrice > 0 && r.weekdayPrice > 0 && r.weekendPrice > 0)).toBe(true);
    expect(plan.orders.every((o) => o.totalPrice > 0 && o.nights > 0)).toBe(true);
    expect(plan.pricingCalendar.every((c) => c.roomTypes.every((rt) => rt.price > 0 && rt.available >= 0))).toBe(true);
    expect(plan.competitorSnapshots.every((s) => s.price > 0)).toBe(true);
  });

  it('120 条评价、分数 1~5、含 6 条低分', () => {
    expect(plan.reviews).toHaveLength(120);
    expect(plan.reviews.every((r) => r.rating >= 1 && r.rating <= 5)).toBe(true);
    expect(plan.reviews.filter((r) => r.rating <= 2)).toHaveLength(6);
  });

  it('渠道含佣金比例与超时待确认样本', () => {
    expect(plan.channels.length).toBeGreaterThan(0);
    expect(plan.channels.some((c) => Number(c.commissionRate) > 0)).toBe(true);
    expect(plan.orders.some((o) => o.status === 'pending_confirm' && o.otaTimeout !== null)).toBe(true);
    expect(plan.channelOrders.some((o) => o.status === 'pending_confirm' && o.otaTimeout !== null)).toBe(true);
  });

  it('演示账号为商户管理员并绑定 3 家门店', () => {
    expect(plan.staff).toHaveLength(1);
    expect(plan.staff[0].phone).toBe('13800000000');
    expect(plan.staff[0].roleName).toBe('商户管理员');
    expect(plan.staff[0].scope).toBe('tenant');
    expect(plan.staffStorePermissions).toHaveLength(3);
  });
});
