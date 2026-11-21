/**
 * 阿里云百炼（Model Studio）— 声音复刻 & TTS 语音合成
 *
 * API 文档: https://help.aliyun.com/zh/model-studio/voice-clone-design-http-api
 *
 * 环境变量:
 *   DASHSCOPE_API_KEY       — 百炼 API Key（必填）
 *   BAILIAN_WORKSPACE_ID    — 百炼业务空间 ID（必填）
 *   BAILIAN_TTS_MODEL       — 语音合成模型，默认 cosyvoice-v3-plus
 */

const API_KEY = (process.env.DASHSCOPE_API_KEY || '').trim();
const WORKSPACE_ID = (process.env.BAILIAN_WORKSPACE_ID || '').trim();
const TARGET_MODEL = (process.env.BAILIAN_TTS_MODEL || 'cosyvoice-v3-plus').trim();

// 百炼专属域名
const BASE_URL = `https://${WORKSPACE_ID}.cn-beijing.maas.aliyuncs.com`;
const ENROLL_URL = `${BASE_URL}/api/v1/services/audio/tts/customization`;

export const SERVER_BASE_URL = process.env.SERVER_BASE_URL || 'http://127.0.0.1:20002';

// ===========================================================================
// 通用请求
// ===========================================================================
function authHeaders(): Record<string, string> {
  if (!API_KEY) throw new Error('未配置 DASHSCOPE_API_KEY 环境变量');
  return {
    'Authorization': `Bearer ${API_KEY}`,
    'Content-Type': 'application/json',
  };
}

function checkConfig() {
  if (!API_KEY) throw new Error('未配置 DASHSCOPE_API_KEY，请在 .env 中设置百炼 API Key');
  if (!WORKSPACE_ID) throw new Error('未配置 BAILIAN_WORKSPACE_ID，请在 .env 中设置百炼业务空间 ID');
}

// ===========================================================================
// 声音复刻（创建音色）
// ===========================================================================

