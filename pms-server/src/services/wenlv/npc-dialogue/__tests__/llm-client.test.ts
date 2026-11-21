import { describe, it, expect, vi } from 'vitest';
import { streamNpcReply } from '../llm-client.js';
import type { WenlvNpcPersona, WenlvChapterGoal } from '../../../../db/schema/wenlv.js';

describe('streamNpcReply', () => {
  const persona: WenlvNpcPersona = {
    personality: ['寡言'], tone: '低沉', catchphrases: [], backstory: '', clues: [], taboos: [],
  };
  const goal: WenlvChapterGoal = { type: 'puzzle', description: '猜密码', answerCriteria: ['1234'], minTurns: 3 };

  it('LLM 失败时返回兜底文本，不抛异常', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    const chunks: any[] = [];
    for await (const chunk of streamNpcReply({ messages: [], persona, goal, npcName: '老周', npcRole: '守夜人' })) {
      chunks.push(chunk);
    }
    expect(chunks.length).toBeGreaterThan(0);
    const textChunk = chunks.find((c) => c.type === 'text');
    expect(textChunk).toBeDefined();
    expect(textChunk.delta).toBe('嗯……让我想想。');
    vi.unstubAllGlobals();
  });

  it('LLM 返回非 200 时返回兜底', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, body: null }));
    const chunks: any[] = [];
    for await (const chunk of streamNpcReply({ messages: [], persona, goal, npcName: '老周', npcRole: '守夜人' })) {
      chunks.push(chunk);
    }
    const textChunk = chunks.find((c) => c.type === 'text');
    expect(textChunk?.delta).toBe('嗯……让我想想。');
    vi.unstubAllGlobals();
  });
});
