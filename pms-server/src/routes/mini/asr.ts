import { Hono } from 'hono';
import { parseMiniToken } from '../../middleware/mini-auth.js';

const route = new Hono();

// POST /api/mini/asr/transcribe — C端语音转文字
// 玩家在小程序按住麦克风录音 → 上传 audio 文件 → 服务端转发 DashScope Paraformer → 返回文字
route.post('/transcribe', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const formData = await c.req.formData();
  const audioFile = formData.get('audio') as File | null;
  if (!audioFile) return c.json({ success: false, error: '缺少 audio 文件' }, 400);

  // DashScope Paraformer ASR：基础 URL 与 LLM 共用 ARK_BASE_URL（默认 compatible-mode/v1），
  // 但 ASR 走 /api/v1/audio/transcriptions 端点（与 LLM 的 /chat/completions 不同路径）。
  // ⚠️ 部署时验证：若 ARK_BASE_URL 含 /compatible-mode/v1 后缀，拼接本端点会变成
  // /compatible-mode/v1/api/v1/audio/transcriptions —— 不属于 DashScope ASR 真实路径。
  // 推荐显式设置独立的 DASHSCOPE_BASE_URL 环境变量（无后缀）来覆盖。
  const LLM_URL = process.env.DASHSCOPE_BASE_URL?.replace(/\/+$/, '')
    || process.env.ARK_BASE_URL?.replace(/\/+$/, '')
    || 'https://dashscope.aliyuncs.com';
  const apiKey = process.env.DASHSCOPE_API_KEY || process.env.ARK_API_KEY || '';

  try {
    const fd = new FormData();
    fd.append('model', 'paraformer-v2');
    fd.append('file', audioFile, audioFile.name);

    const resp = await fetch(`${LLM_URL}/api/v1/audio/transcriptions`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${apiKey}` },
      body: fd,
    });

    if (!resp.ok) return c.json({ success: false, error: 'ASR 服务不可用' }, 502);

    const data = await resp.json() as { text?: string };
    return c.json({ success: true, text: data.text || '' });
  } catch {
    return c.json({ success: false, error: 'ASR 失败' }, 500);
  }
});

export default route;
