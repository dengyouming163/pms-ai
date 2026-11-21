import type { WenlvCondition, WenlvState, WenlvCondRef, WenlvInteraction } from '../db/schema/wenlv.js';

// 求值解锁/触发条件（表达力：ref / role / all / any / nofM）
export function evalCondition(
  cond: WenlvCondition | undefined | null,
  state: WenlvState,
  opts?: { characterId?: string | null; characterSkillIds?: string[] },
): boolean {
  if (!cond) return true;
  // 兼容存量扁平格式：{ type: 'collected'|'visited'|'completed'|'skill', id }（实为 ref.kind）
  const c = cond as WenlvCondition | { type: 'collected' | 'visited' | 'completed' | 'skill'; id?: string };
  switch (c.type) {
    case 'ref':
      return evalRef(c.ref, state, opts);
    case 'role':
      // 角色条件：当前选中角色 id === cond.characterId
      return !!opts?.characterId && opts.characterId === c.characterId;
    case 'all':
      return (c.conditions ?? []).every((x) => evalCondition(x, state, opts));
    case 'any':
      return (c.conditions ?? []).some((x) => evalCondition(x, state, opts));
    case 'nofM':
      return (c.of ?? []).filter((x) => evalCondition(x, state, opts)).length >= c.n;
    // 旧格式兼容：{ type: 'collected'|'visited'|'completed'|'skill', id: string }
    // 部分存量剧本仍存旧扁平格式，type 实为 ref.kind。
    case 'collected':
      return !!state.collected[c.id ?? ''];
    case 'visited':
      return !!state.visited[c.id ?? ''];
    case 'completed':
      return !!state.completed[c.id ?? ''];
    case 'skill':
      return !!(opts?.characterSkillIds && opts.characterSkillIds.includes(c.id ?? ''));
    default:
      return false;
  }
}

function evalRef(
  ref: WenlvCondRef,
  state: WenlvState,
  opts?: { characterSkillIds?: string[] },
): boolean {
  switch (ref.kind) {
    case 'visited': return !!state.visited[ref.id];
    case 'collected': return !!state.collected[ref.id];
    case 'completed': return !!state.completed[ref.id];
    case 'skill':
      // 技能条件：当前角色的 skills 包含 ref.id
      return !!(opts?.characterSkillIds && opts.characterSkillIds.includes(ref.id));
    default: return false;
  }
}

/** 递归检查条件树是否引用了指定技能 id。
 *  用于「技能触发通关」判据：只有 interaction.requires 里出现该技能 ref，
 *  才允许用 usedSkill 跳过答案校验（防任意技能乱刷通关）。 */
export function conditionReferencesSkill(
  cond: WenlvCondition | undefined | null,
  skillId: string,
): boolean {
  if (!cond) return false;
  const c = cond as WenlvCondition | { type: 'collected' | 'visited' | 'completed' | 'skill'; id?: string };
  switch (c.type) {
    case 'ref':
      return c.ref.kind === 'skill' && c.ref.id === skillId;
    case 'role':
      return false;
    case 'all':
    case 'any':
      return (c.conditions ?? []).some((x) => conditionReferencesSkill(x, skillId));
    case 'nofM':
      return (c.of ?? []).some((x) => conditionReferencesSkill(x, skillId));
    // 旧格式兼容：{ type: 'skill', id: string }
    case 'skill':
      return c.id === skillId;
    default:
      return false;
  }
}

// 应用完成产出（发放证物，返回新 state，不改原对象）
// 从 effects.grant 提升为 grants 数组；删除 effects.complete（单一前置依赖模型）
export function applyGrants(grants: string[] | undefined | null, state: WenlvState): WenlvState {
  if (!grants || grants.length === 0) return state;
  const next: WenlvState = {
    visited: { ...state.visited },
    collected: { ...state.collected },
    completed: { ...state.completed },
  };
  for (const id of grants) next.collected[id] = true;
  return next;
}

