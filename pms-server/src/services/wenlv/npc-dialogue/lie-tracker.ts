/**
 * 谎言/矛盾追踪器（P3-C Task 1）。
 *
 * 设计：内存态陈述仓库 dialogueId → Statement[]，对话结束清理。
 * 当 LLM 在 cross-examine 章节产出 [claim topic="..."]...[/claim] 标记时，
 * wenlv-dialogue.ts 流式解析后调 recordStatement 入库；done 前调 detectContradictions
 * 用 LLM 判断同 topic 下不同 NPC 的陈述是否矛盾，矛盾则 SSE 推 contradiction 事件。
 *
 * 复用态度评估器（attitude-evaluator.ts）的 LLM 网关与超时兜底风格 ——
 * 失败安全默认 false（不误报矛盾），避免误导玩家。
 */

const LLM_URL = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const MODEL = process.env.WENLV_DIALOGUE_MODEL || 'qwen-plus';

export interface Statement {
  npcId: string;
  nodeId: string;
  claim: string;     // NPC 声称的事实（[claim]...[/claim] 内文本）
  topic: string;     // 话题关键词（[claim topic="..."] 的属性值）
  ts: number;
}

export interface ContradictionPair {
  a: Statement;
  b: Statement;
  reason: string;
}

// 内存态陈述仓库：dialogueId → statements
// 退出/重启丢失可接受（cross-examine 章节内比对即可，不跨会话）
const statementStore = new Map<string, Statement[]>();

/** 记录 NPC 声称的事实（同一对话内累积）。重复 claim 不去重，便于呈现"反复强调"。 */
export function recordStatement(dialogueId: string, npcId: string, nodeId: string, claim: string, topic: string): void {
  if (!dialogueId || !claim || !topic) return;
  if (!statementStore.has(dialogueId)) statementStore.set(dialogueId, []);
  statementStore.get(dialogueId)!.push({ npcId, nodeId, claim: claim.trim(), topic: topic.trim(), ts: Date.now() });
}

/** 取本对话已记录的所有陈述（前端调试/展示用）。 */
export function getStatements(dialogueId: string): Statement[] {
  return statementStore.get(dialogueId) || [];
}

/**
 * 检测矛盾：用 LLM 判断两个不同 NPC 对同一 topic 的陈述是否矛盾。
 * 按 topic 分组两两比较；同 NPC 的多句不互比（玩家可追问同一 NPC，不算交叉矛盾）。
 */
export async function detectContradictions(dialogueId: string): Promise<ContradictionPair[]> {
  const statements = statementStore.get(dialogueId) || [];
  if (statements.length < 2) return [];

  const contradictions: ContradictionPair[] = [];

  // 按 topic 分组
  const byTopic = new Map<string, Statement[]>();
  for (const s of statements) {
    if (!byTopic.has(s.topic)) byTopic.set(s.topic, []);
    byTopic.get(s.topic)!.push(s);
  }

  for (const [, group] of byTopic) {
    if (group.length < 2) continue;
    for (let i = 0; i < group.length - 1; i++) {
      for (let j = i + 1; j < group.length; j++) {
        if (group[i].npcId === group[j].npcId) continue;
        const isContradiction = await llmCheckContradiction(group[i], group[j]);
        if (isContradiction) {
          contradictions.push({
            a: group[i],
            b: group[j],
            reason: '矛盾',
          });
        }
      }
    }
  }
  return contradictions;
}

/**
 * LLM 判定两陈述是否矛盾。
 * 安全默认 false：网关失败、解析异常、内容过短都按"不矛盾"处理，避免误报干扰玩家。
 */
async function llmCheckContradiction(a: Statement, b: Statement): Promise<boolean> {
  // 极短或同义陈述直接跳过 LLM（节省调用 + 避免噪音）
  if (a.claim.length < 4 || b.claim.length < 4) return false;
  if (a.claim.trim() === b.claim.trim()) return false;

  const systemPrompt = [
    '你是叙事裁判。读两段同一话题下、不同 NPC 的陈述，判断是否在事实层面互相矛盾。',
    '只输出 "矛盾" 或 "不矛盾"，不要带任何解释或标点。',
  ].join('\n');

  const userPrompt = [
    `话题：${a.topic}`,
    `NPC A 陈述：${a.claim}`,
    `NPC B 陈述：${b.claim}`,
    '请判断 A 与 B 在事实层面是否矛盾。',
  ].join('\n');

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

    if (!resp.ok) return false;
    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    const raw = (data.choices?.[0]?.message?.content || '').trim();
    return raw === '矛盾';
  } catch {
    return false;
  }
}

/** 对话结束时清理本对话的陈述库，避免内存泄漏。 */
export function clearStatements(dialogueId: string): void {
  statementStore.delete(dialogueId);
}
