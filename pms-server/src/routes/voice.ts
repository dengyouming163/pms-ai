import { Hono } from 'hono';
import { eq, desc, and } from 'drizzle-orm';
import { db } from '../db/index';
import { pmsBuiVoiceCloneTasks, pmsBuiVoiceProfiles } from '../db/schema/promotion';
import { getTenantScope, tenantWhere } from '../utils/tenant';
import { uploadToOSS } from '../services/aliyun/oss.js';
import { submitVoiceClone } from '../services/aliyun/voice.js';
import * as imsVoice from '../services/aliyun/ims-voice-clone.js';
import { submitPreviewTTS } from '../services/aliyun/ims-tts-preview.js';
import { getMediaJobStatus } from '../services/aliyun/ims.js';
import { recognizeSpeech } from '../services/aliyun/nls.js';
import { serverError } from '../lib/http-error.js';

const route = new Hono();

// ===========================================================================
// IMS 人声克隆（基础版·6步流程 + DB持久化）
// ===========================================================================

// 步骤1: 创建人声克隆任务
route.post('/ims/create', async (c) => {
  const { voiceId, voiceName, gender, scenario } = await c.req.json() as any;
  if (!voiceId || !gender || !scenario) return c.json({ success: false, error: '缺少参数' }, 400);
  try {
    const r = await imsVoice.createVoiceCloneJob({ voiceId, voiceName, gender, scenario });
    const id = 'vc_' + Date.now().toString(36);
    await db.insert(pmsBuiVoiceCloneTasks).values({
      id, voiceId, voiceName: voiceName || voiceId, gender, scenario,
      jobId: r.jobId, currentStep: 1, status: 'created',
    } as any);
    return c.json({ success: true, data: { id, voiceId, jobId: r.jobId } });
  } catch (err: any) { return serverError(c, err, '创建人声克隆任务失败'); }
});

// 步骤2: 获取示范文本（始终使用创建任务时设定的 scenario，防止不匹配）
route.get('/ims/demo', async (c) => {
  const voiceId = c.req.query('voiceId');
  if (!voiceId) return c.json({ success: false, error: '缺少 voiceId' }, 400);
  try {
    // 从数据库读取创建时的 scenario，确保与 IMS 任务一致
    const [task] = await db.select().from(pmsBuiVoiceCloneTasks)
      .where(eq(pmsBuiVoiceCloneTasks.voiceId, voiceId)).limit(1);
    const scenario = (task?.scenario as string) || c.req.query('scenario') || 'story';
    const r = await imsVoice.getDemonstrationForVoiceClone({ scenario });
    // 持久化示范文本
    await db.update(pmsBuiVoiceCloneTasks)
      .set({ demos: r.demonstrations, currentStep: 2, updatedAt: new Date() } as any)
      .where(eq(pmsBuiVoiceCloneTasks.voiceId, voiceId));
    return c.json({ success: true, data: r });
  } catch (err: any) { return serverError(c, err, '获取示范文本失败'); }
});

