// 剧情节点二元模型的唯一事实源（spec §4）：
// nodeType 只存 'scene'（普通剧情）/ 'npc'（NPC 剧情）。
// C 端渲染模式一律由下面两个谓词派生，全代码库不得再出现 driverType。
import type { WenlvBinaryNodeType } from '../../db/schema/wenlv.js';

export type { WenlvBinaryNodeType };
// as const 与联合类型编译期绑定：增删枚举值时这里必改，漏改即 tsc 报错（satisfies 钉住）。
export const NODE_TYPE_VALUES = ['scene', 'npc'] as const satisfies readonly WenlvBinaryNodeType[];

interface NpcDrivenInput {
  nodeType: string | null;
  npcId: string | null;
  chapterGoal?: unknown;
}

/**
 * NPC 对话驱动：类型为 npc、绑定了 NPC、且 chapterGoal 非空。其余全部走传统模式。
 * 注意 chapterGoal 这里只验非空（{} 也算非空），不深查结构；其结构完整性由写入端与发布闸负责。
 * 类型谓词：命中后把 npcId 窄为 string、chapterGoal 窄为非空，调用方无需再各自 if 窄化。
 */
export function isNpcDrivenNode<T extends NpcDrivenInput>(node: T):
node is T & { nodeType: 'npc'; npcId: string; chapterGoal: NonNullable<T['chapterGoal']> } {
  return node.nodeType === 'npc' && !!node.npcId && !!node.chapterGoal;
}

interface PuzzleInput {
  nodeType: string | null;
  puzzle?: unknown | null;
}

/** 普通剧情节点（非 npc）是否挂了 puzzle 互动配置。 */
export function hasNodePuzzle(node: PuzzleInput): boolean {
  return node.nodeType !== 'npc' && !!node.puzzle;
}