// 标记节点已到访
export function markVisited(state: WenlvState, nodeId: string): WenlvState {
  return { ...state, visited: { ...state.visited, [nodeId]: true } };
}

/** 合并多份进度为**并集**（逐键 OR）—— 团队场次的「队伍进度」（P2 §4.4「读用并集」）。
 *
 *  合法性依据（不是风格选择）：本引擎的条件语言**单调** —— `evalCondition` 无否定分支、
 *  `applyEffects` / `markVisited` 只置 true，全库无置 false 的路径（`selectEnding` 的文档已证）。
 *  ⇒ 并集只会**多**解锁（队伍一起把大门推开），不会让任何人的已达成状态回退。
 *
 *  🔴 **读专用**：返回值只能喂给判定（unlock_condition / trigger_condition / 档位 condition），
 *  **绝不可**写回 `progress.state`（I3「写只写自己」）—— 写回污染不报任何错，
 *  只能靠「B 那行 state 里没有 X」这种库内断言抓（Task 10 判据）。
 *
 *  ⚠️ 消费点唯一：`routes/mini/wenlv.ts` 的 `sessionUnionState`（**别在别处再写一份 OR**）。 */
export function mergeStates(states: (WenlvState | null | undefined)[]): WenlvState {
  const out: WenlvState = { visited: {}, collected: {}, completed: {} };
  for (const s of states) {
    if (!s) continue;
    for (const k of ['visited', 'collected', 'completed'] as const) {
      for (const id of Object.keys(s[k] ?? {})) if (s[k][id]) out[k][id] = true;
    }
  }
  return out;
}

// 查找满足触发条件的结局 id 列表
export function findTriggeredEndings(
  endings: { id: string; triggerCondition: WenlvCondition }[],
  state: WenlvState,
  opts?: { characterId?: string | null; characterSkillIds?: string[] },
): string[] {
  return endings.filter((e) => evalCondition(e.triggerCondition, state, opts)).map((e) => e.id);
}

/** 结局解析：从**所有满足条件**的结局中取 priority 最大者；平手按 id 字典序（彻底消除行序依赖）。
 *
 *  为什么必须是"取一个"而不是"返回全部"：本引擎的条件语言是**单调**的
 *  （`evalCondition` 无否定 + `applyEffects`/`markVisited` 只置 true、全库无置 false 的路径），
 *  于是任意两个各自可满足的结局条件都**同时可满足** —— 「互斥的多结局」在本表达力下
 *  不可能存在，只能是**阶梯**。证明见
 *  docs/superpowers/specs/2026-09-18-wenlv-ending-resolution-design.md §2.1。
 *
 *  ⚠️ 运行时 `settleEndings` 与走场模拟器 `services/wenlv-simulate.ts` **共用本函数**，
 *     不得各写一份（先例见 `nodeRequiresCredential` 的注释 —— 它维护着消费点清单）。
 *
 *  返回的 `satisfiedIds` **把胜出者排在最前**，故调用方的 `ids[0]` 天然是确定值 —— 客户端
 *  `showEnding(endingIds)` 取 `[0]` 的既有行为无需改动即变确定。 */
export function selectEnding(
  endings: { id: string; priority?: number | null; triggerCondition?: WenlvCondition | null }[],
  state: WenlvState,
  opts?: { characterId?: string | null; characterSkillIds?: string[] },
): { endingId: string | null; satisfiedIds: string[] } {
  const satisfied = endings.filter((e) => evalCondition(e.triggerCondition ?? null, state, opts));
  if (satisfied.length === 0) return { endingId: null, satisfiedIds: [] };
  const best = satisfied.reduce((a, b) => {
    const d = (b.priority ?? 0) - (a.priority ?? 0);
    if (d > 0) return b;
    if (d < 0) return a;
    return a.id <= b.id ? a : b;   // 平手取 id 字典序小者
  });
  // 胜出者排首位；**其余按 id 字典序**，使整个返回值与输入顺序无关（不只是 [0]）——
  // 否则 satisfiedIds 的尾序仍随 DB 行序漂移，正是本设计要消灭的那种不确定性。
  const rest = satisfied.filter((e) => e.id !== best.id).map((e) => e.id).sort();
  return { endingId: best.id, satisfiedIds: [best.id, ...rest] };
}