// 步骤4: 音频检测（含本地预校验）
route.post('/ims/detect', async (c) => {
  const { voiceId, index, audioUrl } = await c.req.json() as any;
  if (!voiceId || index === undefined || !audioUrl) return c.json({ success: false, error: '缺少参数' }, 400);

  // 预校验：音频文件基本合规检查
  try {
    const headRes = await fetch(audioUrl, { method: 'HEAD' });
    if (!headRes.ok) return c.json({ success: false, error: '音频文件不可访问' }, 400);

    const contentLength = parseInt(headRes.headers.get('content-length') || '0');
    if (contentLength > 10 * 1024 * 1024) {
      return c.json({ success: false, error: '文件大小超过 10MB 限制' }, 400);
    }

    // WAV 头解析：校验 RIFF 魔数 + 参数
    const isWav = audioUrl.toLowerCase().endsWith('.wav');
    if (isWav && contentLength > 44) {
      const wavHead = await fetch(audioUrl, {
        headers: { Range: 'bytes=0-43' },
      });
      if (wavHead.ok) {
        const buf = Buffer.from(await wavHead.arrayBuffer());
        const magic = buf.toString('utf8', 0, 4);        // 必须是 "RIFF"
        const waveFmt = buf.toString('utf8', 8, 12);     // 必须是 "WAVE"

        if (magic !== 'RIFF' || waveFmt !== 'WAVE') {
          const hex = buf.slice(0, 16).toString('hex');
          console.error('[ims/detect] 非WAV文件:', magic, hex);
          return c.json({ success: false, error: `音频格式不支持：检测到 ${magic || hex.slice(0,8)} 格式，需 WAV 48000Hz mono 16bit。请使用页面内录音功能` }, 400);
        }

        const sampleRate = buf.readUInt32LE(24);    // offset 24: 采样率
        const channels = buf.readUInt16LE(22);       // offset 22: 声道数
        const bitsPerSample = buf.readUInt16LE(34);  // offset 34: 位深度

        if (sampleRate !== 48000) {
          return c.json({ success: false, error: `采样率需 48000Hz，当前 ${sampleRate}Hz` }, 400);
        }
        if (channels !== 1) {
          return c.json({ success: false, error: `需单声道录音，当前 ${channels} 声道` }, 400);
        }
        console.log('[ims/detect] WAV预检通过:', { sampleRate, channels, bitsPerSample, size: contentLength });
      }
    }
  } catch (e: any) {
    return serverError(c, e, '音频预检失败', 400);
  }

  try {
    // 从 DB 中读取真实 AudioId（Demo 返回的），不要用 index+1 推算
    const [task] = await db.select().from(pmsBuiVoiceCloneTasks)
      .where(eq(pmsBuiVoiceCloneTasks.voiceId, voiceId)).limit(1);
    const demos = (task?.demos || []) as any[];
    const demo = demos[index];
    const audioRecordId = demo?.audioId || (index + 1);  // 优先用真实 AudioId，兜底 index+1

    const r = await imsVoice.detectAudioForVoiceClone({ voiceId, audioRecordId, audioUrl });
    // 持久化录音URL和检测结果
    if (task) {
      const recs = (task.recordings || {}) as Record<string, string>;
      const dets = (task.detectResults || {}) as Record<string, any>;
      recs[String(index)] = audioUrl;
      dets[String(index)] = { passed: r.passed, reason: r.reason, audioRecordId };
      await db.update(pmsBuiVoiceCloneTasks)
        .set({ recordings: recs, detectResults: dets, currentStep: 3, updatedAt: new Date() } as any)
        .where(eq(pmsBuiVoiceCloneTasks.voiceId, voiceId));
    }
    return c.json({ success: true, data: { passed: r.passed, reason: r.reason }, _ims_raw: r._raw });
  } catch (err: any) { return serverError(c, err, '音频检测失败'); }
});

// 步骤5: 提交训练
route.post('/ims/submit', async (c) => {
  const { voiceId } = await c.req.json() as any;
  if (!voiceId) return c.json({ success: false, error: '缺少 voiceId' }, 400);
  try {
    // 前置校验：检查是否所有录音均已通过检测
    const [task] = await db.select().from(pmsBuiVoiceCloneTasks)
      .where(eq(pmsBuiVoiceCloneTasks.voiceId, voiceId)).limit(1);
    if (task) {
      const dets = (task.detectResults || {}) as Record<string, any>;
      const demos = (task.demos || []) as any[];
      const passCount = Object.values(dets).filter((d: any) => d.passed).length;
      const totalNeeded = demos.length || 20;
      if (passCount < totalNeeded) {
        return c.json({
          success: false,
          error: `还有 ${totalNeeded - passCount} 句未通过检测，请先完成全部录制和检测`,
        }, 400);
      }
    }
    const { jobId: trainingJobId } = await imsVoice.submitVoiceCloneJob(voiceId);
    // Submit 返回训练 JobId，存入独立字段，不覆盖 Create 的 JobId（删除时需要 Create JobId）
    await db.update(pmsBuiVoiceCloneTasks)
      .set({ trainingJobId, currentStep: 5, status: 'submitted', updatedAt: new Date() } as any)
      .where(eq(pmsBuiVoiceCloneTasks.voiceId, voiceId));
    return c.json({ success: true, data: { jobId: trainingJobId }, message: '训练已提交' });
  } catch (err: any) { return serverError(c, err, '提交训练失败'); }
});

