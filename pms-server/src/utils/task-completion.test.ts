import { describe, it, expect } from 'vitest';
import { isTaskCompleted, computeTaskStats, buildShotRequirements } from './task-completion.js';
import type { ShotRequirement } from './task-completion.js';

const reqs: ShotRequirement[] = [
  { shotType: 'full_view', count: 2 },
  { shotType: 'bathroom', count: 1 },
];

describe('isTaskCompleted 完成判定', () => {
  it('各类素材数达标 → 完成', () => {
    const assets = [{ shotType: 'full_view' }, { shotType: 'full_view' }, { shotType: 'bathroom' }];
    expect(isTaskCompleted(reqs, assets)).toBe(true);
  });
  it('缺某类 → 未完成', () => {
    const assets = [{ shotType: 'full_view' }, { shotType: 'bathroom' }];
    expect(isTaskCompleted(reqs, assets)).toBe(false);
  });
  it('无要求时只要有一张即完成', () => {
    expect(isTaskCompleted([], [{ shotType: 'x' }])).toBe(true);
    expect(isTaskCompleted([], [])).toBe(false);
  });
});

describe('computeTaskStats 统计', () => {
  it('按员工汇总提交状态', () => {
    const staff = [{ id: 's1', name: '张三' }, { id: 's2', name: '李四' }];
    const subs = [{ staffId: 's1', status: 'completed', assetIds: ['a', 'b'] }];
    const rows = computeTaskStats(staff, subs);
    expect(rows.find(r => r.staffId === 's1')?.status).toBe('completed');
    expect(rows.find(r => r.staffId === 's2')?.status).toBe('pending');
    expect(rows.find(r => r.staffId === 's1')?.assetCount).toBe(2);
  });
});

describe('buildShotRequirements 从模板组装拍摄清单', () => {
  it('每个引用模板生成一条要求，默认数量1', () => {
    const templates = [
      { id: 't1', shotType: 'full_view', name: '全景', exampleImageUrl: 'a.jpg', guideText: '横拍' },
      { id: 't2', shotType: 'bathroom', name: '卫浴', exampleImageUrl: 'b.jpg', guideText: '细节' },
    ];
    const result = buildShotRequirements(['t1', 't2'], templates, { t1: 2 });
    expect(result.length).toBe(2);
    expect(result.find(r => r.shotType === 'full_view')?.count).toBe(2);
    expect(result.find(r => r.shotType === 'bathroom')?.count).toBe(1);
    expect(result[0].exampleImageUrl).toBe('a.jpg');
  });
});

describe('isTaskCompleted 图文双键统计', () => {
  it('同 shotType 图/视频互不计数', () => {
    const reqs = [
      { shotType: 'full_view', mediaType: 'image' as const, count: 2 },
      { shotType: 'full_view', mediaType: 'video' as const, count: 1 },
    ];
    // 仅 2 张图 → 视频项不达标
    const onlyImages = [{ shotType: 'full_view', mediaType: 'image' }, { shotType: 'full_view', mediaType: 'image' }];
    expect(isTaskCompleted(reqs, onlyImages)).toBe(false);
    // 图 2 + 视频 1 → 达标
    const both = [...onlyImages, { shotType: 'full_view', mediaType: 'video' }];
    expect(isTaskCompleted(reqs, both)).toBe(true);
  });
  it('旧快照无 mediaType 视为 image，视频素材不污染', () => {
    const reqs = [{ shotType: 'bedding', count: 1 }]; // 旧数据：无 mediaType
    const assets = [{ shotType: 'bedding', mediaType: 'image' }, { shotType: 'bedding', mediaType: 'video' }];
    expect(isTaskCompleted(reqs, assets)).toBe(true);
    // 仅一条视频 → 不达标（旧 req 只认 image）
    expect(isTaskCompleted(reqs, [{ shotType: 'bedding', mediaType: 'video' }])).toBe(false);
  });
});

describe('buildShotRequirements 透传 SOP 字段', () => {
  it('输出含 mediaType 与运镜/禁拍/时长', () => {
    const templates = [
      { id: 'v1', shotType: 'full_view', mediaType: 'video', name: '房间全景（视频）',
        guideText: '开灯略仰', movementText: '「移」门口慢速走入', avoidText: '禁杂物',
        durationMin: 5, durationMax: 10, exampleVideoUrl: 'x.mp4' },
    ];
    const result = buildShotRequirements(['v1'], templates, { v1: 2 });
    const out = result[0];
    expect(out.shotType).toBe('full_view');
    expect(out.mediaType).toBe('video');
    expect(out.count).toBe(2);
    expect(out.guideText).toBe('开灯略仰');
    expect(out.movementText).toBe('「移」门口慢速走入');
    expect(out.avoidText).toBe('禁杂物');
    expect(out.durationMin).toBe(5);
    expect(out.durationMax).toBe(10);
    expect(out.exampleVideoUrl).toBe('x.mp4');
  });
  it('旧模板无 mediaType 默认 image', () => {
    const templates = [{ id: 't1', shotType: 'full_view', name: '全景', guideText: '横拍' }];
    const result = buildShotRequirements(['t1'], templates);
    expect(result[0].mediaType).toBe('image');
    expect(result[0].count).toBe(1);
  });
});
