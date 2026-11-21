// 文旅内容完整性校验（publish 前置，纯函数无 DB）
// 输入：某产品及其全部内容行；输出：错误文案数组（空=通过）。
// 按 product.mode 分流：narrative 沿用旧规则（scene/puzzle/引用的线索与节点；结局走 endings 表，不是节点类型）；
// rally 为集章线：禁 ending（保非终局，用档位兑奖）、须有档位/可收集物/点位节点、
// 档位 condition 只可引用 collected 且 reward 存在、puzzle 须可判定（禁 photo、答案非空）。
import type { WenlvCondition } from '../db/schema/wenlv.js';
import { ACTION_TYPES, QUIZ_TYPES } from './wenlv-engine.js';

interface IntegrityNode {
  id: string;
  nodeType?: string;
  title: string;
  /** 引用的物理点位（pms_bui_wenlv_venue_points.id）。为空 = 无需到场。 */
  venuePointId?: string | null;
  /** 该节点触发的 NPC 标识（spec §4.3）。R-N1/R-N2 完整性校验用。 */
  npcId?: string | null;
  /** 该节点引用的 NPC 台词 id 列表（spec §4.3）。R-N2 校验时需在所属 NPC 内查台词是否存在。 */
  npcLineIds?: string[];
  /** 完成时发放的证物 id 列表（从 effects.grant 提升，删除 effects.complete）。 */
  grants?: string[];
  /** 前置解锁条件（从 unlockCondition 重命名）。 */
  requires?: WenlvCondition | null;
  /** 单题谜题（从 interactions 数组改为单对象，null=无谜题）。 */
  puzzle?: unknown;
}
interface IntegrityTier {
  id: string;
  name: string;
  order?: number;
  condition?: WenlvCondition | null;
  rewardId?: string | null;
}
/** 剧情边（二元图模型）。可选入参：老调用点/单测不传时，边相关校验全部跳过。 */
interface IntegrityEdge {
  id: string;
  fromNodeId: string;
  toNodeId: string;
  edgeType?: string;
  condition?: WenlvCondition | null;
  /** 走边时发放的线索 —— 运行时与 node.grants 同为真实发放入口（graph-traversal.traverseEdges）。 */
  grants?: string[] | null;
}
interface IntegrityNpc {
  id: string;
  name?: string;
  /** NPC 绑定的角色 id（spec §4.3）。R-N3 校验用。省略 / null = 该 NPC 不绑定角色。 */
  characterId?: string | null;
  /** 立绘文生图 prompt。发布闸拦：发布时非空（编辑期可空）。 */
  portraitPrompt?: string | null;
  /** 音色 ID。发布闸拦：发布时非空（编辑期可空）。 */
  voiceId?: string | null;
  /** NPC 的台词表。R-N2 校验 node.npc_line_ids 时按 id 在此查；R-N4 要求 id 唯一且至少 1 条。 */
  lines: { id: string; text?: string }[];
}
export interface IntegrityInput {
  product: { id: string; name: string; mode?: string; status?: string; venueId?: string | null };
  nodes: IntegrityNode[];
  /** 剧情边。省略 = 跳过边条件/边发放校验，且 grantableIds 不含 edge.grants（向后兼容）。 */
  edges?: IntegrityEdge[];
  collectibles: { id: string; name: string; type?: string }[];
  endings: { id: string; title: string; triggerCondition?: WenlvCondition | null; rewardId?: string | null; priority?: number | null }[];
  rewards: { id: string; name: string }[];
  tiers?: IntegrityTier[];
  /** 场地全部点位。省略 = 不校验点位引用（向后兼容既有调用点与测试）。 */
  points?: { id: string; code?: string | null; venueId?: string | null }[];
  /** 产品全部 NPC。省略 = 不校验 NPC 引用（R-N1~R-N4 全部跳过，向后兼容既有调用点与测试）。
   *  T13 才在 publish 调用点组装入参并传入；T12 之前既有调用点不传 ⇒ 全跳过。 */
  npcs?: IntegrityNpc[];
  /** 产品全部 character。
   *  省略 = 不校验 npc.character_id（R-N3 跳过），且不校验 hidden_quest 引用（R3 跳过）；
   *  但 R-N1/R-N2/R-N4 仍跑。
   *  hiddenQuest.collectible_ids（spec §9 R3）：每项必须存在，且必须有节点会发放（复用
   *  grantableIds 可达性判据）—— 引用存在但永不被满足的 id 会让隐秘任务永远无法完成。 */
  characters?: {
    id: string;
    name?: string;
    /** 阵营（spec §2）。R1 发布闸拦：发布时非空。 */
    faction?: string;
    /** 社会身份（隐士/捕快等，spec §2）。R1 发布闸拦：发布时非空。 */
    identity?: string;
    /** 体力 0–100（spec §2，纯展示）。R1 发布闸拦：范围 0–100。 */
    vitality?: number;
    /** 智慧 0–100（spec §2，纯展示）。R1 发布闸拦：范围 0–100。 */
    wisdom?: number;
    /** 洞察 0–100（spec §2，纯展示）。R1 发布闸拦：范围 0–100。 */
    insight?: number;
    skills?: { id: string }[];
    hiddenQuest?: { collectible_ids?: string[] } | null;
  }[];
}

