/**
 * 剧本走场模拟器：把节点图当成一个**最小不动点**问题。
 *
 * 为什么需要它：publish 闸的 `validateWenlvIntegrity` 只查「引用了但**没有任何节点会写**它」。
 * 它**问不到**「那个会写的节点自己可不可达」—— 于是互相依赖的环（A 要 B 完成、B 要 A 完成，
 * 各自 self-complete）能让静态闸全绿而玩家一步走不动。本模块补的就是这一段。
 *
 * 复用引擎的纯函数，**不重新实现**（E4）：重写一遍必然与引擎漂移。
 * **只读**：不落任何 progress/events 行（E8）。
 */
import type { WenlvCondition, WenlvState } from '../db/schema/wenlv.js';
import { evalCondition, applyGrants, markVisited, selectEnding, nodeRequiresCredential } from './wenlv-engine.js';

export interface SimNode {
  id: string;
  nodeType: string;
  title: string;
  venuePointId?: string | null;
  requires?: WenlvCondition | null;
  grants?: string[] | null;
}
export interface SimEnding { id: string; title: string; triggerCondition: WenlvCondition | null; priority?: number | null }
export interface SimTier { id: string; name: string; order?: number | null; condition?: WenlvCondition | null }
export interface SimInput { nodes: SimNode[]; endings: SimEnding[]; tiers?: SimTier[] }

export interface SimBlocker { id: string; title: string; reason: string }

export interface SimResult {
  finalState: WenlvState;
  rounds: number;
  reachableNodeIds: string[];
  unreachable: SimBlocker[];
  reachableEndingIds: string[];
  /** 此刻结算会落库的结局 id（priority 最大者；平手按 id 字典序）。与运行时 settleEndings 共用同一份 selectEnding。 */
  resolvedEndingId: string | null;
  unreachableEndings: SimBlocker[];
  tiers: { id: string; name: string; met: boolean }[];
  /** 模拟器用到的乐观假设。**必须展示**，否则上界会被读成承诺（E5）。 */
  assumptions: string[];
  /** 凭证门会拦住的节点 id（走场本来就要到现场，只报数、不判失败）。 */
  credentialGatedNodeIds: string[];
}

const EMPTY: WenlvState = { visited: {}, collected: {}, completed: {} };

/** 状态指纹：三个集合里**为真**的键排序拼串。用于判「这一轮有没有变化」。 */
function stateKey(s: WenlvState): string {
  const part = (r: Record<string, boolean>) =>
    Object.keys(r).filter((k) => r[k]).sort().join(',');
  return `${part(s.visited)}|${part(s.collected)}|${part(s.completed)}`;
}

export function simulateWenlv(input: SimInput): SimResult {
  let state: WenlvState = EMPTY;
  let rounds = 0;

  // 不动点迭代。每轮把「当前条件成立」的节点的 grants 全部并入 —— 顺序无关，
  // 因为引擎里 grants 只做「置 true」，合并是可交换的（applyGrants 幂等）。
  // 收敛上界 = 节点数 + 1：每轮若还有变化，至少新增一个 visited（节点数有限）。
  for (;;) {
    let next = state;
    for (const n of input.nodes) {
      if (!evalCondition(n.requires, state)) continue;
      // scene 在 /trigger 就 applyGrants；puzzle 要 /answer 答对才 applyGrants。
      // 模拟器**假定玩家会答对**（答错零状态变化、可无限重试），故两者同形。
      next = applyGrants(n.grants, markVisited(next, n.id));
    }
    rounds++;
    if (stateKey(next) === stateKey(state) || rounds > input.nodes.length + 1) { state = next; break; }
    state = next;
  }

  const reachableNodeIds = input.nodes
    .filter((n) => evalCondition(n.requires, state))
    .map((n) => n.id);
  const reachableSet = new Set(reachableNodeIds);

  const unreachable = input.nodes
    .filter((n) => !reachableSet.has(n.id))
    // 只报「本来有前置条件、却永远不成立」的；无条件的节点必然可达。
    .map((n) => ({ id: n.id, title: n.title, reason: explain(n.requires, state, input, reachableSet) }));

  const { endingId: resolvedEndingId, satisfiedIds: reachableEndingIds } = selectEnding(input.endings, state);
  const reachableEndingSet = new Set(reachableEndingIds);
  const unreachableEndings = input.endings
    .filter((e) => !reachableEndingSet.has(e.id))
    .map((e) => ({ id: e.id, title: e.title, reason: explain(e.triggerCondition, state, input, reachableSet) }));

  const assumptions = [
    '谜题节点的「答对」是**假定**的：真实 /answer 答错时状态零变化（可无限重试），故模拟给出的是**乐观上界**，不是承诺。',
    '凭证门（到现场扫码/信标）在模拟中被**假定可过**：走场本来就要到现场，模拟只算剧情逻辑是否闭合。',
    '多个结局同时满足时，真实系统按 priority 取最大者（平手按 id 字典序），与模拟器**共用同一份** selectEnding，故 `resolvedEndingId` 就是真实落库的那个。',
  ];

  // 凭证门判定**必须复用引擎的 `nodeRequiresCredential`，不得在此重写一份**：
  // 该函数自己的注释维护着消费点清单。挂了点位的节点必须凭证（到场扫码/信标）。
  const credentialGatedNodeIds = input.nodes
    .filter((n) => nodeRequiresCredential({ venuePointId: n.venuePointId }))
    .map((n) => n.id);

  return {
    finalState: state, rounds, reachableNodeIds,
    unreachable, reachableEndingIds, resolvedEndingId, unreachableEndings,
    tiers: (input.tiers ?? []).map((t) => ({ id: t.id, name: t.name, met: evalCondition(t.condition ?? null, state) })),
    assumptions, credentialGatedNodeIds,
  };
}

