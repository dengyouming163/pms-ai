import type { WenlvChapterGoal, WenlvDialogueMessage } from '../../../db/schema/wenlv.js';
import { evaluateAttitude } from './attitude-evaluator.js';

const LLM_URL = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const MODEL = process.env.WENLV_DIALOGUE_MODEL || 'qwen-plus';

// 简单缓存：dialogueId + 用户消息数 → 命中的 criteria 索引
// 避免同一轮对话状态下重复调用 LLM
const criteriaCache = new Map<string, number[]>();

/**
 * 规范化 answerCriteria：兼容数组和逗号分隔字符串两种存储格式。
 * 管理端可能将 "a,b,c" 作为字符串存入，需拆分为 ['a','b','c']。
 */
export function normalizeCriteria(answerCriteria: string[] | string | undefined | null): string[] {
  if (!answerCriteria) return [];
  if (Array.isArray(answerCriteria)) {
    return answerCriteria.map((c) => String(c).trim()).filter(Boolean);
  }
  // 字符串：按中英文逗号拆分
  return String(answerCriteria)
    .split(/[,，]/)
    .map((c) => c.trim())
    .filter(Boolean);
}

/**
 * 用 LLM 语义判断哪些 answerCriteria 已被玩家在对话中触及。
 * 替代原来的精确字符串包含匹配（玩家不可能在自然对话中逐字命中完整条件句）。
 */
export async function evaluateCriteriaWithLLM(
  goal: WenlvChapterGoal,
  messages: WenlvDialogueMessage[],
  dialogueId?: string,
): Promise<number[]> {
  const criteria = normalizeCriteria(goal.answerCriteria);
  if (!criteria.length) return [];

  // 缓存键：dialogueId + 最后一条用户消息的 hash（简化为用户消息数 + 最后消息前20字）
  const userMsgs = messages.filter((m) => m.role === 'user');
  if (!userMsgs.length) return [];
  const cacheKey = `${dialogueId || 'na'}:${userMsgs.length}:${userMsgs[userMsgs.length - 1].content.slice(0, 20)}`;
  if (criteriaCache.has(cacheKey)) return criteriaCache.get(cacheKey)!;

  const criteriaText = criteria.map((c, i) => `${i + 1}. ${c}`).join('\n');
  const dialogueText = messages
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => `[${m.role}] ${m.content}`)
    .join('\n');

  const systemPrompt = [
    '你是叙事关卡裁判。根据对话内容，判断玩家是否已经触及了以下通关条件。',
    '注意：玩家不需要逐字说出条件原文，只要语义上涉及了该条件的核心内容即可算命中。',
    '输出格式：只输出命中的条件编号，用逗号分隔，例如 "1,3"。没有命中则输出 "0"。',
  ].join('\n');

  const userPrompt = `通关条件：\n${criteriaText}\n\n对话记录：\n${dialogueText}\n\n请输出命中的条件编号。`;

  try {
    const resp = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY || process.env.ARK_API_KEY || ''}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
      }),
    });

    if (!resp.ok) return [];

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = (data.choices?.[0]?.message?.content || '').trim();

    const indices: number[] = [];
    const matches = raw.match(/\d+/g);
    if (matches) {
      for (const m of matches) {
        const idx = parseInt(m, 10) - 1;
        if (idx >= 0 && idx < criteria.length && !indices.includes(idx)) {
          indices.push(idx);
        }
      }
    }

    criteriaCache.set(cacheKey, indices);
    // 限制缓存大小
    if (criteriaCache.size > 200) {
      const firstKey = criteriaCache.keys().next().value;
      if (firstKey) criteriaCache.delete(firstKey);
    }
    return indices;
  } catch {
    return [];
  }
}

/**
 * 校验 LLM 调用 completeNode 时是否真的达成了章节目标。
 * 防偷懒三层防护的后端实现：
 *   1. minTurns：对话轮次不足则拒绝
 *   2. convince 类型走 LLM 态度评分（抵触/中立/认同，仅认同通过）
 *   3. puzzle / reveal 走 answerCriteria LLM 语义匹配（替代原来的精确字符串匹配）
 *   4. choice 类型由独立 API 保证，此处直接通过
 * 模块 C：collaborative 模式下要求所有队员各发≥1条 user 消息（按 [队员xxx] 前缀去重）。
 */
