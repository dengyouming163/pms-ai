// node_refine 采纳：把「勾选的内容字段」组装为节点 patch；结构字段一律拦截。
// targetType 必应用。新建 NPC 由路由事务先 insert 再把新 id 传入 newNpcIdOverride。
// 发生类型转换（currentNodeType 与 draft.targetType 不同）时，类型耦合字段强制随
// nodeType 一起改写——否则库里会残留「scene 节点挂着 chapterGoal/npcId」这类脏数据，
// 即使用户在勾选框里漏选也必须一致（spec §6.5 类型与内容一致性）。
import type { RefineDraft } from './schema.js';

// 唯一允许采纳的内容字段白名单（spec §6.5）——结构字段不在其中即无法越权写入。
export const REFINE_CONTENT_FIELDS = [
  'title', 'storyText', 'puzzle', 'grants', 'requires',
  'chapterGoal', 'openingLine', 'arDialogue', 'npcId',
] as const;

export function buildRefinePatch(
  draft: RefineDraft,
  selectedFields: string[],
  newNpcIdOverride?: string | null,
  currentNodeType?: string | null,
): Record<string, unknown> {
  const allowed = new Set<string>(REFINE_CONTENT_FIELDS);
  const patch: Record<string, unknown> = { nodeType: draft.targetType };
  for (const f of selectedFields) {
    if (!allowed.has(f)) continue;
    if (f === 'npcId' && newNpcIdOverride) { patch.npcId = newNpcIdOverride; continue; }
    (patch as any)[f] = (draft as any)[f];
  }
  // 新建 NPC 时即便用户没勾 npcId 也必须把绑定写进去（否则 NPC 节点缺 npcId）
  if (newNpcIdOverride && patch.npcId === undefined) patch.npcId = newNpcIdOverride;

  // 类型转换：类型耦合字段无视勾选状态强制一致（同类型编辑维持纯字段级勾选语义）。
  if (currentNodeType && currentNodeType !== draft.targetType) {
    if (draft.targetType === 'npc') {
      // → NPC 对话：必须有 NPC 绑定（优先新建 id）、章节目标、开场白；puzzle 必须清空。
      patch.npcId = newNpcIdOverride ?? draft.npcId;
      patch.chapterGoal = draft.chapterGoal;
      patch.openingLine = draft.openingLine;
      patch.puzzle = null;
    } else {
      // → 普通剧情：NPC 专属三件套 chapterGoal/openingLine/npcId 必须全部清空。
      patch.chapterGoal = null;
      patch.openingLine = null;
      patch.npcId = null;
    }
  }
  return patch;
}
