import type { WenlvDialogueMessage } from '../../../db/schema/wenlv.js';

const LLM_URL = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const MODEL = process.env.WENLV_DIALOGUE_MODEL || 'qwen-plus';
const MAX_LEN = 200;

/**
 * 章节完成后调用，让 LLM 基于本轮对话生成「NPC 对玩家印象摘要」。
 * 摘要会注入下一章节的 system prompt，让 NPC 对玩家有跨章节记忆。
 * 失败返回 null —— 不阻塞章节完成，仅丢失记忆。
 */
export async function summarizeMemory(opts: {
  messages: WenlvDialogueMessage[];
  npcName: string;
  npcRole: string;
}): Promise<string | null> {
  const { messages, npcName, npcRole } = opts;

  const userMessages = messages.filter((m) => m.role === 'user').map((m) => m.content);
  if (userMessages.length === 0) return null;

  const systemPrompt = [
    `你是 NPC「${npcName}」，${npcRole}。`,
    '本章对话刚刚结束。请基于本轮玩家表现，用第二人称写一段不超过 200 字的「你对这个玩家的印象」。',
    '要点：玩家性格倾向、关键追问、显得好奇或警惕的话题、被回避的内容。',
    '只输出印象文本，不要带「印象：」前缀，不要换行。',
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
          { role: 'user', content: userMessages.join('\n') },
        ],
        stream: true,
        temperature: 0.4,
      }),
    });

    if (!resp.ok || !resp.body) return null;

    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let full = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const d = t.slice(5).trim();
        if (d === '[DONE]') continue;
        try {
          const p = JSON.parse(d);
          const delta = p.choices?.[0]?.delta?.content;
          if (delta) full += delta;
        } catch { /* skip */ }
      }
    }

    if (!full.trim()) return null;
    return full.length > MAX_LEN ? full.slice(0, MAX_LEN) : full;
  } catch {
    return null;
  }
}