/** 引用收集：可从条件树（WenlvCondition）或节点数组（IntegrityNode[]）收集引用。
 *
 *  - 传 WenlvCondition：递归遍历条件树收集 collected/completed/visited 等 ref 叶子（原行为）。
 *  - 传 IntegrityNode[]：遍历节点收集 npc / npc_line 引用（spec §4.3，N2 Phase 用）。
 *    npc_line 引用**带 npcId 上下文** —— R-N2 校验时需在该 NPC 内查台词是否存在，
 *    否则跨 NPC 同名台词会误判。
 *
 *  多态分流依据「数组 vs 单个条件」：WenlvCondition 永不为数组，IntegrityNode[] 永为数组，
 *  故 Array.isArray 是干净的判别。null/undefined 两侧都返回 out（向后兼容既有调用点）。
 *
 *  注意：本函数只负责「收集引用」，不校验引用是否存在 / 是否可达（那是 checkRef 与
 *  validateWenlvIntegrity 的事；R-N1~R-N4 由 T12 接入）。
 */
export function collectRefs(
  input: WenlvCondition | IntegrityNode[] | undefined | null,
  out: ({ kind: string; id: string } & { npcId?: string })[] = [],
): ({ kind: string; id: string } & { npcId?: string })[] {
  if (input == null) return out;
  // 节点数组：收 npc / npc_line 引用
  if (Array.isArray(input)) {
    for (const node of input) {
      if (node.npcId) out.push({ kind: 'npc', id: node.npcId });
      if (node.npcLineIds) {
        for (const lid of node.npcLineIds) {
          out.push({ kind: 'npc_line', id: lid, npcId: node.npcId ?? undefined });
        }
      }
    }
    return out;
  }
  // 条件树：递归收集 ref 叶子（原行为，勿破坏）
  // 兼容存量扁平格式：{ type: 'collected'|'visited'|'completed'|'skill', id }（实为 ref.kind）
  const cond = input as WenlvCondition | { type: 'collected' | 'visited' | 'completed' | 'skill'; id?: string };
  if (cond.type === 'collected' || cond.type === 'visited' || cond.type === 'completed' || cond.type === 'skill') {
    const id = cond.id;
    if (id && cond.type !== 'skill') out.push({ kind: cond.type, id });
    return out;
  }
  if (cond.type === 'ref') {
    // skill 引用由 R4（技能引用合法）单独校验，不参与节点/线索可达性检查
    if (cond.ref.kind !== 'skill') out.push({ kind: cond.ref.kind, id: cond.ref.id });
    return out;
  }
  // role 型按角色 id 门控，无子条件、无 ref 可收集
  if (cond.type === 'role') return out;
  // 到此处 cond 必为 all/any/nofM（旧格式与 ref/role 已提前 return）
  const wc = cond as WenlvCondition;
  let children: WenlvCondition[] | undefined;
  if (wc.type === 'nofM') children = wc.of;
  else if (wc.type === 'all' || wc.type === 'any') children = wc.conditions;
  if (Array.isArray(children)) {
    for (const ch of children) collectRefs(ch, out);
  }
  return out;
}

/** 收集条件树中所有 skill 引用的 id（R4 用）。与 collectRefs 分开：后者跳过 skill（可达性检查不涉及技能）。 */
export function collectSkillRefs(cond: WenlvCondition | undefined | null, out: string[] = []): string[] {
  if (!cond) return out;
  // 兼容存量扁平格式：{ type: 'skill', id }
  const c = cond as WenlvCondition | { type: 'collected' | 'visited' | 'completed' | 'skill'; id?: string };
  if (c.type === 'ref' && c.ref.kind === 'skill') out.push(c.ref.id);
  if (c.type === 'skill') {
    if (c.id) out.push(c.id);
  }
  if (c.type === 'all' || c.type === 'any') {
    if (Array.isArray(c.conditions)) for (const x of c.conditions) collectSkillRefs(x, out);
  }
  if (c.type === 'nofM') {
    if (Array.isArray(c.of)) for (const x of c.of) collectSkillRefs(x, out);
  }
  return out;
}

/** 档位必须在**两种模式下**都有达成条件。
 *
 *  为什么推广到 narrative：`wenlv-engine.ts` 的 `evalCondition` 开头是
 *  `if (!cond) return true;` ⇒ `condition = null` 的档位在 `/redeem` 上**恒为可领取**，
 *  而 `/redeem` 本身**没有 mode 判据**。原先只有 rally 分支挡这一条，
 *  narrative 可以静默发布一个「无条件、人人可领」的档位。
 *
 *  2026-09-20 生产实测：两种模式的档位数合计为 0 ⇒ 本改动**零行为变更**。
 *
 *  注意：这里**只**判「是否为空」。rally 专有的引用语义（只能引用 collected、
 *  必须是印章、必须有人发放）留在 rally 分支内，不要搬进来。
 *
 *  调用点：rally 分支**保持原样**（它内联的这条判据逐字等价，且带有 `continue`
 *  —— 空条件下跳过后面的 rewardId 校验，语义与这里不等价，故不替换）；
 *  本函数只在 narrative 分支调用。详见下方 narrative 分支内的注释。
 */