// 步骤6: 查询训练状态（使用 Submit 返回的 trainingJobId）
route.get('/ims/status', async (c) => {
  const jId = c.req.query('jobId');
  if (!jId) return c.json({ success: false, error: '缺少 jobId' }, 400);
  try {
    // 先查 DB 获取 trainingJobId，如果传的是 Create JobId 则自动转换
    const [task] = await db.select().from(pmsBuiVoiceCloneTasks)
      .where(eq(pmsBuiVoiceCloneTasks.jobId, jId)).limit(1);
    const realJobId = task?.trainingJobId || jId;  // 优先用训练 JobId
    const r = await imsVoice.getVoiceCloneJobStatus(realJobId);
    // 同步状态到DB
    if (task) {
      await db.update(pmsBuiVoiceCloneTasks)
        .set({ status: r.status, updatedAt: new Date() } as any)
        .where(eq(pmsBuiVoiceCloneTasks.id, task.id));
    }
    return c.json({ success: true, data: r });
  } catch (err: any) { return serverError(c, err, '查询训练状态失败'); }
});

// IMS 克隆任务列表（从 DB 读取，含持久化进度）
route.get('/ims/list', async (c) => {
  try {
    const list = await db.select().from(pmsBuiVoiceCloneTasks)
      .orderBy(desc(pmsBuiVoiceCloneTasks.createdAt));
    return c.json({ success: true, data: list });
  } catch (err: any) { return serverError(c, err, '查询克隆任务列表失败'); }
});

