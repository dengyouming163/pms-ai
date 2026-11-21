// node_refine 编排（spec §6.5）：装配锚点 → 生成 → 确定性校验（最多 2 轮带错重试）
// → AI 评审（不通过重生 1 次）→ 返回草稿。全程不写业务表。
import { buildRefineAnchor, type RefineAnchor } from './anchor-builder.js';
import { buildMessages } from './prompt.js';
import { chatJsonObject } from './llm-client.js';
import { validateRefineDraft } from './validator.js';
import { reviewDraft } from './reviewer.js';
import { refineDraftSchema, type RefineDraft, type RefineTargetType } from './schema.js';

const VALIDATE_ATTEMPTS = 2;

export interface RefineResult { draft: RefineDraft; anchor: RefineAnchor }

/**
 * LLM 输出容错归一（spec §6.4 契约保持严格，这里只修两处高频失误）：
 * 1. chapterGoal.description 常被写成 desc/goal/summary/target，安全映射回 description；
 * 2. chapterGoal.type 漂移出五值枚举（生产 2026-10-05 实测：修复部署后 2 连败），
 *    先按同义词表映射，仍不识别则落 'reveal'（对话目标最通用形态）。
 * 已有合法值的稿子原样通过，不做任何改写。
 */
const CHAPTER_GOAL_TYPE_ALIASES: Record<string, string> = {
  persuade: 'convince', interview: 'convince', convince: 'convince',
  ask: 'cross-examine', questioning: 'cross-examine', interrogate: 'cross-examine',
  dialogue: 'reveal', talk: 'reveal', observe: 'reveal', deduce: 'reveal', investigate: 'reveal',
  riddle: 'puzzle', solve: 'puzzle',
  options: 'choice', decide: 'choice',
};
const CHAPTER_GOAL_TYPES = new Set(['puzzle', 'choice', 'reveal', 'convince', 'cross-examine']);

function normalizeRawDraft(raw: unknown): unknown {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return raw;
  const obj = raw as Record<string, unknown>;
  const cg = obj.chapterGoal;
  if (!cg || typeof cg !== 'object' || Array.isArray(cg)) return raw;
  let g = { ...(cg as Record<string, unknown>) };
  // ① description 同义词归一
  if (!(typeof g.description === 'string' && g.description.trim())) {
    const alias = g.description ?? g.desc ?? g.goal ?? g.summary ?? g.target;
    if (typeof alias === 'string' && alias.trim()) g = { ...g, description: alias };
  }
  // ② type 枚举归一：先取别名键（goalType/kind），再同义词映射，未识别兜底 reveal。
  //    覆盖 type 缺失/非串/别名键三种形态——zod 对 enum 缺值与非法值报的是同一文案，
  //    生产实测（2026-10-05 第三轮）漂移形态是「连 type 键都没有」。
  const rawType = g.type ?? g.goalType ?? g.kind;
  if (!(typeof rawType === 'string' && CHAPTER_GOAL_TYPES.has(rawType))) {
    const mapped = typeof rawType === 'string' ? CHAPTER_GOAL_TYPE_ALIASES[rawType.toLowerCase()] : undefined;
    g = { ...g, type: mapped ?? 'reveal' };
  }
  return { ...obj, chapterGoal: g };
}

/**
 * npcId 白名单兜底（spec §6.2 第二层的补丁）：AI 偶发编造白名单外的 NPC id
 * （生产 2026-10-05 实测 ~8%，两轮带错重试也常不收敛，整稿作废）。
 * 当草稿 npcId 不在白名单、但**节点当前绑定**的 npcId 在白名单内时，回退到当前绑定
 * —— 节点本来就是想继续和这个 NPC 对话，比「整稿失败」更贴近用户意图。
 * 节点无当前绑定（或当前绑定也不在白名单）时不做改写，交给校验器带错重试。
 */
function fallbackNpcIdToCurrent(draft: RefineDraft, anchor: RefineAnchor, linkNpcId?: string | null): RefineDraft {
  if (draft.targetType !== 'npc' || !draft.npcId) return draft;
  const whitelisted = new Set(anchor.whitelist.npcs.map((n) => n.id));
  if (whitelisted.has(draft.npcId)) return draft;
  // 用户显式指定了绑定目标（linkNpcId）时优先回退到它，其次才是节点当前绑定
  if (linkNpcId && whitelisted.has(linkNpcId)) return { ...draft, npcId: linkNpcId };
  const current = typeof anchor.node.npcId === 'string' ? anchor.node.npcId : null;
  if (!current || !whitelisted.has(current)) return draft;
  return { ...draft, npcId: current };
}

export async function refineNode(
  productId: string,
  nodeId: string,
  targetType: 'keep' | 'scene' | 'npc',
  linkNpcId?: string | null,
): Promise<RefineResult> {
  const anchor = await buildRefineAnchor(productId, nodeId);

  let feedback: string | null = null;
  let draft: RefineDraft | null = null;

  for (let attempt = 1; attempt <= VALIDATE_ATTEMPTS; attempt++) {
    const { system, user, effectiveType } = buildMessages({ anchor, targetType, linkNpcId, feedback });
    const raw = await chatJsonObject({ system, user });
    // 强制 targetType 以用户意图为准（防止 LLM 漂移），其余字段走 schema
    const parsed = refineDraftSchema.safeParse({ ...(normalizeRawDraft(raw) as object), targetType: effectiveType });
    if (!parsed.success) {
      feedback = `输出结构不合法：${parsed.error.issues.map((i) => `${i.path.join('.')} ${i.message}`).join('；')}`;
      continue;
    }
    const errors = validateRefineDraft(fallbackNpcIdToCurrent(parsed.data, anchor, linkNpcId), anchor);
    if (errors.length === 0) { draft = fallbackNpcIdToCurrent(parsed.data, anchor, linkNpcId); break; }
    feedback = errors.join('\n');
  }
  if (!draft) throw new Error(`AI 草稿两轮未通过校验：${feedback}`);

  // 语义评审：不通过则带意见重生一次，新稿仍须过结构 + 确定性校验
  const review = await reviewDraft(anchor, draft);
  if (!review.ok) {
    const { system, user, effectiveType } = buildMessages({ anchor, targetType, linkNpcId, feedback: review.comment });
    const raw2 = await chatJsonObject({ system, user });
    const parsed2 = refineDraftSchema.safeParse({ ...(normalizeRawDraft(raw2) as object), targetType: effectiveType });
    const errs2 = parsed2.success ? validateRefineDraft(fallbackNpcIdToCurrent(parsed2.data, anchor, linkNpcId), anchor) : ['结构不合法'];
    if (parsed2.success && errs2.length === 0) draft = fallbackNpcIdToCurrent(parsed2.data, anchor, linkNpcId);
    // 重生稿仍不合格则保留原合格稿（确定性校验优先于语义偏好）
  }

  return { draft, anchor };
}

export type { RefineDraft, RefineTargetType };
