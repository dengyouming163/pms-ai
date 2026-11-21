import { describe, it, expect } from 'vitest';
import { deriveDeliveryStage, firstScriptDeliveryDays, scriptDeliveryDays } from '../wenlv-delivery.js';

const D = (s: string) => new Date(s);

describe('剧本交付阶段推导', () => {
  it('无起稿 = 未起稿', () => {
    expect(deriveDeliveryStage({})).toBe('not_started');
  });

  it('有起稿无定稿 = 生成中', () => {
    expect(deriveDeliveryStage({ generationStartedAt: D('2026-09-12T00:00:00Z') })).toBe('generating');
  });

  it('有定稿无上架 = 可上架', () => {
    expect(deriveDeliveryStage({
      generationStartedAt: D('2026-09-12T00:00:00Z'), contentReadyAt: D('2026-09-13T00:00:00Z'),
    })).toBe('ready');
  });

  it('有上架 = 已上线（即使起稿时间缺失也算，以实际上架为准）', () => {
    expect(deriveDeliveryStage({ publishedAt: D('2026-09-14T00:00:00Z') })).toBe('live');
  });

  it('无效时间戳等同没盖章（不返回「已上线」）', () => {
    expect(deriveDeliveryStage({ publishedAt: new Date('not-a-date') })).toBe('not_started');
  });

  it('未盖章的列是 null（Drizzle 行的真实形状）', () => {
    expect(deriveDeliveryStage({ generationStartedAt: null, contentReadyAt: null, publishedAt: null })).toBe('not_started');
  });
});

describe('首剧本交付时长（含场地建设）', () => {
  it('取场地部署完成与内容定稿的较晚者，减采风开始', () => {
    const days = firstScriptDeliveryDays(
      { surveyStartedAt: D('2026-09-10T00:00:00Z'), deployedAt: D('2026-09-11T00:00:00Z') },
      { contentReadyAt: D('2026-09-13T00:00:00Z') },
    );
    expect(days).toBe(3);
  });

  it('内容比部署晚时以内容为准', () => {
    const days = firstScriptDeliveryDays(
      { surveyStartedAt: D('2026-09-10T00:00:00Z'), deployedAt: D('2026-09-11T00:00:00Z') },
      { contentReadyAt: D('2026-09-12T00:00:00Z') },
    );
    expect(days).toBe(2);
  });

  it('部署比内容晚时以部署为准', () => {
    const days = firstScriptDeliveryDays(
      { surveyStartedAt: D('2026-09-10T00:00:00Z'), deployedAt: D('2026-09-13T00:00:00Z') },
      { contentReadyAt: D('2026-09-11T00:00:00Z') },
    );
    expect(days).toBe(3);
  });

  it('任一端缺失返回 null（不猜）', () => {
    expect(firstScriptDeliveryDays({}, { contentReadyAt: D('2026-09-13T00:00:00Z') })).toBeNull();
    expect(firstScriptDeliveryDays({ surveyStartedAt: D('2026-09-10T00:00:00Z') }, {})).toBeNull();
  });

  it('不足一天向上取整到 1，不返回 0', () => {
    const days = firstScriptDeliveryDays(
      { surveyStartedAt: D('2026-09-10T00:00:00Z') },
      { contentReadyAt: D('2026-09-10T06:00:00Z') },
    );
    expect(days).toBe(1);
  });

  it('时间戳倒挂或相等时兜到 1 天，不返回 0 或负数', () => {
    // 迟挂的剧本：先定稿、后采风
    expect(firstScriptDeliveryDays(
      { surveyStartedAt: D('2026-09-13T00:00:00Z') },
      { contentReadyAt: D('2026-09-10T00:00:00Z') },
    )).toBe(1);
    expect(firstScriptDeliveryDays(
      { surveyStartedAt: D('2026-09-10T00:00:00Z') },
      { contentReadyAt: D('2026-09-10T00:00:00Z') },
    )).toBe(1);
  });

  it('无效时间戳等同缺失，返回 null 而不是 NaN', () => {
    expect(firstScriptDeliveryDays(
      { surveyStartedAt: new Date('not-a-date') },
      { contentReadyAt: D('2026-09-13T00:00:00Z') },
    )).toBeNull();
  });

  it('未盖章的列是 null（Drizzle 行的真实形状），与缺失等价', () => {
    expect(firstScriptDeliveryDays(
      { surveyStartedAt: D('2026-09-10T00:00:00Z'), deployedAt: null },
      { generationStartedAt: null, contentReadyAt: D('2026-09-13T00:00:00Z'), publishedAt: null },
    )).toBe(3);
  });
});

describe('后续剧本交付时长（纯内容）', () => {
  it('定稿减起稿，按天向上取整', () => {
    expect(scriptDeliveryDays({
      generationStartedAt: D('2026-09-12T00:00:00Z'), contentReadyAt: D('2026-09-12T08:00:00Z'),
    })).toBe(1);
  });

  it('跨天正确', () => {
    expect(scriptDeliveryDays({
      generationStartedAt: D('2026-09-12T00:00:00Z'), contentReadyAt: D('2026-09-14T00:00:00Z'),
    })).toBe(2);
  });

  it('任一端缺失返回 null', () => {
    expect(scriptDeliveryDays({})).toBeNull();
    expect(scriptDeliveryDays({ generationStartedAt: D('2026-09-12T00:00:00Z') })).toBeNull();
  });

  it('时间戳倒挂或相等时兜到 1 天', () => {
    expect(scriptDeliveryDays({
      generationStartedAt: D('2026-09-12T00:00:00Z'), contentReadyAt: D('2026-09-12T00:00:00Z'),
    })).toBe(1);
  });

  it('无效时间戳等同缺失，返回 null 而不是 NaN', () => {
    expect(scriptDeliveryDays({
      generationStartedAt: D('2026-09-12T00:00:00Z'), contentReadyAt: new Date('not-a-date'),
    })).toBeNull();
  });
});