function checkTierConditionPresent(tiers: IntegrityTier[], push: IssuePush): void {
  for (const t of tiers) {
    if (t.condition == null) {
      push(`档位[${t.name || t.id}] 必须设置达成条件（condition）`, 'TIER_NO_CONDITION', { kind: 'tier', id: t.id, name: t.name });
    }
  }
}

/**
 * 结构化校验问题项（发布待办清单用，spec §publish-todos）。
 * message 与历史字符串输出逐字一致（既有 90+ 用例钉住），code/target 为新增元数据：
 *  - code：稳定枚举，任务中心/待办清单按它路由 AI 修复能力（见 publish-todos.ts FIX_ROUTING）
 *  - target：定位实体（待办清单「去处理」深链 + AI 修复入参）
 * 未标注 code 的旧规则落 'OTHER'（manual 处理），保证清单永不丢项。
 */
export interface IntegrityIssue {
  code: string;
  message: string;
  target?: { kind: 'product' | 'node' | 'npc' | 'character' | 'ending' | 'tier' | 'collectible' | 'reward' | 'point' | 'edge'; id: string; name?: string };
}
type IssueTarget = IntegrityIssue['target'];
type IssuePush = (message: string, code?: string, target?: IssueTarget) => void;

export function validateWenlvIntegrity(input: IntegrityInput): string[] {
  return collectWenlvIssues(input).map((i) => i.message);
}

