import { AGENT_API_URL } from '../constants.js';

interface ChatRequest {
  message: string;
  history?: Array<{ role: string; content: string }>;
  merchantId: string;
  storeId: string;
}

/**
 * 向 pms-agent 发送对话请求，返回 SSE ReadableStream
 */
export async function aiChatStream(req: ChatRequest): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 30000);
  const res = await fetch(`${AGENT_API_URL}/chat`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'X-Merchant-Id': req.merchantId,
      'X-Store-Id': req.storeId,
    },
    body: JSON.stringify({
      message: req.message,
      history: req.history || [],
    }),
    signal: controller.signal,
  }).finally(() => clearTimeout(timeoutId));

  if (!res.ok) {
    throw new Error(`AI 服务错误: ${res.status}`);
  }

  return res;
}