/** 按题型判定答题：single/input/judge 用 trim 精确相等（judge 复用文本比对）；
 * multiple 集合等值（忽略顺序、逐项 trim，答案集非空才可能对）；photo 不判定恒错。 */
export function isAnswerCorrect(interaction: WenlvInteraction, submitted: unknown): boolean {
  switch (interaction.type) {
    case 'single':
    case 'input':
    case 'judge':
      return typeof submitted === 'string' && submitted.trim() === String(interaction.answer).trim();
    case 'multiple': {
      if (!Array.isArray(submitted)) return false;
      const want = new Set((interaction.answer ?? []).map((s) => s.trim()));
      if (want.size === 0) return false;
      const got = new Set(submitted.filter((v): v is string => typeof v === 'string').map((s) => s.trim()));
      if (want.size !== got.size) return false;
      for (const v of want) if (!got.has(v)) return false;
      return true;
    }
    default:
      return false;
  }
}

/** 按题型抹答案（C 端下发用）：single/input/judge→answer=''；multiple→answer=[]；photo 原样 */
export function maskInteractionAnswers(it: WenlvInteraction): WenlvInteraction {
  switch (it.type) {
    case 'single':
    case 'input':
    case 'judge':
      return { ...it, answer: '' } as WenlvInteraction;
    case 'multiple':
      return { ...it, answer: [] } as WenlvInteraction;
    default:
      return it;
  }
}

/** 需要判定答案的题型。puzzle 节点只能用它；scene 节点也可用，
 *  但语义是「剧情回味」—— 答对只给正反馈，不改变进度状态。 */
export const QUIZ_TYPES = ['single', 'multiple', 'judge', 'input'] as const;

/** 无需服务端判定、只能在现场做的动作。**只允许出现在 scene 节点**：
 *  photo 是拍照水印分享，meditate 是静坐计时。 */
export const ACTION_TYPES = ['photo', 'meditate'] as const;

/** 该交互是否可提交给 /answer 判定。与 QUIZ_TYPES 同源，不得各写一份 ——
 *  路由的「是不是可答题交互」与校验器的「题型白名单」必须永远一致。 */
export function isQuizInteraction(it: { type?: string | null } | null | undefined): boolean {
  return (QUIZ_TYPES as readonly string[]).includes(it?.type ?? '');
}

/** 档位求值：返回 condition 满足的档位 id（order 降序，高优先级在前）。空条件=恒满足（同 evalCondition(null)） */
export function findSatisfiedTiers(
  tiers: { id: string; order: number; condition?: WenlvCondition | null }[],
  state: WenlvState,
  opts?: { characterId?: string | null; characterSkillIds?: string[] },
): string[] {
  return tiers
    .filter((t) => evalCondition(t.condition ?? null, state, opts))
    .sort((a, b) => (b.order ?? 0) - (a.order ?? 0))
    .map((t) => t.id);
}

/** 档位进度展示：从 condition 提取「所需印章数」。顶层 nofM 取 n；all/any 仅含单子叶时递归解开；其余/null → null（无法表达为单一 N）。 */
export function deriveNeedStampCount(condition: WenlvCondition | null | undefined): number | null {
  if (!condition) return null;
  if (condition.type === 'nofM') return condition.n;
  if ((condition.type === 'all' || condition.type === 'any') && Array.isArray(condition.conditions) && condition.conditions.length === 1) {
    return deriveNeedStampCount(condition.conditions[0]);
  }
  return null;
}

