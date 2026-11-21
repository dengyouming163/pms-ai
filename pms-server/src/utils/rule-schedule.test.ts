import { describe, it, expect } from 'vitest';
import { calcNextRunAt, isDueRule, buildTaskFromRule } from './rule-schedule.js';

/** 北京墙钟格式化工具（与运行环境时区无关）：返回某个 instant 在北京显示的 YYYY-MM-DD HH:mm */
function bjWall(d: Date): string {
  const bj = new Date(d.getTime() + 8 * 3600 * 1000); // 平移 +8h 后用 UTC 字段读北京墙钟
  const p = (n: number) => String(n).padStart(2, '0');
  return `${bj.getUTCFullYear()}-${p(bj.getUTCMonth() + 1)}-${p(bj.getUTCDate())} ${p(bj.getUTCHours())}:${p(bj.getUTCMinutes())}`;
}

describe('calcNextRunAt', () => {
  it('今天 09:00 已过则次日（北京墙钟 09:00）', () => {
    const from = new Date('2026-08-06T10:00:00+08:00'); // 北京 08-06 10:00
    const next = calcNextRunAt('09:00', from);
    expect(bjWall(next)).toBe('2026-08-07 09:00');
  });
  it('今天 09:00 未过则当天（北京墙钟 09:00）', () => {
    const from = new Date('2026-08-06T08:00:00+08:00'); // 北京 08-06 08:00
    const next = calcNextRunAt('09:00', from);
    expect(bjWall(next)).toBe('2026-08-06 09:00');
  });
  it('非法输入回退 09:00 且不产生 Invalid Date', () => {
    const from = new Date('2026-08-06T08:00:00+08:00');
    const next = calcNextRunAt('abc', from);
    expect(Number.isNaN(next.getTime())).toBe(false);
    expect(bjWall(next)).toBe('2026-08-06 09:00');
  });
  it('返回的北京墙钟恒等于 publishTime（时区无关）', () => {
    // from 为北京 08-06 12:00：早于 12:00 的已过 → 次日；晚于 12:00 的未到 → 当日
    for (const t of ['00:00', '07:30', '09:00', '18:00', '23:59']) {
      const from = new Date('2026-08-06T12:00:00+08:00');
      const next = calcNextRunAt(t, from);
      const [h, min] = t.split(':').map(Number);
      const day = h * 60 + min < 12 * 60 ? '07' : '06';
      expect(bjWall(next)).toBe(`2026-08-${day} ${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`);
    }
  });
});

describe('isDueRule 到期判定', () => {
  it('enabled 且 nextRunAt<=now → 到期', () => {
    const now = new Date('2026-08-06T09:00:00+08:00');
    expect(isDueRule({ status: 'enabled', nextRunAt: new Date('2026-08-06T09:00:00+08:00') } as any, now)).toBe(true);
  });
  it('disabled 不到期', () => {
    const now = new Date('2026-08-06T09:00:00+08:00');
    expect(isDueRule({ status: 'disabled', nextRunAt: new Date('2026-08-06T08:00:00+08:00') } as any, now)).toBe(false);
  });
});

describe('buildTaskFromRule 规则→任务体', () => {
  it('映射规则字段为任务创建体并生成北京 23:59:59 截止', () => {
    const rule = { name: '每日房态', templateRefs: ['t1'], roomTypeIds: ['rt1'],
      roomTypeNames: ['大床房'], purposeTags: ['短视频剪辑'], guideText: '', assigneeScope: 'all',
      assigneeStaffIds: [] } as any;
    const body = buildTaskFromRule(rule, '2026-08-06');
    expect(body.title).toBe('每日房态');
    expect(body.taskDate).toBe('2026-08-06');
    expect(body.roomTypeIds).toEqual(['rt1']);
    expect(body.roomTypeNames).toEqual(['大床房']);
    expect(body.deadline).toEqual(new Date('2026-08-06T23:59:59+08:00'));
  });
});