export async function checkGoalReached(opts: {
  goal: WenlvChapterGoal;
  messages: WenlvDialogueMessage[];
  turnCount: number;
  teamSize?: number;  // 模块 C：团队模式队员数
  dialogueId?: string;
  collectedClueIds?: string[];  // 模块：出示证物——玩家已收集的证物 ID
}): Promise<{ passed: boolean; reason: string }> {
  const { goal, messages, turnCount, teamSize, dialogueId, collectedClueIds = [] } = opts;

  // choice 类型由 POST /dialogue/:id/choice 直接推进，message 路径不拦截
  if (goal.type === 'choice') {
    return { passed: true, reason: 'choice type handled by choice API' };
  }

  // 1. 最小轮次守卫
  if (turnCount < goal.minTurns) {
    return { passed: false, reason: `对话轮次不足（${turnCount}/${goal.minTurns}），请继续引导玩家。` };
  }

  // 模块 C：协作模式要求所有队员各发≥1条消息（按 [队员xxx] 前缀去重统计）
  if (goal.collaborative && teamSize && teamSize > 1) {
    const senderSet = new Set<string>();
    for (const m of messages) {
      if (m.role !== 'user') continue;
      const match = m.content.match(/^\[队员([a-zA-Z0-9]+)\]/);
      if (match) senderSet.add(match[1]);
    }
    if (senderSet.size < teamSize) {
      return {
        passed: false,
        reason: `需要所有队员（${teamSize}人）各发至少 1 条消息，当前仅 ${senderSet.size} 人发言`,
      };
    }
  }

  // 2. convince 走 LLM 态度评分
  if (goal.type === 'convince') {
    const r = await evaluateAttitude({ messages, goal: goal.description });
    return { passed: r.passed, reason: r.reason };
  }

  // 3. puzzle / reveal：answerCriteria LLM 语义匹配
  const criteria = normalizeCriteria(goal.answerCriteria);
  if (criteria.length) {
    const hitIndices = await evaluateCriteriaWithLLM(goal, messages, dialogueId);
    // 要求至少命中一个条件
    if (hitIndices.length === 0) {
      return { passed: false, reason: '目标尚未达成，玩家尚未触及关键信息，请继续引导。' };
    }
  }

  // 4. 出示证物命中（clueIds）：目标要求的证物必须全部已收集
  const requiredClueIds = goal.clueIds || [];
  if (requiredClueIds.length) {
    const collected = new Set(collectedClueIds);
    const missing = requiredClueIds.filter((id) => !collected.has(id));
    if (missing.length) {
      return { passed: false, reason: '目标尚未达成，请出示必要的证物。' };
    }
  }

  return { passed: true, reason: '目标已达成' };
}

/**
 * 计算 answerCriteria 命中数量（用于前端进度展示）。
 * 使用 LLM 语义匹配，与 checkGoalReached 保持一致。
 */
export function computeCriteriaHit(goal: WenlvChapterGoal, messages: WenlvDialogueMessage[]): number {
  return computeHitIndices(goal, messages).length;
}

/**
 * 返回命中的 criteria 索引数组（前端据此显示 ✓/○）。
 * 注意：此函数为同步，优先返回缓存的 LLM 评估结果；若无缓存则回退到精确匹配。
 * LLM 评估由 evaluateCriteriaWithLLM 异步执行并写入缓存。
 */
export function computeHitIndices(goal: WenlvChapterGoal, messages: WenlvDialogueMessage[]): number[] {
  const criteria = normalizeCriteria(goal.answerCriteria);
  if (!criteria.length) return [];
  const userMsgs = messages.filter((m) => m.role === 'user');
  if (!userMsgs.length) return [];
  // 尝试从缓存获取（由 evaluateCriteriaWithLLM 写入）
  const cacheKey = `na:${userMsgs.length}:${userMsgs[userMsgs.length - 1].content.slice(0, 20)}`;
  const cached = criteriaCache.get(cacheKey);
  if (cached) return cached;
  // 回退：精确字符串匹配（仅作为兜底显示，不影响通关判定）
  const allUserMsgs = userMsgs.map((m) => m.content.toLowerCase());
  const indices: number[] = [];
  criteria.forEach((c, i) => {
    if (allUserMsgs.some((msg) => msg.includes(c.toLowerCase()))) {
      indices.push(i);
    }
  });
  return indices;
}
