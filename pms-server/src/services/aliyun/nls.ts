/**
 * 阿里云智能语音交互（NLS）— 一句话识别（ASR）
 *
 * API 文档: https://help.aliyun.com/zh/isi/short-sentence-recognition
 *
 * 流程: 获取 Token → 调用 RESTful ASR 接口 → 返回识别文字
 *
 * 环境变量:
 *   ALIBABA_CLOUD_ACCESS_KEY_ID     — 阿里云 AccessKey（必填）
 *   ALIBABA_CLOUD_ACCESS_KEY_SECRET — 阿里云 AccessKey Secret（必填）
 *   ALIYUN_NLS_APPKEY               — NLS 项目 AppKey（必填，在智能语音交互控制台创建项目获取）
 */
import crypto from 'crypto';

const ACCESS_KEY = process.env.ALIBABA_CLOUD_ACCESS_KEY_ID || process.env.ALIYUN_ACCESS_KEY_ID || '';
const SECRET = process.env.ALIBABA_CLOUD_ACCESS_KEY_SECRET || process.env.ALIYUN_ACCESS_KEY_SECRET || '';
const NLS_APPKEY = process.env.ALIYUN_NLS_APPKEY || '';

// NLS 服务域名
const NLS_TOKEN_ENDPOINT = 'https://nls-meta.cn-shanghai.aliyuncs.com';
const NLS_ASR_ENDPOINT = 'https://nls-gateway.cn-shanghai.aliyuncs.com/stream/v1/asr';

// Token 缓存（有效期1小时，提前5分钟刷新）
let cachedToken: string | null = null;
let tokenExpireAt: number = 0;

