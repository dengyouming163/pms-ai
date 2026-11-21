// 发布闸预检（publish-check）：与发布闸同参同校验（复用 buildPublishTodos，不重写规则），
// 追加「原子-场地能力匹配」（ATOM_NOT_DEPLOYABLE）。只读、不阻断、不落库 ——
// 供 P2 驾驶舱④ / 编辑器横幅消费。预检提示项不进发布闸本体。
import { buildPublishTodos } from './publish-todos.js';

export interface PublishCheckTodo {
  code: string;
  message: string;
  nodeId?: string;
}

/**
 * 原子-场地能力匹配：节点 atoms 里用到的原子 type 不在场地档案 deployableAtoms 白名单内 ⇒ 待办。
 * 语义钉死：deployableAtoms 为 null/undefined/空数组时返回 [] —— 场地无档案或档案未登记白名单
 * 不产生待办（档案未建由驾驶舱②兜着，避免全剧本误报）。
 */
export function checkAtomDeployability(
  nodes: readonly { id: string; title: string | null; atoms?: readonly { id: string; type: string; title?: string }[] | null }[],
  deployableAtoms: readonly string[] | null | undefined,
): PublishCheckTodo[] {
  if (!deployableAtoms || deployableAtoms.length === 0) return [];
  const allow = new Set(deployableAtoms);
  const todos: PublishCheckTodo[] = [];
  for (const n of nodes) {
    for (const a of n.atoms ?? []) {
      if (!allow.has(a.type)) {
        todos.push({
          code: 'ATOM_NOT_DEPLOYABLE',
          nodeId: n.id,
          message: `节点「${n.title ?? n.id}」的原子「${a.title ?? a.id}」（${a.type}）不在场地可部署白名单内，请到「场地档案」补登或移除该原子`,
        });
      }
    }
  }
  return todos;
}

/** 组装发布闸预检清单：发布闸校验投影（code/message/nodeId）+ 原子-场地能力匹配。 */
export async function buildPublishChecklist(
  input: Parameters<typeof buildPublishTodos>[0],
  deployableAtoms: readonly string[] | null | undefined,
): Promise<PublishCheckTodo[]> {
  const todos = await buildPublishTodos(input);
  const checklist: PublishCheckTodo[] = todos.map((t) => ({
    code: t.code,
    message: t.message,
    nodeId: t.target?.kind === 'node' ? t.target.id : undefined,
  }));
  return [...checklist, ...checkAtomDeployability(input.nodes, deployableAtoms)];
}
