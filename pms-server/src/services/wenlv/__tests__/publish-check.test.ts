// publish-check 纯函数测试：checkAtomDeployability 三态 + 无 atoms 节点。
// 纯内存，不打库、不 mock db。buildPublishChecklist 的 DB 组装不测（buildPublishTodos 已被既有测试覆盖）。
import { describe, it, expect } from 'vitest';
import { checkAtomDeployability } from '../publish-check.js';

const NODES = [
  {
    id: 'N1',
    title: '茶肆接头',
    atoms: [
      { id: 'A1', type: 'cipher-contact', title: '暗号接头' },
      { id: 'A2', type: 'live-decode', title: '实景解密' },
    ],
  },
  { id: 'N2', title: '收尾', atoms: [{ id: 'A3', type: 'cipher-contact' }] },
] as const;

describe('checkAtomDeployability', () => {
  it('原子 type 均在白名单内 ⇒ 无待办', () => {
    const todos = checkAtomDeployability(NODES, ['cipher-contact', 'live-decode']);
    expect(todos).toEqual([]);
  });

  it('原子 type 不在白名单内 ⇒ 一条 ATOM_NOT_DEPLOYABLE 且 nodeId 正确', () => {
    const todos = checkAtomDeployability(NODES, ['cipher-contact']);
    expect(todos).toHaveLength(1);
    expect(todos[0]).toMatchObject({ code: 'ATOM_NOT_DEPLOYABLE', nodeId: 'N1' });
    expect(todos[0]!.message).toContain('live-decode');
    expect(todos[0]!.message).toContain('实景解密');
  });

  it('白名单为空数组 ⇒ 无待办（档案未登记白名单，不误报）', () => {
    expect(checkAtomDeployability(NODES, [])).toEqual([]);
  });

  it('deployableAtoms 为 null/undefined ⇒ 无待办（场地无档案）', () => {
    expect(checkAtomDeployability(NODES, null)).toEqual([]);
    expect(checkAtomDeployability(NODES, undefined)).toEqual([]);
  });

  it('节点 atoms 为 null ⇒ 不产生待办', () => {
    const nodes = [{ id: 'N3', title: '纯剧情节点', atoms: null }];
    expect(checkAtomDeployability(nodes, ['cipher-contact'])).toEqual([]);
  });
});
