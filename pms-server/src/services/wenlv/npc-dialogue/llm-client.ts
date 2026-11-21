import { buildSystemPrompt } from './prompt-builder.js';
import type { WenlvNpcPersona, WenlvChapterGoal, WenlvDialogueMessage, WenlvNpcRelationship, WenlvNpcMention } from '../../../db/schema/wenlv.js';
import type { VisualAnchor } from './visual-anchor.js';

/**
 * LLM 对话客户端（DashScope OpenAI 兼容模式）。
 * 支持 function calling：completeNode（完成章节）/ giveClue（透露线索）/ mentionNpc（提及他 NPC）/ transferInfo（向 NPC 传信息）。
 * 流式返回文本 delta，遇到工具调用时返回 tool_call 事件。
 *
 * 复用 asset-gen 的同一网关（DashScope 兼容模式），但用独立的 model env。
 */
const LLM_URL = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const MODEL = process.env.WENLV_DIALOGUE_MODEL || 'qwen-plus';
const FALLBACK_TEXT = '嗯……让我想想。';

/** LLM 可调用的工具定义。 */
const TOOLS = [
  {
    type: 'function' as const,
    function: {
      name: 'completeNode',
      description: '当玩家已达成章节目标时调用，完成本章节。仅在确认目标达成后调用。',
      parameters: {
        type: 'object',
        properties: {
          nextNodeId: { type: 'string', description: '下一节点 id' },
          summary: { type: 'string', description: '本章对话摘要，存入 NPC 记忆' },
        },
        required: ['summary'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'giveClue',
      description: 'NPC 主动透露一条预设线索。',
      parameters: {
        type: 'object',
        properties: { clueId: { type: 'string' } },
        required: ['clueId'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'mentionNpc',
      description: '在对话中提到另一位 NPC。后端会把提及内容记到目标 NPC 的待处理队列，目标 NPC 下次出场时会知道这次提及。',
      parameters: {
        type: 'object',
        properties: {
          targetNpcId: { type: 'string', description: '被提及的目标 NPC id' },
          context: { type: 'string', description: '提及的内容，如「老周提到陈婶最近行为反常」' },
        },
        required: ['targetNpcId', 'context'],
      },
    },
  },
  {
    type: 'function' as const,
    function: {
      name: 'transferInfo',
      description: '把一条关键信息正式传递给另一位 NPC。比 mentionNpc 更强：目标 NPC 下次出场时必须复述或知晓此信息。',
      parameters: {
        type: 'object',
        properties: {
          toNpcId: { type: 'string', description: '接收信息的目标 NPC id' },
          info: { type: 'string', description: '传递的信息内容' },
        },
        required: ['toNpcId', 'info'],
      },
    },
  },
];

export type NpcStreamChunk =
  | { type: 'text'; delta: string }
  | { type: 'tool_call'; name: string; args: Record<string, unknown> }
  | { type: 'done'; fullText: string };

export async function* streamNpcReply(opts: {
  messages: WenlvDialogueMessage[];
  persona: WenlvNpcPersona;
  goal: WenlvChapterGoal;
  npcName: string;
  npcRole: string;
  npcMemory?: string;
  relationships?: WenlvNpcRelationship[];
  pendingMentions?: WenlvNpcMention[];
  visualAnchors?: VisualAnchor[];
  criteriaHints?: string[];
  attitudeLevel?: 1 | 2 | 3;
  discoveredClues?: string[];
  // Task 6：剧本调音透传（product.config.tuneMode），'family' 时 prompt 注入亲子安全边界。
  tuneMode?: string;
}): AsyncGenerator<NpcStreamChunk> {
  const { messages, persona, goal, npcName, npcRole, npcMemory, relationships, pendingMentions, visualAnchors, criteriaHints, attitudeLevel, discoveredClues, tuneMode } = opts;

  const systemPrompt = buildSystemPrompt({ npcName, npcRole, persona, goal, memory: npcMemory, relationships, pendingMentions, visualAnchors, criteriaHints, attitudeLevel, discoveredClues, tuneMode });

  const apiMessages = [
    { role: 'system' as const, content: systemPrompt },
    ...messages.map((m) => ({ role: m.role, content: m.content })),
  ];

  try {
    const apiKey = process.env.DASHSCOPE_API_KEY || process.env.ARK_API_KEY || '';
    const resp = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: apiMessages,
        tools: TOOLS,
        stream: true,
        temperature: 0.7,
      }),
    });

    if (!resp.ok || !resp.body) {
      yield { type: 'text', delta: FALLBACK_TEXT };
      yield { type: 'done', fullText: FALLBACK_TEXT };
      return;
    }

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let fullText = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      const lines = buffer.split('\n');
      buffer = lines.pop() || '';

      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('data:')) continue;
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') continue;

        try {
          const parsed = JSON.parse(data);
          const choice = parsed.choices?.[0];
          const delta = choice?.delta;

          // 工具调用
          if (delta?.tool_calls) {
            for (const tc of delta.tool_calls) {
              if (tc.function?.name && tc.function?.arguments) {
                let args: Record<string, unknown> = {};
                try {
                  args = JSON.parse(tc.function.arguments);
                } catch {
                  // 流式中 arguments 是分段到达的，未完整时跳过
                  continue;
                }
                yield { type: 'tool_call', name: tc.function.name, args };
              }
            }
          }

          // 文本增量
          if (delta?.content) {
            fullText += delta.content;
            yield { type: 'text', delta: delta.content };
          }
        } catch {
          // 跳过格式错误的行
        }
      }
    }

    yield { type: 'done', fullText };
  } catch {
    // 任何异常都返回兜底，不中断对话流
    yield { type: 'text', delta: FALLBACK_TEXT };
    yield { type: 'done', fullText: FALLBACK_TEXT };
  }
}