// ===========================================================================
// 通用签名（阿里云 API 签名 V1）
// ===========================================================================
function baseParams(action: string): Record<string, string> {
  return {
    Action: action,
    Version: '2018-05-18',
    AccessKeyId: ACCESS_KEY,
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureMethod: 'HMAC-SHA1',
    SignatureVersion: '1.0',
    Format: 'JSON',
    SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

function signParams(method: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const query = sortedKeys
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const signStr = `${method}&${encodeURIComponent('/')}&${encodeURIComponent(query)}`;
  return crypto.createHmac('sha1', `${SECRET}&`).update(signStr).digest('base64');
}

// ===========================================================================
// 获取 NLS Token
// ===========================================================================
export async function getNLSToken(): Promise<string> {
  if (!ACCESS_KEY || !SECRET) {
    throw new Error('未配置阿里云 AccessKey（ALIBABA_CLOUD_ACCESS_KEY_ID / ALIBABA_CLOUD_ACCESS_KEY_SECRET）');
  }

  // 检查缓存
  if (cachedToken && Date.now() < tokenExpireAt) {
    return cachedToken;
  }

  const params = baseParams('CreateToken');
  const signature = signParams('POST', params);
  const urlParams = new URLSearchParams({ ...params, Signature: signature });

  const res = await fetch(`${NLS_TOKEN_ENDPOINT}/pop/2018-05-18/tokens`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: urlParams.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NLS Token 获取失败 (${res.status}): ${text.slice(0, 200)}`);
  }

  const data = (await res.json()) as any;
  const token = data?.Token?.Id || '';

  if (!token) {
    throw new Error(`NLS Token 获取失败: ${JSON.stringify(data).slice(0, 200)}`);
  }

  // 缓存 Token，提前5分钟过期
  const expireIn = (data?.Token?.ExpireTime || 3600) - 300;
  cachedToken = token;
  tokenExpireAt = Date.now() + expireIn * 1000;

  console.log('[NLS] Token 已刷新，有效期:', expireIn, '秒');
  return token;
}

// ===========================================================================
// 一句话识别（ASR）
// ===========================================================================

/** 支持的音频格式 */
const FORMAT_MIME_MAP: Record<string, string> = {
  'audio/pcm': 'pcm',
  'audio/wav': 'wav',
  'audio/wave': 'wav',
  'audio/mpeg': 'mp3',
  'audio/mp3': 'mp3',
  'audio/opus': 'opus',
  'audio/ogg': 'opus',
  'audio/webm': 'opus',
  'audio/aac': 'aac',
  'audio/m4a': 'm4a',
  'audio/x-m4a': 'm4a',
  'audio/spx': 'speex',
};

/** WAV 文件头长度 */
const WAV_HEADER_SIZE = 44;

/**
 * 一句话识别
 * @param audioBuffer 音频数据（支持 PCM/WAV/MP3/OPUS 等格式）
 * @param mimeType 音频 MIME 类型（用于推断格式）
 * @returns 识别结果文本
 */
export async function recognizeSpeech(
  audioBuffer: Buffer,
  mimeType: string = 'audio/pcm',
): Promise<{ text: string }> {
  // 检查 AppKey
  if (!NLS_APPKEY) {
    throw new Error('未配置 ALIYUN_NLS_APPKEY，请在阿里云智能语音交互控制台创建项目获取 AppKey');
  }

  // 获取 Token
  const token = await getNLSToken();

  // 推断音频格式
  let format = FORMAT_MIME_MAP[mimeType] || 'pcm';
  let body = audioBuffer;

  // 自动检测 WAV 头：如果是 WAV 格式但 mimeType 标记为 PCM，自动跳过 WAV 头
  if (format === 'pcm' && audioBuffer.length > 44) {
    const magic = audioBuffer.toString('utf8', 0, 4);
    const wave = audioBuffer.toString('utf8', 8, 12);
    if (magic === 'RIFF' && wave === 'WAVE') {
      console.log('[NLS] 检测到 WAV 头，自动转为 WAV 格式识别');
      format = 'wav';
      // NLS REST 接口支持直接传 WAV，无需剥离头
    }
  }

  // 如果明确是 WAV 格式但文件很小，可能是 PCM 裸流被误标记
  if (format === 'wav' && audioBuffer.length > 44) {
    const magic = audioBuffer.toString('utf8', 0, 4);
    if (magic !== 'RIFF') {
      console.log('[NLS] 标记为 WAV 但无 RIFF 头，按 PCM 处理');
      format = 'pcm';
    }
  }

  console.log(`[NLS] 开始识别: format=${format}, size=${audioBuffer.length} bytes`);

  // 构建请求 URL
  const url = `${NLS_ASR_ENDPOINT}?appkey=${NLS_APPKEY}&format=${format}&sample_rate=16000`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-NLS-Token': token,
    },
    // Buffer 转 Blob：Blob 明确属于 fetch BodyInit 联合类型（Buffer<ArrayBufferLike> 不在其内）
    body: new Blob([body.buffer as ArrayBuffer]),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`NLS ASR 请求失败 (${res.status}): ${text.slice(0, 200)}`);
  }

  const result = (await res.json()) as any;

  // 检查识别结果
  if (result.status !== 20000000 && result.status !== undefined) {
    const errMsg = result.message || result.error_message || `状态码: ${result.status}`;
    throw new Error(`语音识别失败: ${errMsg}`);
  }

  const text = result.result || result.text || '';

  if (!text) {
    // 可能是静音或无法识别
    const statusText = result.status_text || '';
    if (statusText && statusText.includes('SILENCE')) {
      return { text: '' };
    }
    console.warn('[NLS] 识别结果为空:', JSON.stringify(result).slice(0, 200));
    return { text: '' };
  }

  console.log(`[NLS] 识别完成: "${text}"`);
  return { text };
}

/**
 * 将常见音频格式转换为 NLS 支持的 PCM 格式说明
 *
 * NLS REST 接口支持的格式（format 参数）:
 *   pcm  — 16kHz 16bit 单声道 PCM（推荐）
 *   wav  — WAV 格式（自动解析头信息）
 *   opus — OPUS 编码
 *   mp3  — MP3 编码
 *   speex— Speex 编码
 *   aac  — AAC 编码
 *   m4a  — M4A 格式
 *
 * 采样率: 默认 16000Hz，可通过 sample_rate 参数指定
 */