export async function submitVoiceClone(
  audioPath: string,
  prefix: string,
  languageHints: string[] = ['zh'],
): Promise<{ voiceId: string }> {
  checkConfig();

  const safePrefix = prefix.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'pms';

  const fs = await import('fs/promises');
  const path = await import('path');

  let body: Record<string, any>;

  // 统一使用 Qwen 声音复刻（下载音频 → base64），Qwen TTS 端点更稳定
  let audioBuffer: Buffer;
  if (audioPath.startsWith('/uploads/')) {
    const uploadsDir = path.resolve(import.meta.dirname, '..', '..', '..', 'uploads');
    const filename = audioPath.replace('/uploads/', '');
    audioBuffer = await fs.readFile(path.join(uploadsDir, filename));
  } else {
    // 公网 OSS URL：先下载再转 base64
    const res = await fetch(audioPath);
    if (!res.ok) throw new Error(`下载音频失败: ${res.status}`);
    audioBuffer = Buffer.from(await res.arrayBuffer());
  }
  const ext = (audioPath.split('.').pop() || 'mp3').toLowerCase();
  const mimeMap: Record<string, string> = { m4a: 'audio/mp4', wav: 'audio/wav', mp3: 'audio/mpeg', ogg: 'audio/ogg', webm: 'audio/webm', flac: 'audio/flac' };
  const audioInput = { data: `data:${mimeMap[ext] || 'audio/mpeg'};base64,${audioBuffer.toString('base64')}` };

  body = {
    model: 'qwen-voice-enrollment',
    input: {
      action: 'create',
      target_model: 'qwen3-tts-vc-2026-01-22',
      preferred_name: safePrefix,
      audio: audioInput,
      language: languageHints[0] || 'zh',
    },
  };

  const res = await fetch(ENROLL_URL, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  const data = (await res.json()) as any;

  if (!res.ok || data.code) {
    const errMsg = data.message || data.code || JSON.stringify(data);
    throw new Error(`声音复刻失败: ${errMsg}`);
  }

  // CosyVoice 返回 voice_id，Qwen 返回 voice
  const voiceId = data.output?.voice_id || data.output?.voice || '';
  if (!voiceId) {
    throw new Error(`声音复刻失败: 未获取到 voice_id — ${JSON.stringify(data)}`);
  }
  return { voiceId };
}

// ===========================================================================
// 查询音色状态
// ===========================================================================
export async function getVoiceCloneStatus(
  voiceId: string,
): Promise<{ status: string }> {
  return { status: 'ready' };
}

// ===========================================================================
// TTS 语音合成
// ===========================================================================
export async function synthesizeSpeech(
  text: string,
  voiceId: string,
  speechRate: number = 1.0,
  volume: number = 50,
): Promise<Buffer> {
  checkConfig();

  // 判断音色类型，选择对应的模型和参数
  const isQwenVoice = voiceId.startsWith('qwen-tts-vc');

  let body: any;
  if (isQwenVoice) {
    // Qwen 声音复刻：用克隆音色合成，添加自然度参数
    body = {
      model: 'qwen3-tts-vc-2026-01-22',
      input: {
        voice: voiceId,
        text,
        language: 'zh',
      },
      parameters: {
        speech_rate: speechRate,
        volume: volume,
      },
    };
  } else {
    // CosyVoice HTTP TTS: voice/format/sample_rate 全在 input 内
    body = {
      model: TARGET_MODEL,
      input: {
        text,
        voice: voiceId,
        format: 'mp3',
        sample_rate: 24000,
        rate: speechRate,
        volume: volume,
      },
    };
  }

  const res = await fetch(`${BASE_URL}/api/v1/services/audio/tts/SpeechSynthesizer`, {
    method: 'POST',
    headers: authHeaders(),
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(`TTS 合成失败: ${data.message || data.code || res.status}`);
  }

  const data = await res.json() as any;
  const audioUrl = data?.output?.audio?.url;
  if (!audioUrl) {
    // 尝试直接读取二进制响应
    const buf = Buffer.from(await res.arrayBuffer?.() || []);
    if (buf.length > 100) return buf;
    throw new Error(`TTS 合成失败: 无音频 URL — ${JSON.stringify(data).slice(0, 200)}`);
  }

  const audioRes = await fetch(audioUrl);
  if (!audioRes.ok) throw new Error(`TTS 音频下载失败: ${audioRes.status}`);
  return Buffer.from(await audioRes.arrayBuffer());
}

// ===========================================================================
// VideoRetalk (保持不变)
// ===========================================================================
import crypto from 'crypto';

// VideoRetalk 仅支持华北2（北京），不支持其他地域
const VIDEORETALK_ENDPOINT = 'https://videoretalk.cn-beijing.aliyuncs.com';
const ALIYUN_ACCESS_KEY = process.env.ALIYUN_ACCESS_KEY_ID || '';
const ALIYUN_SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || '';

function signRequest(method: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const query = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const signStr = `${method}&${encodeURIComponent('/')}&${encodeURIComponent(query)}`;
  return crypto.createHmac('sha1', `${ALIYUN_SECRET}&`).update(signStr).digest('base64');
}

function baseParams(action: string): Record<string, string> {
  return {
    Action: action,
    Version: '2023-09-15',
    AccessKeyId: ALIYUN_ACCESS_KEY,
    Timestamp: new Date().toISOString(),
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    Format: 'JSON',
    SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

/**
 * @deprecated 使用 submitVideoRetalkDashScope 替代。
 * 旧的 HMAC-SHA1 签名方式已不可用，VideoRetalk 已迁移到 DashScope 平台。
 */
export async function submitVideoRetalk(
  audioUrl: string,
  imageUrl: string,
): Promise<{ jobId: string }> {
  const params = {
    ...baseParams('SubmitVideoRetalkJob'),
    AudioURL: audioUrl,
    ImageURL: imageUrl,
    OutputConfig: JSON.stringify({ VideoCodec: 'h264', Resolution: '1080x1920' }),
  };
  const signature = signRequest('POST', params);
  const urlParams = new URLSearchParams({ ...params, Signature: signature });

  const res = await fetch(`${VIDEORETALK_ENDPOINT}/?${urlParams}`, { method: 'POST' });
  const data = (await res.json()) as any;
  const jobId = data.JobId || '';
  if (!jobId) throw new Error(`VideoRetalk任务提交失败: ${JSON.stringify(data)}`);
  return { jobId };
}

/**
 * @deprecated 使用 getVideoRetalkDashScope 替代。
 * 旧的 HMAC-SHA1 签名方式已不可用，VideoRetalk 已迁移到 DashScope 平台。
 */
export async function getVideoRetalkStatus(
  jobId: string,
): Promise<{ status: string; outputUrl?: string }> {
  const params = {
    ...baseParams('GetVideoRetalkJob'),
    JobId: jobId,
  };
  const signature = signRequest('POST', params);
  const urlParams = new URLSearchParams({ ...params, Signature: signature });

  const res = await fetch(`${VIDEORETALK_ENDPOINT}/?${urlParams}`, { method: 'POST' });
  const data = (await res.json()) as any;
  const jobStatus = data.Job?.Status || 'Processing';
  const statusMap: Record<string, string> = {
    Success: 'completed', Failed: 'failed', Processing: 'processing',
  };
  return {
    status: statusMap[jobStatus] || 'processing',
    outputUrl: data.Job?.Output?.MediaURL,
  };
}

// ===========================================================================
// VideoRetalk — DashScope API（替代旧的 HMAC-SHA1 签名方式）
// API 文档: https://help.aliyun.com/zh/model-studio/videoretalk-api
// ===========================================================================

const VIDEORETALK_DASHSCOPE_URL =
  'https://dashscope.aliyuncs.com/api/v1/services/aigc/image2video/video-synthesis/';

/** 提交 VideoRetalk 任务（DashScope 异步模式） */
export async function submitVideoRetalkDashScope(
  videoUrl: string,
  audioUrl: string,
  refImageUrl?: string,
): Promise<{ taskId: string }> {
  if (!API_KEY) throw new Error('未配置 DASHSCOPE_API_KEY，请在 .env 中设置百炼 API Key');

  const body: any = {
    model: 'videoretalk',
    input: {
      video_url: videoUrl,
      audio_url: audioUrl,
    },
    parameters: {
      video_extension: false,
    },
  };
  if (refImageUrl) {
    body.input.ref_image_url = refImageUrl;
  }

  const res = await fetch(VIDEORETALK_DASHSCOPE_URL, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
      'X-DashScope-Async': 'enable',
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(`VideoRetalk API 错误 (${res.status}): ${errData.message || errData.code || '未知错误'}`);
  }

  const data = (await res.json()) as any;
  const taskId = data?.output?.task_id || '';

  if (!taskId) {
    const errMsg = data?.message || data?.code || JSON.stringify(data);
    throw new Error(`VideoRetalk 任务提交失败: ${errMsg}`);
  }

  console.log('[VideoRetalk/DashScope] 任务已提交:', taskId);
  return { taskId };
}

/** 查询 VideoRetalk 任务结果（DashScope） */
export async function getVideoRetalkDashScope(
  taskId: string,
): Promise<{ status: string; outputUrl?: string }> {
  if (!API_KEY) throw new Error('未配置 DASHSCOPE_API_KEY');

  const res = await fetch(
    `https://dashscope.aliyuncs.com/api/v1/tasks/${taskId}`,
    {
      headers: {
        'Authorization': `Bearer ${API_KEY}`,
      },
    },
  );

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(`VideoRetalk API 错误 (${res.status}): ${errData.message || errData.code || '未知错误'}`);
  }

  const data = (await res.json()) as any;

  if (!data?.output?.task_status) {
    throw new Error(`VideoRetalk 任务状态查询异常: ${JSON.stringify(data).slice(0, 200)}`);
  }

  const taskStatus = data.output.task_status;

  // DashScope 状态映射
  const statusMap: Record<string, string> = {
    'SUCCEEDED': 'completed',
    'FAILED': 'failed',
    'PENDING': 'processing',
    'RUNNING': 'processing',
  };

  const status = statusMap[taskStatus] || 'processing';
  const outputUrl = data?.output?.video_url || data?.output?.results?.video_url || undefined;

  if (status === 'failed') {
    console.error('[VideoRetalk/DashScope] 任务失败:', taskId, data?.output?.message || data?.message);
  }

  return { status, outputUrl };
}
