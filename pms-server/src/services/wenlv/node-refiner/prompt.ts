// 生成前约束层（spec §6.2 第一层）：把白名单 ID 作为枚举写进 prompt。
import type { RefineAnchor } from './anchor-builder.js';
import type { RefineTargetType } from './schema.js';

export interface BuildMessagesArgs {
  anchor: RefineAnchor;
  targetType: 'keep' | 'scene' | 'npc';
  linkNpcId?: string | null;
  /** 上一轮校验 / 评审的错误意见，触发带错重生成。 */
  feedback?: string | null;
}

export function buildMessages({ anchor, targetType, linkNpcId, feedback }: BuildMessagesArgs) {
  const { product, node, venuePointName, whitelist, neighbors } = anchor;
  const effectiveType: RefineTargetType =
    targetType === 'keep' ? ((node.nodeType as string) === 'npc' ? 'npc' : 'scene') : targetType;

  const system = [
    '你是资深实景探秘剧本杀的节点编剧，负责完善【单个剧情节点】的全部内容。',
    '输出且仅输出一个 JSON 对象（不要 markdown 代码块、不要解释文字），字段：',
    'targetType("scene"|"npc")、title、storyText、puzzle、grants(string[])、requires(object|null)、',
    'chapterGoal(object|null)、openingLine(string|null)、arDialogue(string|null)、',
    'npcId(string|null)、newNpc({name, persona:{personality[],tone,catchphrases[],backstory,clues[],taboos[]}}|null)、notes、',
    'props(实体道具包建议数组|null)：[{name(道具名), kind("letter"|"key"|"card"|"prop"), placeNote(放置位置，可空)}]。',
    '硬约束：',
    '1. grants 的每个 id 只能从下方「可发放线索白名单」中原样选取，不得编造；',
    '2. npcId 只能从下方「NPC 库白名单」选取；若用户要求绑定指定 NPC 必须使用它；',
    '3. targetType=scene（普通剧情）：chapterGoal/openingLine 必须为 null；puzzle 可为 null 或一个谜题对象',
    '   （type 仅 single/multiple/judge/input/photo/meditate；judge.answer 只能是字符串 "true"/"false"；single/multiple 选项≥2）；',
    '4. targetType=npc（NPC 剧情）：puzzle 必须为 null，chapterGoal 与 openingLine 必填；',
    '   chapterGoal.type 仅 puzzle/choice/reveal/convince/cross-examine；',
    '   chapterGoal 必填子字段（漏一个即整稿作废）：description（目标一句话描述，必填，',
    '   不要用 desc/goal 等同义词代替字段名）、minTurns（整数≥1）、answerCriteria（判定要点 string[]，可为空数组）；',
    '   若未给 linkNpcId 且没有合适的已有 NPC，输出 newNpc（完整人格卡六字段）且 npcId=null；',
    '5. 不得输出或修改任何结构字段（点位、素材、坐标、边）；',
    '6. 文风、年代、称谓必须与剧本世界观一致，简体中文，storyText 为 2-4 段可直接演出的文本。',
    '7. 若本章剧情涉及实体道具（信件/钥匙/身份卡/印章等），在 props 输出实体道具包清单：',
    '   name=道具名，kind=letter|key|card|prop，placeNote=放置位置（如「前台旧物包内」「客房枕头下」，可空）。',
    '   无实体道具则 props 为 null 或省略；props 不影响 grants（线索证物走 grants，实体道具走 props）。',
  ].join('\n');

  const user = [
    `【剧本】《${product.name}》${product.subtitle ?? ''}`,
    `世界观/风格：${safeJson(product.theme)} ${product.styleBible ? safeJson(product.styleBible) : ''}`,
    `【点位】${venuePointName ?? '无（纯剧情节点）'}`,
    `【可发放线索白名单】${whitelist.collectibles.map((c) => `${c.id}(${c.name})`).join('、') || '（空）'}`,
    `【NPC 库白名单】${whitelist.npcs.map((n) => `${n.id}(${n.name})`).join('、') || '（空）'}`,
    `【角色表】${whitelist.characters.map((c) => `${c.id}(${c.name})`).join('、') || '（空）'}`,
    `【全部节点】${whitelist.nodes.map((n) => `${n.id}(${n.title})`).join('、')}`,
    `【前驱节点】${neighbors.prev.map((n) => `${n.id}(${n.title})`).join('、') || '（无）'}`,
    `【后继节点】${neighbors.next.map((n) => `${n.id}(${n.title})`).join('、') || '（无）'}`,
    `【本节点现状】${safeJson(stripNode(node, effectiveType))}`,
    `【本次目标类型】${effectiveType}${targetType === 'keep' ? '（保持现类型，全量完善内容）' : ''}`,
    linkNpcId ? `【必须绑定的 NPC】${linkNpcId}` : '',
    feedback ? `【上一轮需要修正的问题】\n${feedback}` : '',
  ].filter(Boolean).join('\n');

  return { system, user, effectiveType };
}

function safeJson(v: unknown): string {
  try { return JSON.stringify(v); } catch { return ''; }
}

/** 入 prompt 的节点现状只保留内容字段，避免把结构字段/凭证带进上下文。
 *  另按目标类型过滤对侧专属字段：目标是 scene 时不喂 npc 三件套——0074 落平的历史 npc 行
 *  仍残留 chapterGoal/openingLine/npcId，喂进 prompt 会被 LLM 逐字抄回，触发「普通剧情不应
 *  携带 chapterGoal/openingLine/npcId」校验死循环（keep 模式全灭，生产 2026-10-05 实测）。
 *  目标是 npc 时保留 puzzle：谜题内容可为章节目标的 answerCriteria 提供素材；
 *  若被逐字抄回，确定性校验会带错重试（npc 稿 puzzle 必须为 null），不会死循环。 */
function stripNode(node: Record<string, unknown>, effectiveType: RefineTargetType): Record<string, unknown> {
  const keys = ['id', 'nodeType', 'title', 'storyText', 'puzzle', 'grants', 'requires', 'chapterGoal', 'openingLine', 'arDialogue', 'npcId'];
  const out: Record<string, unknown> = {};
  for (const k of keys) if (k in node) out[k] = node[k];
  if (effectiveType === 'scene') {
    delete out.chapterGoal;
    delete out.openingLine;
    delete out.npcId;
  }
  return out;
}
