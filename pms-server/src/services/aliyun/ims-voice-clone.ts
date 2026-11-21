/**
 * 阿里云 IMS 人声克隆（基础版）—— 6 步流程
 *
 * API 文档: https://help.aliyun.com/zh/ims/developer-reference/api-ice-2020-11-09-createcustomizedvoicejob
 *
 * 基础版 60元/次，录 20 句指定文案，娱乐级效果
 */

import crypto from 'crypto';

const IMS_ENDPOINT = 'https://ice.cn-beijing.aliyuncs.com';
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

async function imsGet(params: Record<string, string>): Promise<any> {
  const sig = sign('GET', params);
  const up = new URLSearchParams({ ...params, Signature: sig });
  const res = await fetch(`${IMS_ENDPOINT}/?${up}`, { method: 'GET' });
  return res.json();
}

async function imsPost(params: Record<string, string>): Promise<any> {
  const sig = sign('POST', params);
  const bodyStr = Object.keys(params).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`).join('&') + `&Signature=${encodeURIComponent(sig)}`;
  const res = await fetch(IMS_ENDPOINT, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bodyStr });
  return res.json();
}

// ====== 步骤1: 创建人声克隆任务 ======
export async function createVoiceCloneJob(params: {
  voiceId: string;   // 自定义 VoiceId（英文/拼音，≤32字）
  voiceName?: string; // 中文名
  gender: 'female' | 'male';
  scenario: 'story' | 'interaction' | 'navigation';
}): Promise<{ jobId: string }> {
  const rp = {
    ...baseParams('CreateCustomizedVoiceJob'),
    VoiceId: params.voiceId,
    VoiceName: params.voiceName || params.voiceId,
    Gender: params.gender,
    Scenario: params.scenario,
  };
  const data = await imsPost(rp);
  if (!data.Success) throw new Error(`创建克隆任务失败: ${JSON.stringify(data)}`);
  return { jobId: data.Data?.JobId || '' };
}

// ====== 步骤2: 获取示范文本 ======
// API 只需 Scenario，不需要 VoiceId；返回的 AudioId 要传给 Detect
export async function getDemonstrationForVoiceClone(params: {
  scenario: string;
}): Promise<{ demonstrations: Array<{ text: string; audioId: number; audioUrl?: string }> }> {
  const rp = {
    ...baseParams('GetDemonstrationForCustomizedVoiceJob'),
    Scenario: params.scenario,
  };
  const data = await imsGet(rp);
  if (!data.Success) throw new Error(`获取示范文本失败: ${JSON.stringify(data)}`);
  const demos = data.Data?.DemonstrationList || [];
  return {
    demonstrations: demos.map((d: any) => ({
      text: d.Text || '',
      audioId: d.AudioId || 0,   // 此 ID 要原样传给 Detect 的 AudioRecordId
      audioUrl: d.DemoAudio || d.AudioUrl || undefined,
    })),
  };
}

// ====== 步骤4: 音频检测 ======
// AudioRecordId 是整数序号(1-20)，不是 MediaId！
// RecordUrl 必须是 OSS 地址，wav/pcm 格式，48000Hz 单声道 16bit
export async function detectAudioForVoiceClone(params: {
  voiceId: string;
  audioRecordId: number;  // 使用 Demo 返回的真实 AudioId (1-20)
  audioUrl: string;
}): Promise<{ passed: boolean; reason?: string; _raw?: unknown }> {
  const rp = {
    ...baseParams('DetectAudioForCustomizedVoiceJob'),
    VoiceId: params.voiceId,
    RecordUrl: params.audioUrl,
    AudioRecordId: String(params.audioRecordId),
  };
  const data = await imsPost(rp);
  if (!data.Success) throw new Error(`音频检测失败: ${JSON.stringify(data)}`);
  return {
    passed: data.Data?.Pass ?? data.Data?.Passed ?? false,
    reason: data.Data?.Reason || undefined,
    _raw: data, // 返回阿里云原始响应
  };
}

// ====== 步骤5: 提交训练 ======
// SubmitCustomizedVoiceJob 返回的 JobId 才是训练任务 ID，与 Create 的 JobId 不同！
export async function submitVoiceCloneJob(voiceId: string): Promise<{ jobId: string }> {
  const rp = {
    ...baseParams('SubmitCustomizedVoiceJob'),
    VoiceId: voiceId,
  };
  const data = await imsPost(rp);
  if (!data.Success) throw new Error(`提交训练失败: ${JSON.stringify(data)}`);
  return { jobId: data.Data?.JobId || '' };
}

// ====== 步骤6: 查询任务状态 ======
export async function getVoiceCloneJobStatus(jobId: string): Promise<{
  status: string;
  voiceId?: string;
  message?: string;
}> {
  const rp = {
    ...baseParams('GetCustomizedVoiceJob'),
    JobId: jobId,
  };
  const data = await imsGet(rp);
  // IMS 返回 Data.CustomizedVoiceJob.{Status, VoiceId, Message, ...}
  const job = data.Data?.CustomizedVoiceJob || data.Data || {};
  return {
    status: job.Status || 'Initialization',
    voiceId: job.VoiceId || undefined,
    message: job.Message || undefined,
  };
}

// ====== 列出所有 IMS 克隆音色 ======
export async function listCustomizedVoices(): Promise<Array<{
  voiceId: string; voiceName: string; gender: string; type: string;
}>> {
  const rp = {
    ...baseParams('ListCustomizedVoices'),
    Type: 'Basic',
  };
  const data = await imsGet(rp);
  const list = data.Data?.CustomizedVoiceList || [];
  return list.map((v: any) => ({
    voiceId: v.VoiceId || '',
    voiceName: v.VoiceName || '',
    gender: v.Gender || '',
    type: v.Type || 'Basic',
  }));
}
