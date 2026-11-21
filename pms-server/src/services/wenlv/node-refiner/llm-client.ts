// node_refiner LLM 调用：SSE 流式拼装 + JSON 提取。环境变量与 NPC 对话服务一致。
const BASE = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const MODEL = process.env.WENLV_DIALOGUE_MODEL || 'qwen-plus';

export async function chatJsonObject(opts: {
  system: string; user: string; temperature?: number;
}): Promise<unknown> {
  const resp = await fetch(`${BASE}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY || process.env.ARK_API_KEY || ''}` },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: 'system', content: opts.system }, { role: 'user', content: opts.user }],
      stream: true,
      temperature: opts.temperature ?? 0.6,
    }),
  });
  if (!resp.ok || !resp.body) throw new Error(`LLM 调用失败 HTTP ${resp.status}`);

  const reader = resp.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let full = '';
  for (;;) {
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
        const delta = JSON.parse(d).choices?.[0]?.delta?.content;
        if (delta) full += delta;
      } catch { /* 跳过非 JSON 心跳 */ }
    }
  }
  if (!full.trim()) throw new Error('LLM 返回为空');
  const cleaned = full.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  return JSON.parse(cleaned);
}