/** 档位动态状态（claim-state 端点专用，纯函数便于单测）：按 state 求每档 met/claimed/need。
 * collectedStampCount 为已集可收集物总数（rally 下即印章数）。state=null 按空进度处理。 */
export function buildClaimState(
  tiers: { id: string; order: number; condition?: WenlvCondition | null }[],
  claimedTierIds: ReadonlySet<string>,
  state: WenlvState | null,
  opts?: { characterId?: string | null; characterSkillIds?: string[] },
): { collectedStampCount: number; tiers: { id: string; order: number; met: boolean; claimed: boolean; need: number | null }[] } {
  const s = state ?? { visited: {}, collected: {}, completed: {} };
  const sorted = [...tiers].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  return {
    collectedStampCount: Object.keys(s.collected).length,
    tiers: sorted.map((t) => ({
      id: t.id,
      order: t.order ?? 0,
      met: evalCondition(t.condition ?? null, s, opts),
      claimed: claimedTierIds.has(t.id),
      need: deriveNeedStampCount(t.condition),
    })),
  };
}

/** 「这个节点是否需要到现场凭证才能推进」—— **唯一真相**。
 *  五个消费点共用，不得各写一份（新增消费点请顺手更新本清单）：
 *    1. `routes/mini/wenlv.ts` `/trigger` 的凭证门（:359）
 *    2. `routes/mini/wenlv.ts` `/answer` 的到场门（:433）
 *    3. `routes/mini/wenlv.ts` `GET /:id` DTO 下发的 requiresCredential（:173）
 *    4. `services/wenlv-simulate.ts` 走场模拟器的凭证门（:103）
 *    5. `routes/admin/wenlv.ts` `GET /products/:id/full` 的 requiresCredential 派生字段（:827）
 *  注意 venuePointId 优先：挂了点位的节点，即使 triggerType 仍是 schema 默认的
 *  'manual'，也**必须**凭证（这正是客户端曾用 triggerType 近似而踩的坑）。 */
export function nodeRequiresCredential(node: {
  venuePointId?: string | null;
}): boolean {
  return !!node.venuePointId;
}

/** 节点展示用地点：绑了点位就以点位名为准，否则回退存量文本列。
 *
 *  两个消费点共用，**不得各写一份**（新增消费点请顺手更新本清单）：
 *    1. `routes/mini/wenlv.ts` `GET /:id` 公开 DTO 的 `location`（游客实际看到的地名）
 *    2. `routes/admin/wenlv.ts` `GET /products/:id/full` 的 **`displayLocation`**（创作台预览）
 *       ⚠️ 该端点另有同名的 `location`，那是**原始文本列**（可回写、refine-panel 用），
 *          不是本函数的产物 —— 别再把它当成投影。
 *
 *  ⚠️ 2026-09-19 生产实证：同一个节点（`NODE_LONGMEN_DOCK_ARRIVAL`，文本列
 *  `龙门渡口·老码头`、绑点位 `雨夜渡口`）在真机 H5 显示「雨夜渡口」，创作台预览却显示
 *  「龙门渡口·老码头」—— 成因就是两端各写了一份谓词、admin 侧漏了投影。共用本函数即
 *  「预览印的地名 = 游客能看到的地名」。
 *
 *  ⚠️ 只投影**点位名**：`venue_points.name`。点位 `code` 是唯一到场秘密，任何调用方都
 *  不得把 code 放进展示字段（见 mini 路由同一处的注释）。
 *
 *  注意本函数返回的是**展示投影**，不是原始列：调用方若做「编辑载入」，
 *  可编辑的原始 `location` 必须另取 `node.location`，否则会把点位名回写进文本列。
 */
export function nodeDisplayLocation(
  node: { venuePointId?: string | null; location?: string | null },
  pointNameById: Map<string, string>,
): string | null {
  return (node.venuePointId ? pointNameById.get(node.venuePointId) : null) ?? node.location ?? null;
}
