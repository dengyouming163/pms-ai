/**
 * IMS AI_TTS 仅音频预览 — 用于音色试听
 * 使用 SubmitMediaProducingJob + AudioTrack(AI_TTS)，无视频轨
 */
import crypto from 'crypto';

const OSS_REGION = process.env.OSS_REGION || 'oss-cn-beijing';
const IMS_REGION = OSS_REGION.startsWith('oss-') ? OSS_REGION.replace('oss-', '') : OSS_REGION;
const IMS_ENDPOINT = `https://ice.${IMS_REGION}.aliyuncs.com`;
const ACCESS_KEY = process.env.ALIYUN_ACCESS_KEY_ID || '';
const SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || '';

function sign(method: string, params: Record<string, string>): string {
  const sortedKeys = Object.keys(params).sort();
  const query = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&');
  const signStr = `${method}&${encodeURIComponent('/')}&${encodeURIComponent(query)}`;
  return crypto.createHmac('sha1', `${SECRET}&`).update(signStr).digest('base64');
}

function baseParams(action: string): Record<string, string> {
  return {
    Action: action, Version: '2020-11-09', AccessKeyId: ACCESS_KEY,
    Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
    SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', Format: 'JSON',
    SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
  };
}

/** 提交 TTS 预览任务（ICE AI_TTS 仅音频轨） */
export async function submitPreviewTTS(params: {
  voiceId: string;
  text: string;
}): Promise<{ jobId: string }> {
  const bucket = process.env.OSS_BUCKET || 'pms-media';
  const outputKey = `pms/tts/preview_${Date.now()}.mp3`;

  const timeline: any = {
    AudioTracks: [{
      AudioTrackClips: [{
        Type: 'AI_TTS',
        Content: params.text,
        Voice: params.voiceId,
      }],
    }],
  };

  const rp = {
    ...baseParams('SubmitMediaProducingJob'),
    ProjectMetadata: JSON.stringify({ Title: 'PMS音色试听', Description: '智宿管家' }),
    Timeline: JSON.stringify(timeline),
    OutputMediaConfig: JSON.stringify({
      MediaURL: `https://${bucket}.${OSS_REGION}.aliyuncs.com/${outputKey}`,
    }),
    TemplateId: 'Custom',
  };

  const sig = sign('GET', rp);
  const up = new URLSearchParams({ ...rp, Signature: sig });
  const res = await fetch(`${IMS_ENDPOINT}/?${up}`, { method: 'GET' });
  const data = (await res.json()) as any;
  const jobId = data.JobId || '';

  if (!jobId) throw new Error(`ICE TTS预览提交失败: ${JSON.stringify(data)}`);
  console.log('[IMS/TTSPreview] 任务已提交:', jobId);
  return { jobId };
}