/** 与 validateWenlvIntegrity 同一份校验逻辑，额外返回结构化问题项。 */
export function collectWenlvIssues(input: IntegrityInput): IntegrityIssue[] {
  const issues: IntegrityIssue[] = [];
  const push: IssuePush = (message, code = 'OTHER', target) => issues.push({ code, message, target });
  const { product, nodes, collectibles, endings, rewards, tiers = [] } = input;
  if (!product.name?.trim()) push('产品名称不能为空', 'PRODUCT_NAME_EMPTY', { kind: 'product', id: product.id, name: product.name });

  const nodeIds = new Set(nodes.map((n) => n.id));
  const nodeTitleById = new Map(nodes.map((n) => [n.id, n.title]));
  const collectibleIds = new Set(collectibles.map((c) => c.id));
  const rewardIds = new Set(rewards.map((r) => r.id));
  // S4 Important-1：集章（rally）下所有 collected 落点必须引用 stamp 型可收集物，防 narrative→rally 后旧 clue 引用放行
  const stampIds = new Set(collectibles.filter((c) => c.type === 'stamp').map((c) => c.id));

  // 可达性：state.collected 由 grants 写入（引擎 applyGrants 是唯一写入点）。
  // state.visited 由 markVisited 写入（节点触发即到访）。
  // state.completed **不再有任何写入点**（effects.complete 已删除）—— 引用 completed 的条件永不可满足。
  //
  // 发放点有两处：node.grants（完成节点）与 **edge.grants（走边时，graph-traversal.traverseEdges
  // 先判条件后合并）**。2026-10 生产实测：边模型迁移后大量线索只挂在 edge.grants 上，旧口径
  // 只聚合 node.grants ⇒ 19 条 COLLECTIBLE_UNREACHABLE 假阳性。两处必须同时聚合。
  const edges = input.edges ?? [];
  const grantableIds = new Set<string>();
  for (const n of nodes) {
    for (const id of n.grants ?? []) grantableIds.add(id);
  }
  for (const e of edges) {
    for (const id of e.grants ?? []) grantableIds.add(id);
  }

  const checkRef = (label: string, cond: WenlvCondition | undefined | null, stampCheck = false, target?: IssueTarget) => {
    for (const ref of collectRefs(cond)) {
      if (ref.kind === 'collected') {
        if (!collectibleIds.has(ref.id)) { push(`${label} 引用不存在的线索 ${ref.id}`, 'COLLECTIBLE_REF_NOT_FOUND', target); continue; }
        if (stampCheck && !stampIds.has(ref.id)) push(`${label} 引用 ${ref.id} 非印章（stamp）可收集物，集章产品只能盖章收集`, 'COLLECTIBLE_TYPE_INVALID', target);
        if (!grantableIds.has(ref.id)) push(`${label} 引用线索 ${ref.id}，但没有任何节点或边发放它 —— 该条件永远无法满足；请让某个节点或边的 grants 包含 ${ref.id}`, 'COLLECTIBLE_UNREACHABLE', target);
      } else if (ref.kind === 'completed') {
        // completed 状态已废弃（无任何写入点）：引用 completed 的条件永不可满足。
        if (!nodeIds.has(ref.id)) {
          push(`${label} 引用不存在的节点 ${ref.id}`, 'NODE_REF_NOT_FOUND', target);
        } else {
          push(`${label} 引用节点 ${ref.id} 的 completed 状态，但该状态已废弃（没有任何节点会写入 completed）—— 该条件永远无法满足；请改用 visited`, 'COMPLETED_DEPRECATED', target);
        }
      } else if (!nodeIds.has(ref.id)) {
        push(`${label} 引用不存在的节点 ${ref.id}`, 'NODE_REF_NOT_FOUND', target);
      }
      // visited 引用：只要节点存在即可（到访即写入，无可达性问题）
    }
  };
  const checkGrants = (label: string, grants?: string[], stampCheck = false, target?: IssueTarget) => {
    for (const id of grants ?? []) {
      if (!collectibleIds.has(id)) { push(`${label} grants 引用不存在的线索 ${id}`, 'COLLECTIBLE_REF_NOT_FOUND', target); continue; }
      if (stampCheck && !stampIds.has(id)) push(`${label} grants 引用 ${id} 非印章（stamp）可收集物，集章产品只能盖章收集`, 'COLLECTIBLE_TYPE_INVALID', target);
    }
  };

  // 交互规则（S4④）。**必须在两个 mode 下对每个节点都跑** ——
  // 这是本片修复的核心：旧实现把整块写在 `mode === 'rally'` 且 `nodeType === 'puzzle'`
  // 之内，于是 scene 节点上的交互从未被任何一道闸看过，
  // 生产因此积压了 37 条 AI 写出、却谁也没渲染过的剧情题（详见 spec §2）。
  //
  // ❗ 本函数与 pms-ai-crew/src/services/wenlv_integrity.py 的对应块**必须逐字同构**。
  //   两份都是发布/生成路径上的闸，只改一份就会让内容在一侧通过、另一侧被拦。
  const checkPuzzle = (label: string, nodeType: string | undefined, puzzle: unknown, target?: IssueTarget) => {
    const it = puzzle;
    const typeOf = (i: unknown) => (i as { type?: string } | null)?.type;
    const isQuiz = (t: string | undefined): t is string => (QUIZ_TYPES as readonly string[]).includes(t ?? '');

    const checkQuizFields = (lbl: string, t: string, i: unknown) => {
      const ans = (i as { answer?: unknown }).answer;
      const empty = t === 'multiple' ? !Array.isArray(ans) || ans.length === 0
                                     : (ans === undefined || ans === null || String(ans).trim() === '');
      if (empty) { push(`${lbl} ${t} 题型答案不能为空`, 'PUZZLE_ANSWER_EMPTY', target); return; }
      if (t === 'judge' && ans !== 'true' && ans !== 'false') {
        push(`${lbl} judge 题型答案只能是 'true' 或 'false'，当前是 ${JSON.stringify(ans)}`, 'PUZZLE_ANSWER_INVALID', target);
      }
    };

    if (nodeType === 'puzzle') {
      if (!it) { push(`谜题[${label}] 必须有交互题目`, 'PUZZLE_REQUIRED', target); return; }
      const t = typeOf(it);
      if (!isQuiz(t)) {
        push(`谜题[${label}] 不接受 ${t} 交互（拍照打卡 / 静坐计时请用 scene 节点）`, 'PUZZLE_TYPE_INVALID', target);
        return;
      }
      checkQuizFields(`谜题[${label}]`, t, it);
      return;
    }

    // scene（以及未来的其它非 puzzle 类型）：承载「剧情回味题」+「现场动作」
    if (!it) return;
    const t = typeOf(it);
    if (isQuiz(t)) {
      checkQuizFields(`节点[${label}]`, t, it);
      return;
    }
    if (t === 'photo' || t === 'meditate') {
      const q = (it as { question?: unknown }).question;
      if (typeof q !== 'string' || q.trim() === '') {
        push(`节点[${label}] ${t === 'photo' ? '拍照打卡' : '静坐计时'}缺少题干（question 不能为空）`, 'PUZZLE_QUESTION_EMPTY', target);
      }
      if (t === 'meditate') {
        const s = (it as { seconds?: unknown }).seconds;
        if (typeof s !== 'number' || !Number.isInteger(s) || s < 1 || s > 1800) {
          push(`节点[${label}] 静坐时长必须是 1~1800 的整数秒`, 'PUZZLE_SECONDS_INVALID', target);
        }
      }
      return;
    }
    push(`节点[${label}] 交互类型 '${t}' 非法（只能是 ${[...QUIZ_TYPES, ...ACTION_TYPES].join('/')}）`, 'PUZZLE_TYPE_INVALID', target);
  };

  // 点位引用（两种 mode 通用）：实景体验的核心是「到场证明」，绝不能放行没有凭证的点位。
  //
  // 本块只是「节点引用点位」这件事的**发布侧一半**：它保证的是「落库的点位有 code」这一数据事实。
  // 运行时的另一半**已同批落地**（926cc5cd + 本次收口补漏），落在 routes/mini/wenlv.ts：
  //   - `/trigger`：有 venuePointId 时以点位 `code` 为唯一凭证，无码/不存在/不匹配一律 403 fail-closed；
  //   - `/answer`：有 venuePointId 时同样要求先被 /trigger 标记 visited（否则远程答题即可刷印章）。
  // 两处都以 venuePointId 优先、**绑定点位时都不看**已废弃的 triggerType（仅未绑点位时回退读它）——
  // triggerType 的 schema 默认是 'manual'，绑定点位的新节点正是这个默认值，只看它会把到场证明整个放行掉。
  // 部署约束仍在：本闸与 routes/mini/wenlv.ts 必须进同一个部署包（本项目为只覆盖改动文件的增量部署，
  // 拆开就会精确复现「发布门放行但运行时无人拦截」）。
  if (input.points) {
    const pointMap = new Map(input.points.map((p) => [p.id, p]));
    for (const n of nodes) {
      if (!n.venuePointId) continue;
      // 先判「产品未归属场地」：此时 publish 传进来的 points 必为空（按场地过滤），
      // 若先查 map 只会得到误导性的「点位不存在」——点位其实好好地待在场地里。
      if (!product.venueId) { push(`节点[${n.title}] 引用了点位，但产品未归属场地`, 'POINT_PRODUCT_NO_VENUE', { kind: 'node', id: n.id, name: n.title }); continue; }
      const p = pointMap.get(n.venuePointId);
      // `points` 是按场地过滤后传进来的，故此处「查不到」有两种可能：该点位被删了，
      // 或者它属于别的场地。后者反而更常见（删点位有 DELETE 409 守卫，改产品场地没有任何守卫），
      // 所以文案必须同时点出两种可能，否则会把操作员引向错误的排查方向。
      if (!p) { push(`节点[${n.title}] 引用的点位 ${n.venuePointId} 不存在（或不属于本产品的场地）`, 'POINT_NOT_FOUND', { kind: 'node', id: n.id, name: n.title }); continue; }
      if (!p.code?.trim()) push(`节点[${n.title}] 引用的点位「${p.id}」未配置触发凭证（二维码/信标），请先在场地里生成`, 'POINT_NO_CODE', { kind: 'point', id: p.id });
      if (p.venueId !== product.venueId) push(`节点[${n.title}] 引用的点位不属于本产品的场地`, 'POINT_WRONG_VENUE', { kind: 'point', id: p.id });
    }
  }

  // NPC 引用完整性（R-N1~R-N4，spec §9）。**在 mode 分流之前** —— narrative / rally
  // 两种 mode 都可能有 NPC 出场，NPC 引用与 mode 无关。
  //
  // 跳过条件：input.npcs 未提供 ⇒ R-N1~R-N4 全部跳过（向后兼容既有调用点；T13 才在
  // publish 调用点组装 npcs/characters 入参）。这是关键 —— 既有 90 条用例都没传 npcs，
  // 不跳过就会全部变红。
  // 节点无 npc_id ⇒ R-N1/R-N2 跳过该节点（老剧本零迁移）。
  // npc 无 character_id ⇒ R-N3 跳过该 npc（spec：若存在）。
  // input.characters 未提供 ⇒ R-N3 跳过（但 R-N1/R-N2/R-N4 仍跑）。
  //
  // 实现思路 B（直接遍历）：R-N1/R-N2 是节点级校验，遍历 nodes 比走 collectRefs 更直观；
  // collectRefs 的多态（T11 已建）主要价值在条件树递归，npc 引用是平铺的，不必绕一道。
  if (input.npcs) {
    const npcMap = new Map(input.npcs.map((n) => [n.id, n]));
    const charIds = input.characters ? new Set(input.characters.map((c) => c.id)) : null;
    // NPC 标签：同时含 name 与 id，name 缺省时退化为裸 id（与「节点[title]」同款的人读优先）。
    // 两者都给是因为 NPC 名字在产品内可能重复，id 才是数据库里的稳定锚点 —— 操作员排查需要 id。
    const npcLabel = (npc: IntegrityNpc) => npc.name ? `${npc.name}(${npc.id})` : npc.id;
    // R-N1 / R-N2：节点级
    for (const n of nodes) {
      if (!n.npcId) continue; // 老剧本节点无 npcId ⇒ 跳过 R-N1/R-N2
      const npc = npcMap.get(n.npcId);
      // R-N1：node.npcId（若存在）必须在 product.npcs 内
      if (!npc) {
        push(`节点[${n.title}] 引用的 NPC ${n.npcId} 不存在（R-N1）`, 'NODE_NPC_NOT_FOUND', { kind: 'node', id: n.id, name: n.title });
        continue; // NPC 不存在 ⇒ R-N2 无 NPC 可对照，跳过该节点的 R-N2
      }
      // R-N2：node.npcLineIds 每项必须存在于该 NPC.lines.id
      if (n.npcLineIds) {
        const lineIds = new Set(npc.lines.map((l) => l.id));
        for (const lid of n.npcLineIds) {
          if (!lineIds.has(lid)) {
            push(`节点[${n.title}] 引用的台词 ${lid} 不在 NPC[${npcLabel(npc)}] 的 lines 内（R-N2）`, 'NODE_NPC_LINE_NOT_FOUND', { kind: 'node', id: n.id, name: n.title });
          }
        }
      }
    }
    // R-N3 / R-N4：NPC 级
    for (const npc of input.npcs) {
      const npcTarget: IssueTarget = { kind: 'npc', id: npc.id, name: npc.name };
      // R-N4：lines 至少 1 条（强制约束，与 character 不可为空同款）；id 在该 NPC 内唯一
      if (!npc.lines || npc.lines.length === 0) {
        push(`NPC[${npcLabel(npc)}] 至少需要 1 条台词（R-N4）`, 'NPC_NO_LINES', npcTarget);
      } else {
        const seen = new Set<string>();
        for (const l of npc.lines) {
          if (seen.has(l.id)) {
            push(`NPC[${npcLabel(npc)}] 的台词 ${l.id} 重复（R-N4）`, 'NPC_LINE_DUP', npcTarget);
          } else {
            seen.add(l.id);
          }
        }
      }
      // R-N3：npc.character_id（若存在）必须在 product.characters 内。
      // characters 未提供 ⇒ 跳过；characterId 缺省 ⇒ 跳过该 npc。
      if (charIds && npc.characterId && !charIds.has(npc.characterId)) {
        push(`NPC[${npcLabel(npc)}] 引用的角色 ${npc.characterId} 不存在（R-N3）`, 'NPC_CHARACTER_NOT_FOUND', npcTarget);
      }
      // 发布闸拦：NPC 立绘 prompt 和音色不能为空（编辑期可空，发布必须有）
      if (!npc.portraitPrompt || !String(npc.portraitPrompt).trim()) {
        push(`NPC[${npcLabel(npc)}] 立绘文生图 prompt 不能为空（发布闸）`, 'NPC_PORTRAIT_PROMPT_EMPTY', npcTarget);
      }
      if (!npc.voiceId || !String(npc.voiceId).trim()) {
        push(`NPC[${npcLabel(npc)}] 音色 ID 不能为空（发布闸）`, 'NPC_VOICE_EMPTY', npcTarget);
      }
    }
  }

  // R3（spec §9）：hidden_quest.collectible_ids 每项**必须存在**，且**必须有节点会发放**。
  // 为什么不是「引用存在就够了」：本文件 2026-09-15 的可达性修复（见上方 grantableIds 注释）
  // 同轴的生产实测是 3 条线索无任何节点发放，语义完全相同 —— 「引用了存在、但**永不被满足**的 id」会让隐秘任务
  // 永远无法完成。既然已有 grantableIds，R3 复用它，而不另造一个「存在即可」的弱判据。（同上方例外：运营侧 assist-grant 不在本闸建模范围内。）
  //
  // 跳过条件：input.characters 未提供 ⇒ R3 跳过（characters 是**可选**字段，老调用点
  // 不传它 ⇒ 必须跳过，而不是当成「0 个角色」而炸）。角色无 hiddenQuest（缺省 / null）⇒ 跳过该角色。
  // 落点在 mode 分流之前：hidden_quest 与 mode 无关（narrative / rally 都可能有）。
  // collectibleIds / grantableIds 都是本作用域内已有的集合（上面按 input.collectibles / nodes[].effects.grant
  // 建好），此处**不重算** —— 重算一份会与上面漂移。
  if (input.characters) {
    for (const ch of input.characters) {
      const hiddenIds = ch.hiddenQuest?.collectible_ids;
      if (!hiddenIds || hiddenIds.length === 0) continue;
      const who = `角色[${ch.name || ch.id}]`;
      const chTarget: IssueTarget = { kind: 'character', id: ch.id, name: ch.name };
      for (const cid of hiddenIds) {
        if (!collectibleIds.has(cid)) {
          push(`${who} 的隐秘任务引用了不存在的线索 ${cid}`, 'CHAR_HIDDEN_REF_NOT_FOUND', chTarget);
          continue;
        }
        if (!grantableIds.has(cid)) {
          push(`${who} 的隐秘任务引用了没有任何节点发放的线索 ${cid}——该隐秘任务永远无法完成`, 'CHAR_HIDDEN_UNREACHABLE', chTarget);
        }
      }
    }
  }

  // R1（spec §9）：产品至少需要 1 个角色。
  // 跳过条件：input.characters 未提供（老调用点不传 ⇒ 跳过，不炸）。
  // 空数组 = 传了但 0 个角色 ⇒ 报错（与 R3 同口径：传了就校验）。
  if (input.characters && input.characters.length === 0) {
    push('产品至少需要 1 个角色（R1）', 'PRODUCT_NO_CHARACTER', { kind: 'product', id: product.id, name: product.name });
  }
  // R1 增强：角色必填字段非空 + 三维属性范围
  if (input.characters) {
    for (const ch of input.characters) {
      const who = `角色[${ch.name || ch.id}]`;
      const chTarget: IssueTarget = { kind: 'character', id: ch.id, name: ch.name };
      if (!ch.name || !String(ch.name).trim()) push(`${who} 名称不能为空（R1）`, 'CHAR_NAME_EMPTY', chTarget);
      if (!ch.faction || !String(ch.faction).trim()) push(`${who} 阵营不能为空（R1）`, 'CHAR_FACTION_EMPTY', chTarget);
      if (!ch.identity || !String(ch.identity).trim()) push(`${who} 社会身份不能为空（R1）`, 'CHAR_IDENTITY_EMPTY', chTarget);
      for (const attr of ['vitality', 'wisdom', 'insight'] as const) {
        const v = ch[attr];
        if (v !== undefined && v !== null && (typeof v !== 'number' || v < 0 || v > 100)) {
          push(`${who} ${attr} 必须在 0-100 之间（R1）`, 'CHAR_ATTR_RANGE', chTarget);
        }
      }
    }
  }

  // R4（spec §9）：条件树中的 skill 引用必须指向某个角色拥有的技能。
  // 收集范围：nodes[].unlockCondition、endings[].triggerCondition、tiers[].condition、
  //           nodes[].interactions[].requires。
  // 跳过条件：input.characters 未提供。
  if (input.characters && input.characters.length > 0) {
    const validSkillIds = new Set(
      input.characters.flatMap((c) => (c.skills ?? []).map((s) => s.id)),
    );
    const skillRefs = new Set<string>();
    const addSkills = (cond: WenlvCondition | undefined | null) => {
      for (const id of collectSkillRefs(cond)) skillRefs.add(id);
    };
    for (const n of nodes) addSkills(n.requires);
    for (const e of endings) addSkills(e.triggerCondition);
    for (const t of tiers) addSkills(t.condition);
    for (const n of nodes) {
      addSkills((n.puzzle as { requires?: WenlvCondition | null } | null)?.requires);
    }
    for (const sid of skillRefs) {
      if (!validSkillIds.has(sid)) {
        push(`条件引用了不存在的技能 ${sid}（R4）：没有任何角色拥有该技能`, 'SKILL_REF_NOT_FOUND');
      }
    }
  }

  // 边条件 / 边发放引用校验（二元图模型，narrative 与 rally 都跑）。
  // 运行时 traverseEdges「先 eval edge.condition、后合并 edge.grants」—— 边条件是真实门，
  // 旧闸只看 node.requires/ending 条件，边条件里的坏引用（不存在线索/completed）从未被拦。
  // 端点不存在由图校验 R3 管；时序死锁（发放点在条件点之后）由 R9 管。
  for (const e of edges) {
    const eTarget: IssueTarget = { kind: 'edge', id: e.id, name: `${nodeTitleById.get(e.fromNodeId) ?? e.fromNodeId}→${nodeTitleById.get(e.toNodeId) ?? e.toNodeId}` };
    checkRef(`边[${nodeTitleById.get(e.fromNodeId) ?? e.fromNodeId}→${nodeTitleById.get(e.toNodeId) ?? e.toNodeId}] condition`, e.condition, false, eTarget);
    checkGrants(`边[${nodeTitleById.get(e.fromNodeId) ?? e.fromNodeId}→${nodeTitleById.get(e.toNodeId) ?? e.toNodeId}]`, e.grants ?? [], false, eTarget);
  }

  if (product.mode === 'rally') {
    // 集章：禁 ending（保非终局）、需档位/可收集物/节点、档位条件只引用 collected 且 reward 存在、puzzle 须可判定
    if (endings.length > 0) push('集章产品不能包含结局（ending），请用 reward_tiers 表达兑奖', 'RALLY_HAS_ENDING');
    if (tiers.length === 0) push('集章产品至少 1 个档位（reward_tier）才能发布', 'RALLY_NO_TIER');
    if (collectibles.length === 0) push('集章产品至少 1 个可收集物', 'RALLY_NO_COLLECTIBLE');
    // 空产品无章可集，仍是不可发布的残缺内容；但本闸的真正要害在下面**逐节点**的发章绑定。
    if (nodes.length === 0) push('集章产品至少 1 个发章节点（且必须绑定点位）才能发布', 'RALLY_NO_NODE');
    for (const t of tiers) {
      const tierTarget: IssueTarget = { kind: 'tier', id: t.id, name: t.name };
      if (!t.name?.trim()) push(`档位[${t.id}] 名称不能为空`, 'TIER_NAME_EMPTY', tierTarget);
      if (t.condition == null) { push(`档位[${t.name || t.id}] 必须设置达成条件（condition）`, 'TIER_NO_CONDITION', tierTarget); continue; }
      for (const ref of collectRefs(t.condition)) {
        if (ref.kind !== 'collected') { push(`档位[${t.name || t.id}] 达成条件只能引用 collected`, 'TIER_CONDITION_KIND', tierTarget); continue; }
        if (!collectibleIds.has(ref.id)) { push(`档位[${t.name || t.id}] 引用不存在的线索 ${ref.id}`, 'COLLECTIBLE_REF_NOT_FOUND', tierTarget); continue; }
        if (!stampIds.has(ref.id)) push(`档位[${t.name || t.id}] 引用 ${ref.id} 非印章（stamp）可收集物，集章产品只能盖章收集`, 'COLLECTIBLE_TYPE_INVALID', tierTarget);
        // 可达性：无人发放的印章 ⇒ 该档位永远达不成（与上面 checkRef 的规则同源，档位走的是独立循环）
        if (!grantableIds.has(ref.id)) push(`档位[${t.name || t.id}] 引用印章 ${ref.id}，但没有任何节点发放它 —— 该档位永远无法达成；请让某个发章节点的 effects.grant（grant_collectibles）包含 ${ref.id}`, 'COLLECTIBLE_UNREACHABLE', tierTarget);
      }
      if (t.rewardId && !rewardIds.has(t.rewardId)) push(`档位[${t.name || t.id}] 引用不存在的奖励 ${t.rewardId}`, 'REWARD_REF_NOT_FOUND', tierTarget);
    }
    for (const n of nodes) {
      // 到场证明（发布侧，**逐节点**）：集章的全部产品承诺是「到场才能盖章」。
      // 发章节点（effects.grant 命中一件 stamp 型可收集物）必须绑定物理点位，否则游客足不出户即可集章。
      // 必须逐节点判定，而不是「至少一个点位节点」：一个绑定点位 + 若干未绑定的发章节点，
      // 仍能从沙发上集满并兑出真码（这正是本闸修复前的形态，也是 seed 样例的形态）。
      // 「是否发章」复用上面的 stampIds（rally 下 grants 只允许 stamp，见 checkGrants）。
      const grantsStamp = (n.grants ?? []).some((id) => stampIds.has(id));
      if (grantsStamp && !n.venuePointId) {
        push(`节点[${n.title}] 发放印章但未绑定点位（venuePointId 为空）：集章产品每个发章节点都必须绑定点位，否则可远程集章`, 'NODE_STAMP_NO_POINT', { kind: 'node', id: n.id, name: n.title });
      }
      const nTarget: IssueTarget = { kind: 'node', id: n.id, name: n.title };
      checkRef(`节点[${n.title}] requires`, n.requires, true, nTarget);
      checkGrants(`节点[${n.title}]`, n.grants, true, nTarget);
      checkPuzzle(n.title, n.nodeType, n.puzzle, { kind: 'node', id: n.id, name: n.title });
    }
    return issues;
  }

  // narrative：原规则逐位保留
  //
  // 唯一的增量（2026-09-20）：档位 condition 必填。原先这条判据只在 rally 分支里，
  // 而 `/redeem` 没有任何 mode 判据、`evalCondition` 对空条件恒真 ⇒ narrative 能发布一个
  // 「无条件、人人可领」的档位。**只搬「是否为空」这一条**，rally 专有的引用语义
  // （只能 collected / 必须 stamp / 必须有人发放）留在 rally 分支里 —— narrative 的档位条件
  // 未必引用 collected，照搬会凭空产生错误。
  // 生产实测两种模式档位数合计为 0 ⇒ 零行为变更。
  checkTierConditionPresent(tiers, push);
  // 二元节点模型（0074）下 nodeType 仅 'scene' | 'npc'，两者都是一等可玩节点
  // （C 端 play.vue 双分支渲染；R7 对 npc 节点另闸三件套）。
  // 本规则的原始意图是「narrative 不允许空气包发布」，不是「必须含 scene」——
  // 纯 NPC 对话驱动剧本（如 AI 一键完善后全部节点为 npc）合法可玩，不得误拦。
  // 错误码沿用 NARRATIVE_NO_SCENE（前端待办路由零改动）。
  const playableCount = nodes.filter((n) => n.nodeType === 'scene' || n.nodeType === 'npc').length;
  if (playableCount === 0) push('至少 1 个剧情节点（scene/npc）才能发布', 'NARRATIVE_NO_SCENE');
  if (endings.length === 0) push('至少 1 个结局（ending）才能发布', 'NARRATIVE_NO_ENDING');
  for (const n of nodes) {
    const nTarget: IssueTarget = { kind: 'node', id: n.id, name: n.title };
    checkRef(`节点[${n.title}] requires`, n.requires, false, nTarget);
    checkGrants(`节点[${n.title}]`, n.grants, false, nTarget);
    checkPuzzle(n.title, n.nodeType, n.puzzle, { kind: 'node', id: n.id, name: n.title });
  }
  for (const e of endings) {
    checkRef(`结局[${e.title}] trigger_condition`, e.triggerCondition, false, { kind: 'ending', id: e.id, name: e.title });
    if (e.rewardId && !rewardIds.has(e.rewardId)) push(`结局[${e.title}] 引用不存在的奖励 ${e.rewardId}`, 'REWARD_REF_NOT_FOUND', { kind: 'ending', id: e.id, name: e.title });
  }
  // 结局互斥性做不到，但**可区分性**必须做到 —— 见 specs/2026-09-18-wenlv-ending-resolution-design.md §2.1。
  // ① 引用集合完全相同：两个结局在任何状态下同真同假，玩家拿到哪个纯属偶然 ⇒ 硬拒。
  // ② priority 重复：解析靠 priority 决胜，平手只能退化到 id 字典序（任意）⇒ 要求作者显式打破。
  // 键必须覆盖**所有**引用种类（collected / completed / visited），不能只取 collected：
  // `all(collected C1)` 与 `all(collected C1, completed N5)` 在只取 collected 时会撞成同一个 key
  // 而被误报「完全相同」—— 但状态 {C1} 满足前者、不满足后者，**它们是可区分的**。
  // 这是发布闸的**假阳性**（会拦下合法内容），与漏报同样是缺陷。
  const refKeyOf = (c?: WenlvCondition | null) =>
    [...new Set(collectRefs(c).map((r) => `${r.kind}:${r.id}`))].sort().join('|');
  const seenRefs = new Map<string, string>();
  const seenPriority = new Map<number, string>();
  for (const e of endings) {
    const eTarget: IssueTarget = { kind: 'ending', id: e.id, name: e.title };
    const key = refKeyOf(e.triggerCondition);
    const prev = seenRefs.get(key);
    if (prev) push(`结局[${e.title}] 与 结局[${prev}] 的达成条件完全相同（引用了同一组线索 ${key}）—— 玩家拿到哪一个无意义，请合并或改条件`, 'ENDING_SAME_CONDITION', eTarget);
    else seenRefs.set(key, e.title);
    const pr = e.priority ?? 0;
    const prevPr = seenPriority.get(pr);
    if (prevPr) push(`结局[${e.title}] 与 结局[${prevPr}] 的 priority 重复（都是 ${pr}）—— 平手时解析会退化到 id 字典序，请给二者不同的 priority`, 'ENDING_DUP_PRIORITY', eTarget);
    else seenPriority.set(pr, e.title);
  }
  return issues;
}
