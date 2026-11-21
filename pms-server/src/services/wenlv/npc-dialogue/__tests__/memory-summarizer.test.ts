import { describe, it, expect, vi } from 'vitest';
import { summarizeMemory } from '../memory-summarizer.js';
import type { WenlvDialogueMessage } from '../../../../db/schema/wenlv.js';

describe('summarizeMemory', () => {
  const messages: WenlvDialogueMessage[] = [
    { role: 'assistant', content: '你来了。', ts: 1 },
    { role: 'user', content: '听说这里有条暗道？', ts: 2 },
    { role: 'assistant', content: '你怎么知道。', ts: 3 },
    { role: 'user', content: '我观察的。', ts: 4 },
  ];

  it('LLM 失败时返回 null，不抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const r = await summarizeMemory({ messages, npcName: '老周', npcRole: '守夜人' });
    expect(r).toBeNull();
    vi.unstubAllGlobals();
  });

  it('LLM 成功时返回字符串摘要', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"玩家好奇心强"}}]}\n\n'));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
    }));
    const r = await summarizeMemory({ messages, npcName: '老周', npcRole: '守夜人' });
    expect(r).toBe('玩家好奇心强');
    vi.unstubAllGlobals();
  });

  it('超长摘要截断到 200 字', async () => {
    const long = 'a'.repeat(500);
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(c) {
          c.enqueue(new TextEncoder().encode(`data: {"choices":[{"delta":{"content":"${long}"}}]}\n\n`));
          c.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
          c.close();
        },
      }),
    }));
    const r = await summarizeMemory({ messages, npcName: '老周', npcRole: '守夜人' });
    expect(r?.length).toBeLessThanOrEqual(200);
    vi.unstubAllGlobals();
  });
});
