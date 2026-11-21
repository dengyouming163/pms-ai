import { describe, it, expect } from 'vitest';
import { computeTick } from '../director';

describe('computeTick（导演决策纯函数）', () => {
  const base = {
    now: new Date('2026-10-07T21:00:00+08:00'),
    state: { lastActionAt: '2026-10-07T20:00:00+08:00', lastKey: 'n1:a1', stallNotified: false } as never,
    stallMinutes: 20,
  };

  it('同一原子停滞超阈值 ⇒ 返回 stall 干预 + warn 报警', () => {
    const r = computeTick({ ...base, event: { key: 'n1:a1' } });
    expect(r.intervention?.kind).toBe('stall-hint');
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].level).toBe('warn');
    expect(r.alerts[0].kind).toBe('stall');
    expect(r.state.stallNotified).toBe(true);
  });

  it('换了原子/节点 ⇒ 只刷新 lastActionAt，不报警', () => {
    const r = computeTick({ ...base, event: { key: 'n2:a1' } });
    expect(r.intervention).toBeNull();
    expect(r.alerts).toHaveLength(0);
    expect(r.state.lastActionAt).toBe(base.now.toISOString());
    expect(r.state.lastKey).toBe('n2:a1');
  });

  it('停滞已通知过 ⇒ 不重复报警（幂等）', () => {
    const r = computeTick({
      ...base,
      state: { lastActionAt: '2026-10-07T20:00:00+08:00', lastKey: 'n1:a1', stallNotified: true } as never,
      event: { key: 'n1:a1' },
    });
    expect(r.alerts).toHaveLength(0);
    expect(r.intervention).toBeNull();
  });

  it('硬锚点：越过 dueAt 且未 fired ⇒ 返回 anchor 干预并标记', () => {
    const r = computeTick({
      ...base,
      anchors: [{ key: 'private-visit', dueAt: '2026-10-07T20:30:00+08:00', action: 'npc-message', nodeId: 'n9', fired: false }] as never,
      event: { key: 'n2:a1' },
    });
    expect(r.intervention?.kind).toBe('anchor');
    expect(r.intervention?.nodeId).toBe('n9');
    expect(r.state.anchors?.[0].fired).toBe(true);
  });

  it('长时间无任何动作（>90min）⇒ static 警报（睡着/离场）', () => {
    // 计划 L1392 该用例为空壳，此处按用例描述补全：停滞 120 分钟、同一原子，
    // 不再下发 stall-hint（人已不在场前，暗示无意义），只产生 static 警报。
    const r = computeTick({
      ...base,
      state: { lastActionAt: '2026-10-07T19:00:00+08:00', lastKey: 'n1:a1', stallNotified: false } as never,
      event: { key: 'n1:a1' },
    });
    expect(r.alerts).toHaveLength(1);
    expect(r.alerts[0].kind).toBe('static');
    expect(r.intervention).toBeNull();
  });

  it('static 警报同样幂等：已通知过不重复产生', () => {
    const r = computeTick({
      ...base,
      state: { lastActionAt: '2026-10-07T19:00:00+08:00', lastKey: 'n1:a1', staticNotified: true } as never,
      event: { key: 'n1:a1' },
    });
    expect(r.alerts).toHaveLength(0);
  });

  it('硬锚点已 fired ⇒ 不重复干预', () => {
    const r = computeTick({
      ...base,
      anchors: [{ key: 'private-visit', dueAt: '2026-10-07T20:30:00+08:00', action: 'npc-message', nodeId: 'n9', fired: true }] as never,
      event: { key: 'n2:a1' },
    });
    expect(r.intervention).toBeNull();
    expect(r.state.anchors?.[0].fired).toBe(true);
  });
});