// 删除 IMS 克隆任务（DB + 阿里云）
route.post('/ims/delete', async (c) => {
  const { id } = await c.req.json() as any;
  if (!id) return c.json({ success: false, error: '缺少 id' }, 400);
  try {
    const [task] = await db.select().from(pmsBuiVoiceCloneTasks)
      .where(eq(pmsBuiVoiceCloneTasks.id, id)).limit(1);
    if (!task) return c.json({ success: false, error: '任务不存在' }, 404);
    // 调用 IMS 删除阿里云侧音色（DeleteCustomizedVoiceJob 需要 JobId，不是 VoiceId）
    if (task.jobId) {
      try {
        const crypto = await import('crypto');
        const rp: Record<string, string> = {
          Action: 'DeleteCustomizedVoiceJob', Version: '2020-11-09',
          AccessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || '',
          Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
          SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', Format: 'JSON',
          SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
          JobId: task.jobId,
        };
        const sorted = Object.keys(rp).sort()
          .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(rp[k])}`).join('&');
        const sig = crypto.createHmac('sha1', `${process.env.ALIYUN_ACCESS_KEY_SECRET || ''}&`)
          .update(`POST&${encodeURIComponent('/')}&${encodeURIComponent(sorted)}`).digest('base64');
        const body = new URLSearchParams(rp); body.append('Signature', sig);
        await fetch('https://ice.cn-beijing.aliyuncs.com/', {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        });
      } catch {}
    }
    await db.delete(pmsBuiVoiceCloneTasks).where(eq(pmsBuiVoiceCloneTasks.id, id));
    return c.json({ success: true, message: '已删除' });
  } catch (err: any) { return serverError(c, err, '删除克隆任务失败'); }
});

// ===========================================================================
// 手机录音绑定（跨设备同步，生产建议改用 Redis）
// ===========================================================================
const recordingBindings = new Map<string, Record<number, string>>();

// 手机端：录音完成后绑定 URL
route.post('/ims/bind-record', async (c) => {
  const { voiceId, index, audioUrl } = await c.req.json() as any;
  if (!voiceId || index === undefined || !audioUrl) return c.json({ success: false, error: '缺少参数' }, 400);
  if (!recordingBindings.has(voiceId)) recordingBindings.set(voiceId, {});
  recordingBindings.get(voiceId)![index] = audioUrl;
  return c.json({ success: true, message: '绑定成功' });
});

// PC端：轮询获取手机录音
route.get('/ims/recordings', async (c) => {
  const voiceId = c.req.query('voiceId');
  if (!voiceId) return c.json({ success: false, error: '缺少 voiceId' }, 400);
  return c.json({ success: true, data: recordingBindings.get(voiceId) || {} });
});

// H5 免登录上传录音文件
route.post('/ims/upload', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ success: false, error: '缺少文件' }, 400);

    // 读取文件头检测格式
    const buffer = Buffer.from(await file.arrayBuffer());
    const url = await uploadToOSS(buffer, `pms/voice/${Date.now()}_${file.name || 'rec.wav'}`, file.type || 'audio/wav');
    return c.json({ success: true, url });
  } catch (err: any) {
    return serverError(c, err, '上传录音失败');
  }
});

// ===========================================================================
// 门店音色库（供数字人口播 / 一键成片选择音色）
// ===========================================================================

// GET /api/voice/list — 获取门店所有可用音色
route.get('/list', async (c) => {
  const scope = getTenantScope(c);
  const profiles = await db
    .select()
    .from(pmsBuiVoiceProfiles)
    .where(and(...tenantWhere(scope, pmsBuiVoiceProfiles)))
    .orderBy(desc(pmsBuiVoiceProfiles.isDefault), desc(pmsBuiVoiceProfiles.createdAt));
  return c.json({ success: true, data: profiles });
});

// POST /api/voice/library/add — 将 IMS 训练完成的音色添加到门店音色库
route.post('/library/add', async (c) => {
  const scope = getTenantScope(c);
  const { voiceId } = await c.req.json() as any;
  if (!voiceId) return c.json({ success: false, error: '缺少 voiceId' }, 400);

  try {
    // 从 IMS 克隆任务中找到已完成训练的音色
    const [task] = await db.select().from(pmsBuiVoiceCloneTasks)
      .where(eq(pmsBuiVoiceCloneTasks.voiceId, voiceId)).limit(1);
    if (!task) return c.json({ success: false, error: '任务不存在' }, 404);
    if (task.status !== 'Success') return c.json({ success: false, error: '只有训练成功的音色才能入库' }, 400);

    // 检查是否已入库
    const [existing] = await db.select().from(pmsBuiVoiceProfiles)
      .where(and(eq(pmsBuiVoiceProfiles.aliyunVoiceId, voiceId), ...tenantWhere(scope, pmsBuiVoiceProfiles)));
    if (existing) return c.json({ success: false, error: '该音色已在音色库中' }, 400);

    const id = 'vc_' + Date.now().toString(36);
    // 检查门店第一个音色，自动设为默认
    const existingVoices = await db.select().from(pmsBuiVoiceProfiles)
      .where(and(...tenantWhere(scope, pmsBuiVoiceProfiles)));
    const isFirst = existingVoices.length === 0;

    await db.insert(pmsBuiVoiceProfiles).values({
      id,
      merchantId: scope.merchantId,
      storeId: scope.storeId === '*' ? '*' : scope.storeId,
      name: task.voiceName || task.voiceId,
      aliyunVoiceId: task.voiceId,  // IMS VoiceId 作为百炼 TTS 的音色 ID
      status: 'ready',
      isDefault: isFirst,
	      source: 'ims',
    } as any);

    return c.json({ success: true, data: { id, name: task.voiceName || task.voiceId }, message: '已添加到音色库' });
  } catch (err: any) {
    return serverError(c, err, '添加音色到音色库失败');
  }
});

// POST /api/voice/:id/set-default — 设为默认音色
route.post('/:id/set-default', async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id');

  const [profile] = await db.select().from(pmsBuiVoiceProfiles)
    .where(and(eq(pmsBuiVoiceProfiles.id, id), ...tenantWhere(scope, pmsBuiVoiceProfiles)));
  if (!profile) return c.json({ success: false, error: '音色不存在' }, 404);

  // 将该门店其他音色取消默认
  await db.update(pmsBuiVoiceProfiles)
    .set({ isDefault: false, updatedAt: new Date() } as any)
    .where(and(...tenantWhere(scope, pmsBuiVoiceProfiles)));

  // 设当前为默认
  await db.update(pmsBuiVoiceProfiles)
    .set({ isDefault: true, updatedAt: new Date() } as any)
    .where(eq(pmsBuiVoiceProfiles.id, id));

  return c.json({ success: true, message: `"${profile.name}" 已设为默认音色` });
});

// ===========================================================================
// ICE AI_TTS 音色试听预览（纯音频，无视频轨）
// ===========================================================================

// POST /api/voice/preview — 提交 TTS 试听任务
route.post('/preview', async (c) => {
  const { voiceId, text } = await c.req.json() as any;
  if (!voiceId || !text) return c.json({ success: false, error: '缺少 voiceId 或 text' }, 400);
  if (text.length > 500) return c.json({ success: false, error: '文案不超过500字' }, 400);

  try {
    const { jobId } = await submitPreviewTTS({ voiceId, text });
    return c.json({ success: true, data: { jobId, status: 'processing' } });
  } catch (err: any) {
    return serverError(c, err, '提交试听任务失败');
  }
});

// GET /api/voice/preview-status — 查询 TTS 试听结果
route.get('/preview-status', async (c) => {
  const jobId = c.req.query('jobId');
  if (!jobId) return c.json({ success: false, error: '缺少 jobId' }, 400);

  try {
    const { status, outputUrl } = await getMediaJobStatus(jobId);
    return c.json({ success: true, data: { status, audioUrl: outputUrl || null } });
  } catch (err: any) {
    return serverError(c, err, '查询试听结果失败');
  }
});


// ===========================================================================
// 百炼声音复刻（即时完成，上传3-30秒音频 → 即刻得到音色）
// ===========================================================================

// POST /api/voice/create — 百炼声音复刻
route.post('/create', async (c) => {
  const scope = getTenantScope(c);
  const { name, sampleUrl } = await c.req.json() as any;
  if (!name || !sampleUrl) return c.json({ success: false, error: '缺少音色名称或音频文件' }, 400);

  try {
    const prefix = name.replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'pms';
    const { voiceId } = await submitVoiceClone(sampleUrl, prefix, ['zh']);

    const id = 'vc_' + Date.now().toString(36);
    const existing = await db.select().from(pmsBuiVoiceProfiles)
      .where(and(...tenantWhere(scope, pmsBuiVoiceProfiles)));
    const isFirst = existing.length === 0;

    await db.insert(pmsBuiVoiceProfiles).values({
      id, merchantId: scope.merchantId,
      storeId: scope.storeId === '*' ? '*' : scope.storeId,
      name, aliyunVoiceId: voiceId, status: 'ready',
      sampleUrl, isDefault: isFirst, source: 'bailian',
    } as any);

    return c.json({ success: true, data: { id, voiceId, name, isDefault: isFirst }, message: '声音复刻完成' });
  } catch (err: any) {
    return serverError(c, err, '声音复刻失败');
  }
});

// POST /api/voice/tts — 百炼 TTS 试听（用指定音色合成语音）
route.post('/tts', async (c) => {
  const { voiceId, text } = await c.req.json() as any;
  if (!voiceId || !text) return c.json({ success: false, error: '缺少参数' }, 400);

  try {
    const { synthesizeSpeech } = await import('../services/aliyun/voice.js');
    const audioBuffer = await synthesizeSpeech(text, voiceId, 1.0, 50);
    const url = await uploadToOSS(audioBuffer, `pms/tts/preview_${Date.now()}.mp3`, 'audio/mpeg');
    return c.json({ success: true, data: { audioUrl: url } });
  } catch (err: any) {
    return serverError(c, err, 'TTS 合成失败');
  }
});

// ===========================================================================
// NLS 语音识别（ASR）
// ===========================================================================

// POST /api/voice/asr — 语音转文字（阿里云 NLS 一句话识别）
route.post('/asr', async (c) => {
  try {
    const formData = await c.req.formData();
    const file = formData.get('file') as File;
    if (!file) return c.json({ success: false, error: '缺少音频文件' }, 400);

    // 限制文件大小（最大 10MB）
    if (file.size > 10 * 1024 * 1024) {
      return c.json({ success: false, error: '音频文件不能超过 10MB' }, 400);
    }

    const buffer = Buffer.from(await file.arrayBuffer());
    const mimeType = file.type || 'audio/pcm';

    const { text } = await recognizeSpeech(buffer, mimeType);
    return c.json({ success: true, text });
  } catch (err: any) {
    return serverError(c, err, '语音识别失败');
  }
});

// ===========================================================================
// POST /api/voice/read — TTS 朗读（复用百炼TTS，默认音色 longanyang）
route.post('/read', async (c) => {
  const { text } = await c.req.json() as any;
  if (!text) return c.json({ success: false, error: '缺少文本内容' }, 400);
  try {
    const { synthesizeSpeech } = await import('../services/aliyun/voice.js');
    const audioBuffer = await synthesizeSpeech(text, 'longxing_v3', 1.0, 50);
    const { uploadToOSS } = await import('../services/aliyun/oss.js');
    const url = await uploadToOSS(audioBuffer, `pms/tts/read_${Date.now()}.mp3`, 'audio/mpeg');
    return c.json({ success: true, audioUrl: url });
  } catch (err: any) {
    return serverError(c, err, 'TTS 合成失败');
  }
});

export default route;
