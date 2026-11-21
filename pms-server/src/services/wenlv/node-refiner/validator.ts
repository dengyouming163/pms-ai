// 确定性程序校验（spec §6.2 第二层）：不依赖 LLM 自检。
// 返回中文错误清单，空数组 = 通过；错误意见会被拼回 prompt 触发重生成。
import type { RefineDraft } from './schema.js';
import type { RefineAnchor } from './anchor-builder.js';

export function validateRefineDraft(draft: RefineDraft, anchor: RefineAnchor): string[] {
  const errors: string[] = [];
  const grantIds = new Set(anchor.whitelist.collectibles.map((c) => c.id));
  const npcIds = new Set(anchor.whitelist.npcs.map((n) => n.id));
  const nodeIds = new Set(anchor.whitelist.nodes.map((n) => n.id));

  for (const g of draft.grants) if (!grantIds.has(g)) errors.push(`grants 引用了线索库中不存在的 id：${g}`);

  if (draft.targetType === 'npc') {
    if (!draft.npcId && !draft.newNpc) errors.push('NPC 剧情必须绑定已有 NPC 或给出 newNpc 新建建议');
    if (draft.npcId && !npcIds.has(draft.npcId)) errors.push(`npcId 引用了剧本 NPC 库中不存在的 NPC：${draft.npcId}`);
    if (!draft.chapterGoal) errors.push('NPC 剧情必须配置章节目标 chapterGoal');
    if (!draft.openingLine?.trim()) errors.push('NPC 剧情必须配置开场白 openingLine');
    if (draft.puzzle) errors.push('NPC 剧情不应携带 puzzle（对话即玩法）');
    const opts = draft.chapterGoal?.options;
    if (opts) for (const o of opts) {
      if (o.nextNodeId && !nodeIds.has(o.nextNodeId)) errors.push(`章节选项「${o.label}」的下一节点不存在：${o.nextNodeId}`);
    }
  } else {
    if (draft.chapterGoal || draft.openingLine || draft.npcId) errors.push('普通剧情不应携带 chapterGoal/openingLine/npcId（如需 NPC 对话请把 targetType 设为 npc）');
  }

  return errors;
}
