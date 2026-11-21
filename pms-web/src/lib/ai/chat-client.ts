import { TOKEN_KEY, AI_CHAT_URL } from '@/lib/constants';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

interface SSECallbacks {
  onAgentStart?: (agent: string, action: string) => void;
  onToken?: (text: string) => void;
  onDone?: (summary: string, elapsedMs: number) => void;
  onError?: (error: string, retry: boolean) => void;
}

export async function streamAIChat(
  message: string,
  history: Array<{ role: string; content: string }>,
  callbacks: SSECallbacks
): Promise<string> {
  const token = getToken();
  console.log('[SSE] 发起请求:', AI_CHAT_URL, { message, historyLen: history.length });
  const res = await fetch(AI_CHAT_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ message, history }),
  });

  console.log('[SSE] 响应状态:', res.status, 'Content-Type:', res.headers.get('content-type'), 'body:', !!res.body);
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    if (err.code === 'AI_DISABLED') throw new Error('AI 功能未开启');
    throw new Error(err.error || `AI 服务响应错误: ${res.status}`);
  }

  if (!res.body) throw new Error('AI 服务未返回流式数据');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let fullSummary = '';
  let eventCount = 0; // 调试用

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      eventCount++;
      try {
        const data = JSON.parse(line.slice(6));
        console.log(`[SSE #${eventCount}]`, data); // 调试日志
        if (data.agent && data.action) callbacks.onAgentStart?.(data.agent, data.action);
        else if (data.text) callbacks.onToken?.(data.text);
        else if (data.summary) { fullSummary = data.summary; callbacks.onDone?.(data.summary, data.elapsed_total_ms || 0); }
        else if (data.error) callbacks.onError?.(data.error, data.retry || false);
      } catch {
        console.warn('[SSE] 解析失败:', line.slice(6, 120)); // 调试日志
      }
    }
  }
  return fullSummary;
}
