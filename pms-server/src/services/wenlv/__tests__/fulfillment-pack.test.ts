// fulfillment-pack 纯函数测试：expandAtoms 的坐标动线排序（nulls last）+ atoms 展开。
// 纯内存，不打库、不 mock db。buildFulfillmentPack 的 DB 组装不测（同 project-board 惯例，
// 由路由层契约覆盖）——空产品的履约包形状 { atoms: [], props: [], merchants: [], supportActions: {} }
// 中 atoms 分片由本文件的「空输入」用例兜住，其余三分片是 select/空数组/{} 的直接透传。
import { describe, it, expect } from 'vitest';
import { expandAtoms } from '../fulfillment-pack.js';

const d = (s: string) => new Date(s);
const atom = (id: string) => ({ id, type: 'observe' });

describe('expandAtoms', () => {
  it('坐标动线排序：mapY 升 → mapX 升 → createdAt 升，null 坐标排最后', () => {
    const nodes = [
      // null 坐标：createdAt 最早也必须排最后（不抢动线前排）
      { id: 'N-null', title: '未上图', atoms: [atom('A0')], mapX: null, mapY: null, createdAt: d('2026-01-01') },
      // 同坐标并列：createdAt 早的在前
      { id: 'N-late', title: '晚', atoms: [atom('A1')], mapX: 100, mapY: 100, createdAt: d('2026-01-03') },
      { id: 'N-early', title: '早', atoms: [atom('A2')], mapX: 100, mapY: 100, createdAt: d('2026-01-02') },
      // mapY 最小 ⇒ 最前（mapX 大也无妨，mapY 优先）
      { id: 'N-top', title: '顶', atoms: [atom('A3')], mapX: 900, mapY: 10, createdAt: d('2026-01-04') },
    ];
    expect(expandAtoms(nodes).map((a) => a.nodeId)).toEqual(['N-top', 'N-early', 'N-late', 'N-null']);
  });

  it('排序稳定：坐标与 createdAt 全相同 ⇒ 保持入参顺序', () => {
    const at = d('2026-01-01');
    const nodes = [
      { id: 'N1', title: '一', atoms: [atom('A1')], mapX: 5, mapY: 5, createdAt: at },
      { id: 'N2', title: '二', atoms: [atom('A2')], mapX: 5, mapY: 5, createdAt: at },
      { id: 'N3', title: '三', atoms: [atom('A3')], mapX: 5, mapY: 5, createdAt: at },
    ];
    expect(expandAtoms(nodes).map((a) => a.nodeId)).toEqual(['N1', 'N2', 'N3']);
  });

  it('atoms 为 null/[] 的节点跳过，不产出行', () => {
    const nodes = [
      { id: 'N1', title: '纯剧情', atoms: null, mapX: 1, mapY: 1, createdAt: d('2026-01-01') },
      { id: 'N2', title: '空数组', atoms: [], mapX: 2, mapY: 1, createdAt: d('2026-01-02') },
      { id: 'N3', title: '有原子', atoms: [{ id: 'A1', type: 'cipher-contact' }], mapX: 3, mapY: 1, createdAt: d('2026-01-03') },
    ];
    const out = expandAtoms(nodes);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ nodeId: 'N3', nodeTitle: '有原子', atomId: 'A1', type: 'cipher-contact' });
  });

  it('单节点多原子：按 atoms 数组顺序展开为连续行，title 缺省透传 undefined', () => {
    const nodes = [
      {
        id: 'N1', title: '茶肆接头', mapX: 1, mapY: 1, createdAt: d('2026-01-01'),
        atoms: [
          { id: 'A1', type: 'cipher-contact', title: '暗号接头' },
          { id: 'A2', type: 'live-decode' },
        ],
      },
    ];
    const out = expandAtoms(nodes);
    expect(out.map((a) => a.atomId)).toEqual(['A1', 'A2']);
    expect(out[0]).toEqual({ nodeId: 'N1', nodeTitle: '茶肆接头', atomId: 'A1', type: 'cipher-contact', title: '暗号接头' });
    expect(out[1]).toEqual({ nodeId: 'N1', nodeTitle: '茶肆接头', atomId: 'A2', type: 'live-decode', title: undefined });
  });

  it('空输入 ⇒ 空 atoms（空产品履约包的 atoms 分片形状）', () => {
    expect(expandAtoms([])).toEqual([]);
  });
});