/** 链式归因（E6）：找出这个条件里**最终仍不成立**的叶子，逐个说明为什么。
 *  只报 id 的操作者还是不知道改哪里。
 *
 *  边界：只对**最外层**条件里不成立的叶子归因。`nofM`（"至少 N 个"）在只差几个时
 *  整体已判 false，此处会列出**全部**未满足叶子 —— 这是有意的：操作者需要看到还差哪些。 */
function explain(
  cond: WenlvCondition | null | undefined,
  state: WenlvState,
  input: SimInput,
  reachable: ReadonlySet<string>,
): string {
  if (!cond) return '';
  const bad: string[] = [];
  walk(cond, (ref) => {
    const s = state[leafBucket[ref.kind]];
    if (s[ref.id]) return;
    if (ref.kind === 'visited') {
      if (!input.nodes.some((n) => n.id === ref.id)) bad.push(`要求到访节点「${ref.id}」，但该节点不存在`);
      else bad.push(`要求到访节点「${titleOf(input, ref.id)}」，而它自己也没解锁 —— 先修它`);
      return;
    }
    const writers = input.nodes.filter((n) => (n.grants ?? []).includes(ref.id));
    if (!writers.length) {
      bad.push(`线索「${ref.id}」没有任何节点发放（grants 里都没有它）`);
      return;
    }
    // 有 writer 却仍不成立 ⇒ 卡在「writer 自己没解锁」。
    // ⚠️ 文案**不得**无条件断言「那些节点都不可达」再补一句「其中某个可达」—— 那是自相矛盾的
    //    （本仓 `guard-message-mismatch` 前科：消息说的和条件判的不是一回事，操作者会去修一个没问题的节点）。
    //    两个分支都必须按 reachable 分支渲染。
    const names = writers.map((w) => `「${w.title}」`).join('、');
    const head = ref.kind === 'collected'
      ? `线索「${ref.id}」由 ${names} 发放`
      : `节点「${ref.id}」由 ${names} 完成`;
    const live = writers.filter((w) => reachable.has(w.id)).map((w) => `「${w.title}」`);
    bad.push(live.length
      ? `${head}；其中 ${live.join('、')} **本身可达**，说明卡点在它们的前置上（顺着这条链往下查）`
      : `${head}，而这些节点**都不可达** —— 先修它们`);
  });
  return bad.join('；');
}

const leafBucket = { visited: 'visited', collected: 'collected', completed: 'completed' } as const;

function titleOf(input: SimInput, id: string): string {
  return input.nodes.find((n) => n.id === id)?.title ?? id;
}

/** 递归下钻，遇到 ref 叶子就回调。与 wenlv-integrity.ts 的 collectRefs 同构。 */
function walk(cond: WenlvCondition, cb: (ref: { kind: 'visited' | 'collected' | 'completed'; id: string }) => void): void {
  // 兼容存量扁平格式：{ type: 'collected'|'visited'|'completed'|'skill', id }（实为 ref.kind）
  const c = cond as WenlvCondition | { type: 'collected' | 'visited' | 'completed' | 'skill'; id?: string };
  if (c.type === 'collected' || c.type === 'visited' || c.type === 'completed') {
    const id = c.id;
    if (id) cb({ kind: c.type, id });
    return;
  }
  if (c.type === 'skill') return; // 旧格式 skill 引用，模拟层跳过
  if (c.type === 'ref') {
    const ref = c.ref;
    // skill 引用角色技能，模拟层不建模角色状态，跳过（不影响 visited/collected/completed）
    if (ref.kind !== 'skill') cb(ref as { kind: 'visited' | 'collected' | 'completed'; id: string });
    return;
  }
  // role 型按角色 id 门控，无子条件
  if (c.type === 'role') return;
  // 到此处 c 必为 all/any/nofM
  const wc = c as WenlvCondition;
  let children: WenlvCondition[] | undefined;
  if (wc.type === 'nofM') children = wc.of;
  else if (wc.type === 'all' || wc.type === 'any') children = wc.conditions;
  if (Array.isArray(children)) {
    for (const ch of children) walk(ch, cb);
  }
}
