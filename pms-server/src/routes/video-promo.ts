import { Hono } from 'hono';
import { eq, desc, or } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiVideoTasks, pmsBuiCreationRecords, pmsBuiBatchJobs, pmsBuiImsTemplates } from '../db/schema/promotion.js';
import { submitFastCut, getMediaJobStatus, submitBatchJob, getBatchJobStatus, submitFastCutV2, submitSmartMix, submitSubtitleOverlay } from '../services/aliyun/ims.js';
import { AGENT_API_URL, INTERNAL_SERVICE_TOKEN } from '../constants.js';
import { submitVideoRetalkDashScope, getVideoRetalkDashScope, synthesizeSpeech } from '../services/aliyun/voice.js';
import { uploadToOSS } from '../services/aliyun/oss.js';
import { buildBgmUrlOrNull } from '../services/bgm-library.js';
import { serverError } from '../lib/http-error.js';

const route = new Hono();

// IMS 系统内置音色（可用 AI_TTS 直连，无需预合成）
const IMS_SYSTEM_VOICES = new Set([
  'zhichu', 'zhitian', 'zhixiang',
  'longhua_v3', 'longwan_v3', 'longxiaochun_v3',
  'longyan_v3', 'longxing_v3', 'longanxuan_v3',
  'longfeifei_v3', 'longjing_v3', 'longhuhu_v3', 'loongbella_v3',
]);

// POST /api/video/fastcut-v2 — 快剪 V2 (Timeline + 音频 + 字幕)
route.post('/fastcut-v2', async (c) => {
  const body = await c.req.json();
  const { voiceId, script, subtitleText, title, groupMedia, transition, imageDuration,
    showSubtitle, subtitlePos, subFontSize, subFont, subFontColor,
    subOutline, subOutlineColour, subEffectStyle, subEffects, subBubble, orientation,
    showTitle, titleText, bgmStyle, bgmVolume, voiceVolume } = body as any;
  if (!voiceId || !script || !groupMedia?.length) {
    return c.json({ success: false, error: '缺少必要参数' }, 400);
  }
  try {
    const bucket = process.env.OSS_BUCKET || 'pms-zhisu';
    const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';

    // 自定义音色 → 百炼 TTS 预合成音频
    let audioUrl: string | undefined;
    if (!IMS_SYSTEM_VOICES.has(voiceId)) {
      console.log('[fastcut-v2] 自定义音色，预合成 TTS...', voiceId);
      const audioBuffer = await synthesizeSpeech(script, voiceId);
      audioUrl = await uploadToOSS(audioBuffer, `pms/tts/fastcut_${Date.now()}.mp3`, 'audio/mpeg');
      console.log('[fastcut-v2] TTS 预合成完成:', audioUrl);
    }

    const bgmUrl = buildBgmUrlOrNull(bgmStyle) ?? undefined;

    const { jobId } = await submitFastCutV2({
      voiceId, script, subtitleText, title: title || '快剪视频',
      groupMedia,
      outputBucket: `https://${bucket}.${ossRegion}.aliyuncs.com`,
      transition, imageDuration,
      showSubtitle: true, subtitlePos, subFontSize, subFont, subFontColor,
      subOutline, subOutlineColour,
      subEffectStyle, subEffects, subBubble, orientation,
      audioUrl,
      showTitle: false, titleText: titleText || title,
      bgmUrl, bgmVolume: bgmVolume ?? 0.05,
    });
    const id = `fc2_${Date.now()}`;
    await db.insert(pmsBuiVideoTasks).values({
      id, merchantId: 'default', type: 'fastcut', status: 'processing',
      aliyunTaskId: jobId,
      inputParams: { voiceId, script: script?.slice(0, 80), groupMedia, orientation, customVoice: !!audioUrl },
    } as any);
    return c.json({ success: true, data: { id, jobId, status: 'processing', customVoice: !!audioUrl } });
  } catch (err: any) {
    return serverError(c, err, '快剪提交失败');
  }
});

// POST /api/video/fastcut — 提交快剪任务
route.post('/fastcut', async (c) => {
  const body = await c.req.json();
  const { images, audioUrl, subtitles, outputKey, asrText, ttsText, ttsVoice,
    transition, subtitleY, subtitleAlign, filter,
    subFont, subFontSize, subEffectStyle } = body as {
    images: string[];
    audioUrl?: string;
    subtitles?: Array<{ text: string; start: number; end: number }>;
    outputKey?: string;
    asrText?: string;
    ttsText?: string;
    ttsVoice?: string;
    transition?: string;
    subtitleY?: number;
    subtitleAlign?: string;
    filter?: string;
    subFont?: string;
    subFontSize?: number;
    subEffectStyle?: string;
  };

  if (!images?.length) {
    return c.json({ success: false, error: '素材图片不能为空' }, 400);
  }
  if (!audioUrl && !ttsText) {
    return c.json({ success: false, error: '音频URL或配音文案不能为空' }, 400);
  }

  try {
    const bucket = process.env.OSS_BUCKET || 'pms-zhisu';
    const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';
    const { taskId } = await submitFastCut({
      images,
      audioUrl,
      subtitles: subtitles || [],
      asrText,
      ttsText,
      ttsVoice,
      transition,
      subtitleY,
      subtitleAlign,
      filter,
      subFont,
      subFontSize,
      subEffectStyle,
      outputBucket: `https://${bucket}.${ossRegion}.aliyuncs.com`,
      outputKey: outputKey || `fastcut/out_${Date.now()}.mp4`,
    });

    const id = `fc_${Date.now()}`;
    await db.insert(pmsBuiVideoTasks).values({
      id,
      merchantId: 'default',
      type: 'fastcut',
      status: 'processing',
      aliyunTaskId: taskId,
      inputParams: { images, audioUrl, subtitles, asrText: asrText || null, ttsText: ttsText || null, transition, subtitleY, subtitleAlign, filter, subFont, subFontSize, subEffectStyle },
    } as any);

    return c.json({
      success: true,
      data: { id, taskId, status: 'processing' },
      message: '快剪任务已提交，预计 1-3 分钟完成',
    });
  } catch (err: any) {
    return serverError(c, err, '快剪任务提交失败');
  }
});

// POST /api/video/optimize-script — AI 优化口播文案为数字人口播风格
route.post('/optimize-script', async (c) => {
  const body = await c.req.json();
  const { script } = body as { script: string };

  if (!script || script.trim().length === 0) {
    return c.json({ success: false, error: '文案不能为空' }, 400);
  }

  try {
    const prompt = `任务：将以下口播文案改得更口语化。直接输出改写结果，不要寒暄、不要解释、不要加任何前缀后缀。

改写规则：
- 加入"来"、"你看"、"我跟你说"等口语词
- 用换行做自然停顿
- 保持原意和长度不变

原文：
${script}`;

    const res = await fetch(`${AGENT_API_URL}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN || '',
      },
      body: JSON.stringify({ message: prompt, history: [] }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(`AI 服务异常 (${res.status}): ${errText.slice(0, 200)}`);
    }

    const reader = res.body?.getReader();
    if (!reader) throw new Error('AI 服务无响应数据');

    const decoder = new TextDecoder();
    let fullText = '';
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() || '';
      for (const line of lines) {
        if (line.startsWith('data: ')) {
          try {
            const d = JSON.parse(line.slice(6));
            if (d.text) fullText += d.text;
            if (d.summary) fullText = d.summary;
          } catch {}
        }
      }
    }

    if (!fullText.trim()) throw new Error('AI 未返回有效文案');

    // 提取纯口播文案——从 AI 完整方案中摘出改写后的口播部分
    let optimized = fullText.trim();
    // 移除 AI 寒暄前缀："好的老板..." "咱直接上干货..."
    optimized = optimized.replace(/^好的[，,].+?[。！\n]/, '').replace(/^咱直接上干货[，,].+?[。！\n]/, '').trim();
    // 移除开头的 ---
    optimized = optimized.replace(/^---+\s*\n*/, '').trim();

    // 尝试从结构化段落中提取口播文案（匹配各种变体）
    const patterns = [
      /(?:口播脚本|口播文案|优化后[的]?数字人口播|数字人口播脚本).*?\n([\s\S]*?)(?=\n##\s|\n---\s|\n#+\s|\n[一二三四五六七八九十][、.)]|\n\d[）)])/,
      /##\s*\d[）)]\s*口播[^\n]*\n([\s\S]*?)(?=\n##\s|\n---\s|\n#+\s)/,
    ];
    for (const re of patterns) {
      const m = optimized.match(re);
      if (m?.[1]?.trim()) {
        optimized = m[1].trim();
        break;
      }
    }

    console.log('[optimize-script] 提取口播文案, 长度:', optimized.length);
    return c.json({ success: true, data: { optimizedScript: optimized } });
  } catch (err: any) {
    return serverError(c, err, '文案优化失败');
  }
});

// POST /api/video/digital-human/tts — 仅 TTS 合成，返回音频 URL（不创建任务）
route.post('/digital-human/tts', async (c) => {
  const { script, voiceId, speechRate } = await c.req.json() as any;
  if (!script || !voiceId) return c.json({ success: false, error: '缺少文案或音色' }, 400);
  try {
    const audioBuffer = await synthesizeSpeech(script, voiceId, speechRate || 1.0, 50);
    const audioUrl = await uploadToOSS(audioBuffer, `pms/tts/dh_${Date.now()}.mp3`, 'audio/mpeg');
    return c.json({ success: true, data: { audioUrl } });
  } catch (err: any) {
    return serverError(c, err, 'TTS 合成失败');
  }
});

// POST /api/video/digital-human — 数字人口播（仅 VideoRetalk，音频已在步骤1生成）
route.post('/digital-human', async (c) => {
  const body = await c.req.json();
  const {
    videoUrl,          // 人物视频 URL（必填）
    audioUrl,          // 音频 URL（必填，已在步骤1通过 /tts 生成）
    refImageUrl,       // 人物参考图（可选）
    addSubtitle,       // 是否叠加字幕
    subtitleConfig,    // 字幕配置
    title,             // 方案标题
    script,            // 口播文案（用于字幕合成）
  } = body as any;

  if (!videoUrl || !audioUrl) return c.json({ success: false, error: '请上传视频和音频' }, 400);

  const id = `dh_${Date.now()}`;

  try {
    // 提交 VideoRetalk
    console.log('[digital-human] 提交 VideoRetalk...');
    const { taskId } = await submitVideoRetalkDashScope(
      videoUrl,
      audioUrl,
      refImageUrl || undefined,
    );

    // 保存任务
    await db.insert(pmsBuiVideoTasks).values({
      id, merchantId: 'default', type: 'digital_human', status: 'processing',
      aliyunTaskId: taskId,
      inputParams: { title: title?.slice(0, 60), script: script?.slice(0, 200), videoUrl },
      pipeline: {
        stage: 'videoretalk',
        videoretalkTaskId: taskId,
        audioUrl,
        videoUrl,
        addSubtitle: addSubtitle || false,
        subtitleConfig: subtitleConfig || {},
        script: script?.slice(0, 1000),
      },
    } as any);

    return c.json({
      success: true,
      data: { id, taskId, status: 'processing' },
      message: 'VideoRetalk 处理中',
    });
  } catch (err: any) {
    await db.insert(pmsBuiVideoTasks).values({
      id, merchantId: 'default', type: 'digital_human', status: 'failed',
      errorMessage: err.message,
      inputParams: { script: script?.slice(0, 200), videoUrl },
    } as any);
    return serverError(c, err, '提交失败');
  }
});

// GET /api/video/tasks — 视频任务列表
route.get('/tasks', async (c) => {
  const type = c.req.query('type');
  const query = type
    ? eq(pmsBuiVideoTasks.type, type)
    : undefined;

  const list = query
    ? await db.select().from(pmsBuiVideoTasks).where(query).orderBy(desc(pmsBuiVideoTasks.createdAt)).limit(20)
    : await db.select().from(pmsBuiVideoTasks).orderBy(desc(pmsBuiVideoTasks.createdAt)).limit(20);
  return c.json({ success: true, data: list });
});

// GET /api/video/tasks/batch?ids=id1,id2,... — 批量查询（含阿里云状态刷新）
route.get('/tasks/batch', async (c) => {
  const idsParam = c.req.query('ids');
  if (!idsParam) return c.json({ success: false, error: '缺少 ids 参数' }, 400);

  const ids = idsParam.split(',').map((id) => id.trim()).filter(Boolean);
  if (ids.length === 0 || ids.length > 50) {
    return c.json({ success: false, error: 'ids 数量应在 1-50 之间' }, 400);
  }

  try {
    const tasks = await db
      .select()
      .from(pmsBuiVideoTasks)
      .where(or(...ids.map((id) => eq(pmsBuiVideoTasks.id, id))))
      .limit(50);

    // 对仍处理中的任务，查询阿里云最新状态
    const resultMap: Record<string, any> = {};
    for (const t of tasks) {
      let status = t.status || 'processing';
      let outputUrl = t.outputUrl || null;

      if (status === 'processing' && t.aliyunTaskId) {
        try {
          const fresh = await getMediaJobStatus(t.aliyunTaskId);
          if (fresh.status !== 'processing') {
            status = fresh.status;
            outputUrl = fresh.outputUrl || outputUrl;
            // 更新数据库
            await db.update(pmsBuiVideoTasks)
              .set({ status, ...(outputUrl ? { outputUrl } : {}), updatedAt: new Date() } as any)
              .where(eq(pmsBuiVideoTasks.id, t.id));
            // 同步创作记录
            if (outputUrl) {
              await db.update(pmsBuiCreationRecords)
                .set({ taskStatus: status, audioUrl: outputUrl, updatedAt: new Date() } as any)
                .where(or(eq(pmsBuiCreationRecords.taskId, t.id), eq(pmsBuiCreationRecords.audioUrl, t.id)));
            }
          }
        } catch (e: any) {
          console.error(`[video/tasks/batch] 刷新 ${t.id} 失败:`, e.message);
        }
      }

      resultMap[t.id] = { id: t.id, status, outputUrl, error: t.errorMessage || null };
    }

    return c.json({ success: true, data: resultMap });
  } catch (err: any) {
    console.error('[video/tasks/batch] 查询失败:', err.message);
    return c.json({ success: false, error: '批量查询失败' }, 500);
  }
});

// GET /api/video/tasks/:id — 查询单个任务状态（含 pipeline 自动推进）
route.get('/tasks/:id', async (c) => {
  const id = c.req.param('id');
  const [task] = await db
    .select()
    .from(pmsBuiVideoTasks)
    .where(eq(pmsBuiVideoTasks.id, id));
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);

  const pipeline = (task as any).pipeline || {};

  // 数字人口播管线：VideoRetalk → ICE 字幕
  if (task.type === 'digital_human' && task.status === 'processing') {
    try {
      if (pipeline.stage === 'videoretalk' && pipeline.videoretalkTaskId) {
        // 查询 VideoRetalk 状态
        const vrResult = await getVideoRetalkDashScope(pipeline.videoretalkTaskId);

        if (vrResult.status === 'completed' && vrResult.outputUrl) {
          console.log('[digital-human] VideoRetalk 完成');

          // 备份输出到 OSS（官方 URL 24h 后过期）
          let backupUrl = vrResult.outputUrl;
          try {
            const videoRes = await fetch(vrResult.outputUrl);
            if (videoRes.ok) {
              const videoBuffer = Buffer.from(await videoRes.arrayBuffer());
              backupUrl = await uploadToOSS(videoBuffer, `pms/dh/backup_${id}.mp4`, 'video/mp4');
              console.log('[digital-human] 输出已备份到 OSS:', backupUrl);
            }
          } catch (e: any) {
            console.error('[digital-human] OSS备份失败:', e.message);
          }

          // 如果开启了字幕，触发 ICE
          if (pipeline.addSubtitle) {
            console.log('[digital-human] 触发 ICE 字幕...');
            const subConfig = pipeline.subtitleConfig || {};
            const outputKey = `pms/dh/final_${id}.mp4`;
            const { jobId: iceJobId } = await submitSubtitleOverlay({
              videoUrl: backupUrl,
              scriptText: (task as any).inputParams?.optimizedScript || '',
              outputKey,
              subtitleConfig: subConfig,
            });

            // 更新 pipeline 到下一阶段
            const newPipeline = {
              ...pipeline,
              stage: 'subtitle',
              videoretalkResultUrl: backupUrl,
              subtitleJobId: iceJobId,
            };
            await db.update(pmsBuiVideoTasks)
              .set({ pipeline: newPipeline, updatedAt: new Date() } as any)
              .where(eq(pmsBuiVideoTasks.id, id));

            pipeline.stage = 'subtitle';
            pipeline.videoretalkResultUrl = backupUrl;
            pipeline.subtitleJobId = iceJobId;
          } else {
            // 无字幕 → 直接完成（使用 OSS 备份 URL）
            await db.update(pmsBuiVideoTasks)
              .set({ status: 'completed', outputUrl: backupUrl, pipeline: { ...pipeline, stage: 'done' }, updatedAt: new Date() } as any)
              .where(eq(pmsBuiVideoTasks.id, id));
            // 同步创作记录
            await db.update(pmsBuiCreationRecords)
              .set({ taskStatus: 'completed', audioUrl: backupUrl, updatedAt: new Date() } as any)
              .where(or(eq(pmsBuiCreationRecords.taskId, id), eq(pmsBuiCreationRecords.audioUrl, id)));
            return c.json({ success: true, data: { ...task, status: 'completed', outputUrl: backupUrl, pipeline: { ...pipeline, stage: 'done' } } });
          }
        } else if (vrResult.status === 'failed') {
          await db.update(pmsBuiVideoTasks)
            .set({ status: 'failed', errorMessage: 'VideoRetalk 处理失败', updatedAt: new Date() } as any)
            .where(eq(pmsBuiVideoTasks.id, id));
          return c.json({ success: true, data: { ...task, status: 'failed', pipeline } });
        }
      }

      if (pipeline.stage === 'subtitle' && pipeline.subtitleJobId) {
        // 查询 ICE 字幕合成状态
        const iceResult = await getMediaJobStatus(pipeline.subtitleJobId);

        if (iceResult.status === 'completed' && iceResult.outputUrl) {
          // 全部完成！
          await db.update(pmsBuiVideoTasks)
            .set({
              status: 'completed',
              outputUrl: iceResult.outputUrl,
              pipeline: { ...pipeline, stage: 'done' },
              updatedAt: new Date(),
            } as any)
            .where(eq(pmsBuiVideoTasks.id, id));

          // 同步更新创作记录
          await db.update(pmsBuiCreationRecords)
            .set({ taskStatus: 'completed', audioUrl: iceResult.outputUrl, updatedAt: new Date() } as any)
            .where(or(eq(pmsBuiCreationRecords.taskId, id), eq(pmsBuiCreationRecords.audioUrl, id)));

          return c.json({
            success: true,
            data: { ...task, status: 'completed', outputUrl: iceResult.outputUrl, pipeline: { ...pipeline, stage: 'done' } },
          });
        } else if (iceResult.status === 'failed') {
          await db.update(pmsBuiVideoTasks)
            .set({
              status: 'failed',
              errorMessage: 'ICE 字幕合成失败（VideoRetalk 视频已保留）',
              outputUrl: pipeline.videoretalkResultUrl,  // 保留中间结果
              updatedAt: new Date(),
            } as any)
            .where(eq(pmsBuiVideoTasks.id, id));
          return c.json({
            success: true,
            data: { ...task, status: 'failed', outputUrl: pipeline.videoretalkResultUrl, pipeline },
          });
        }
      }
    } catch (e: any) {
      console.error(`[video/tasks/${id}] pipeline 推进失败:`, e.message);
      // 记录错误到 DB，避免静默失败
      try {
        await db.update(pmsBuiVideoTasks)
          .set({ status: 'failed', errorMessage: `处理异常: ${e.message}`, updatedAt: new Date() } as any)
          .where(eq(pmsBuiVideoTasks.id, id));
      } catch {}
    }
  }

  // 通用处理：非 digital_human 或旧格式 fastcut 任务
  if (task.status === 'processing' && task.aliyunTaskId && task.type !== 'digital_human') {
    try {
      const { status, outputUrl } = await getMediaJobStatus(task.aliyunTaskId);
      await db.update(pmsBuiVideoTasks)
        .set({ status, ...(outputUrl ? { outputUrl } : {}), updatedAt: new Date() } as any)
        .where(eq(pmsBuiVideoTasks.id, id));
      // 同步创作记录
      const updates: Record<string, any> = { taskStatus: status, updatedAt: new Date() };
      if (outputUrl) updates.audioUrl = outputUrl;
      await db.update(pmsBuiCreationRecords)
        .set(updates as any)
        .where(or(eq(pmsBuiCreationRecords.taskId, id), eq(pmsBuiCreationRecords.audioUrl, id)));
      return c.json({ success: true, data: { ...task, status, outputUrl: outputUrl || task.outputUrl } });
    } catch (e: any) {
      console.error(`[video/tasks/${id}] 刷新阿里云状态失败:`, e.message);
    }
  }

  return c.json({ success: true, data: { ...task, pipeline } });
});

// ========== 批量一键成片 ==========

// POST /api/video/batch-optimize — AI智能优化成片方案（基于公共参数文档）
route.post('/batch-optimize', async (c) => {
  const body = await c.req.json();
  const { script, title, mediaCounts } = body as {
    script: string; title?: string;
    mediaCounts: Array<{ step: number; desc: string; count: number; hasVideo: boolean }>;
  };
  if (!script) return c.json({ success: false, error: '缺少口播文案' }, 400);

  try {
    const totalMedia = mediaCounts.reduce((s, m) => s + m.count, 0);
    const hasVideo = mediaCounts.some(m => m.hasVideo);
    const suggestion = `${totalMedia}个素材${hasVideo ? '（含视频）' : '（纯图片）'}，口播约${script.length}字。`;

    const res = await fetch(`${AGENT_API_URL}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN || '' },
      body: JSON.stringify({
        message: `你是阿里云ICE一键成片参数优化专家。请根据以下信息输出最优配置JSON（只输出JSON，不要其他内容）：

【素材情况】${suggestion}
【标题】${title || '一键成片'}
【口播文案片段】${script.slice(0, 300)}

输出JSON对象，包含以下所有字段：
- speechTexts: 口播文案数组（3个SSML优化变体），用<break time="300ms"/>等标签增强节奏，每条≤1000字
- titles: 标题数组（5个变体，12-30字，吸引眼球）
- bgmStyle: 背景音乐风格，从 bgm-relaxing/bgm-dynamic/bgm-beauty/bgm-chinese-style/bgm-cuisine/bgm-romantic/bgm-upbeat/bgm-quirky 中选1个最合适的
- bgStyle: 背景风格，pure(纯色)/gradient(渐变)/image(图片) 选1个
- bgmVolume: BGM音量，0-1，推荐0.2
- imageDuration: 图片时长秒数，${hasVideo ? '3' : totalMedia <= 5 ? '5' : '4'}
- transition: 是否转场，true
- showTitle: 是否显示标题，${totalMedia >= 5 ? 'true' : 'false'}
- showSubtitle: 是否显示字幕，true
- titleStyle: 标题花字套装，pure/gradient/image 选1个`,
        history: [],
      }),
    });
    if (!res.ok) throw new Error('AI服务异常');
    const reader = res.body?.getReader();
    if (!reader) throw new Error('无数据');
    let full = ''; const decoder = new TextDecoder();
    while (true) { const { done, value } = await reader.read(); if (done) break; const c = decoder.decode(value, { stream: true }); const lines = c.split('\n'); for (const l of lines) { if (l.startsWith('data: ')) { try { const d = JSON.parse(l.slice(6)); if (d.summary) full = d.summary; if (d.text) full += d.text; } catch {} } } }
    const m = full.match(/\{[\s\S]*\}/); const r = m ? JSON.parse(m[0]) : {};
    return c.json({ success: true, data: {
      speechTexts: r.speechTexts || [script], titles: r.titles || [title||'一键成片'],
      bgmStyle: r.bgmStyle || 'bgm-relaxing', bgmVolume: r.bgmVolume || 0.2,
      bgStyle: r.bgStyle || 'gradient', imageDuration: r.imageDuration || 4,
      transition: r.transition ?? true, showTitle: r.showTitle ?? totalMedia >= 5,
      showSubtitle: r.showSubtitle ?? true, titleStyle: r.titleStyle || 'gradient',
    }});
  } catch (err: any) {
    return serverError(c, err, 'AI优化失败');
  }
});

// POST /api/video/batch-submit — 分组口播模式
route.post('/batch-submit', async (c) => {
  const { voiceId, shots, bgmStyle, orientation, showSubtitle, speechRate, subtitleConfig } = await c.req.json() as any;
  if (!voiceId || !shots?.length) return c.json({ success: false, error: '缺少必要参数' }, 400);

  try {
    const bucket = process.env.OSS_BUCKET || 'pms-zhisu';
    const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';

    // 构造分组口播模式的 groupMedia（每个 shot 一个 MediaGroup）
    const groupMedia = shots.map((s: any) => ({
      GroupName: `镜${s.index}_${(s.label || '').replace(/[\u{1F600}-\u{1F6FF}\u{2600}-\u{27FF}\u{1F900}-\u{1F9FF}\u{200D}\u{FE0F}]/gu, '').trim().slice(0, 20) || `镜${s.index}`}`,
      MediaArray: s.media,
      SpeechTextArray: [s.script?.slice(0, 1000) || ''],
      Duration: s.duration || 5,
    }));

    // 拼接完整口播作为 title fallback
    const fullScript = shots.map((s: any) => s.script).join(' ');

    const { jobId } = await submitBatchJob({
      voiceId,
      script: fullScript,
      title: shots[0]?.script?.slice(0, 50) || '一键成片',
      groupMedia,
      outputBucket: `https://${bucket}.${ossRegion}.aliyuncs.com`,
      orientation,
      editingConfig: {
        BackgroundMusicConfig: bgmStyle ? { Volume: 0.2, Style: bgmStyle } : { Volume: 0 },
        SpeechConfig: (() => {
          const base: any = { Volume: 1, SpeechRate: (speechRate || 1.0) - 1.0 };
          if (showSubtitle) {
            base.AsrConfig = {
              Alignment: 'TopCenter',
              AdaptMode: 'AutoWrap',
              Font: subtitleConfig?.font || 'Alibaba PuHuiTi',
              FontSize: subtitleConfig?.fontSize || 48,
              FontColor: subtitleConfig?.fontColor || '#FFFFFF',
              Outline: subtitleConfig?.outline ?? 2,
              OutlineColour: (subtitleConfig?.outlineColor || '000000').replace('#', ''),
              Y: 0.8,
            };
          }
          return base;
        })(),
      },
    });

    const id = `batch_${Date.now()}`;
    await db.insert(pmsBuiBatchJobs).values({
      id, merchantId: 'default', voiceId,
      script: fullScript.slice(0, 200),
      title: shots[0]?.script?.slice(0, 50) || '一键成片',
      groupMedia,
      aliyunJobId: jobId, status: 'processing',
    } as any);

    return c.json({ success: true, data: { id, jobId, status: 'processing' } });
  } catch (err: any) {
    return serverError(c, err, '批量成片提交失败');
  }
});

// GET /api/video/batch-status/:jobId — 支持内部ID或阿里云JobId
route.get('/batch-status/:jobId', async (c) => {
  const id = c.req.param('jobId');
  try {
    // 先按内部ID查，查不到则当阿里云JobId
    const [batch] = await db.select().from(pmsBuiBatchJobs).where(eq(pmsBuiBatchJobs.id, id)).limit(1);
    const aliyunId = batch?.aliyunJobId || id;
    const { status, outputUrls } = await getBatchJobStatus(aliyunId);
    await db.update(pmsBuiBatchJobs).set({ status, ...(outputUrls?.length ? { outputUrls } : {}), updatedAt: new Date() } as any).where(eq(pmsBuiBatchJobs.aliyunJobId, aliyunId));
    return c.json({ success: true, data: { status, outputUrls } });
  } catch (err: any) {
    return serverError(c, err, '查询批量任务状态失败');
  }
});

// GET /api/video/fastcut-jobs — 快剪 + 模板任务列表
route.get('/fastcut-jobs', async (c) => {
  const list = await db.select().from(pmsBuiVideoTasks)
    .orderBy(desc(pmsBuiVideoTasks.createdAt)).limit(20);
  const data = list.map(j => ({
    id: j.id, status: j.status, type: j.type,
    inputParams: j.inputParams,
    outputUrl: j.outputUrl, createdAt: j.createdAt,
    aliyunTaskId: j.aliyunTaskId,
  }));
  return c.json({ success: true, data });
});

// GET /api/video/fastcut-status/:jobId — 快剪V2状态查询
route.get('/fastcut-status/:jobId', async (c) => {
  const id = c.req.param('jobId');
  const [task] = await db.select().from(pmsBuiVideoTasks).where(eq(pmsBuiVideoTasks.id, id)).limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);
  if (task.status === 'processing' && task.aliyunTaskId) {
    try {
      const { status, outputUrl } = await getMediaJobStatus(task.aliyunTaskId);
      await db.update(pmsBuiVideoTasks).set({ status, ...(outputUrl ? { outputUrl } : {}), updatedAt: new Date() } as any).where(eq(pmsBuiVideoTasks.id, id));
      return c.json({ success: true, data: { ...task, status, outputUrl: outputUrl || task.outputUrl } });
    } catch {}
  }
  return c.json({ success: true, data: task });
});

// GET /api/video/batch-jobs
route.get('/batch-jobs', async (c) => {
  const list = await db.select().from(pmsBuiBatchJobs).orderBy(desc(pmsBuiBatchJobs.createdAt)).limit(20);
  const data = list.map(j => ({
    id: j.id, status: j.status, voiceId: j.voiceId, script: (j.script||'').slice(0, 50),
    outputUrls: j.outputUrls, createdAt: j.createdAt, updatedAt: j.updatedAt,
  }));
  return c.json({ success: true, data });
});

// ========== 智能图文混剪（SubmitBatchMediaProducingJob + Scene:General）==========

// POST /api/video/smart-mix — 提交智能图文混剪
route.post('/smart-mix', async (c) => {
  const body = await c.req.json();
  const { script, title, mediaUrls, bgmStyle, orientation, voiceId } = body as any;
  if (!script || !mediaUrls?.length) {
    return c.json({ success: false, error: '缺少必要参数' }, 400);
  }
  try {
    const bucket = process.env.OSS_BUCKET || 'pms-zhisu';
    const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';
    const cleanTitle = (title || '').replace(/[*#]+/g, '').trim().slice(0, 50) || '智能混剪';

    const { jobId } = await submitSmartMix({
      mediaUrls, script, title: cleanTitle,
      outputBucket: `https://${bucket}.${ossRegion}.aliyuncs.com`,
      orientation, bgmStyle, voiceId,
    });
    const id = `sm_${Date.now()}`;
    await db.insert(pmsBuiVideoTasks).values({
      id, merchantId: 'default', type: 'smartmix', status: 'processing',
      aliyunTaskId: jobId,
      inputParams: { script: cleanTitle, mediaUrls, orientation },
    } as any);
    return c.json({ success: true, data: { id, jobId, status: 'processing' } });
  } catch (err: any) {
    return serverError(c, err, '智能混剪提交失败');
  }
});

// GET /api/video/smart-mix-status/:id — 查询智能混剪任务
route.get('/smart-mix-status/:id', async (c) => {
  const id = c.req.param('id');
  const [task] = await db.select().from(pmsBuiVideoTasks).where(eq(pmsBuiVideoTasks.id, id)).limit(1);
  if (!task) return c.json({ success: false, error: '任务不存在' }, 404);
  if (task.status === 'processing' && task.aliyunTaskId) {
    try {
      const crypto = await import('crypto');
      const ak = process.env.ALIYUN_ACCESS_KEY_ID || '';
      const sk = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
      const rp: Record<string, string> = {
        Action: 'GetBatchMediaProducingJob', Version: '2020-11-09', AccessKeyId: ak,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', Format: 'JSON',
        SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        JobId: task.aliyunTaskId,
      };
      const sorted = Object.keys(rp).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(rp[k])}`).join('&');
      const sig = crypto.createHmac('sha1', `${sk}&`).update(`GET&${encodeURIComponent('/')}&${encodeURIComponent(sorted)}`).digest('base64');
      const res = await fetch(`https://ice.cn-beijing.aliyuncs.com/?${sorted}&Signature=${encodeURIComponent(sig)}`);
      const data = (await res.json()) as any;
      const sm: Record<string, string> = { Finished: 'completed', Success: 'completed', Failed: 'failed', Processing: 'processing' };
      const status = sm[data.Status || data.EditingBatchJob?.Status] || 'processing';
      const urls: string[] = [];
      if (data.EditingBatchJob?.SubJobList) {
        urls.push(...data.EditingBatchJob.SubJobList.filter((s: any) => s.Status === 'Success' && s.MediaURL).map((s: any) => s.MediaURL));
      }
      const outputUrl = urls[0] || task.outputUrl;
      await db.update(pmsBuiVideoTasks).set({ status, ...(outputUrl ? { outputUrl } : {}), updatedAt: new Date() } as any).where(eq(pmsBuiVideoTasks.id, id));
      return c.json({ success: true, data: { ...task, status, outputUrl } });
    } catch {}
  }
  return c.json({ success: true, data: task });
});

// POST /api/video/template-fill — AI 内容重构 Agent + 模板 ClipsParam 填充
route.post('/template-fill', async (c) => {
  const body = await c.req.json();
  const { templateId, script, groupMedia } = body as {
    templateId: string;
    script: string;
    groupMedia: Array<{ step: number; desc: string; media: string[] }>;
  };
  if (!templateId || !script) {
    return c.json({ success: false, error: '缺少必要参数' }, 400);
  }
  try {
    // 1. 获取模板信息
    const crypto = await import('crypto');
    const ak = process.env.ALIYUN_ACCESS_KEY_ID || '';
    const sk = process.env.ALIYUN_ACCESS_KEY_SECRET || '';
    function imsCall(action: string, extra: Record<string, string>) {
      const rp: Record<string, string> = {
        Action: action, Version: '2020-11-09', AccessKeyId: ak,
        Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
        SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', Format: 'JSON',
        SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
        ...extra,
      };
      const sorted = Object.keys(rp).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(rp[k])}`).join('&');
      const sig = crypto.createHmac('sha1', `${sk}&`).update(`GET&${encodeURIComponent('/')}&${encodeURIComponent(sorted)}`).digest('base64');
      return fetch(`https://ice.cn-beijing.aliyuncs.com/?${sorted}&Signature=${encodeURIComponent(sig)}`).then(r => r.json()) as Promise<any>;
    }

    const imsData = await imsCall('GetTemplate', { TemplateId: templateId });
    if (!imsData.Template?.ClipsParam) {
      return c.json({ success: false, error: '无法获取模板信息' }, 500);
    }
    const templateName = imsData.Template.Name || '';

    // 2. 解析槽位
    const clipsParam = JSON.parse(imsData.Template.ClipsParam);
    const textSlots = Object.keys(clipsParam).filter(k => k.startsWith('Text')).sort();
    const mediaSlots = Object.keys(clipsParam).filter(k => k.startsWith('Media')).sort();
    const plainText = script.replace(/<[^>]+>/g, '').trim();

    // 3. AI 内容重构 — 调用 pms-agent 智能生成各槽位文案
    let filled: Record<string, string> = {};
    try {
      const aiPrompt = `你是短视频模板内容重构专家。模板「${templateName}」有 ${textSlots.length} 个文字位（${textSlots.join('、')}）。
请根据以下创作脚本，为每个文字位重构生成通顺、完整、符合模板语境的文案：

【创作脚本】
${plainText}

要求：
1. 每个文字位必须输出一句完整通顺的句子或吸引眼球的短语，不能是随意截断的半句
2. 内容必须是重构后的新文字，整体连贯流畅，符合脚本主题和短视频口播风格
3. Text0 一般为标题或核心卖点（精炼有冲击力），最后一个文字位一般为行动号召（引导用户点击/预订）
4. 所有文字位数量固定为 ${textSlots.length} 个，必须全部填满，每个 15-50 字为宜
5. 只输出 JSON 对象，格式：{"Text0":"...","Text1":"...","Text2":"..."}`;

      const aiRes = await fetch(`${AGENT_API_URL}/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Internal-Service-Token': INTERNAL_SERVICE_TOKEN || '' },
        body: JSON.stringify({ message: aiPrompt, history: [] }),
      });
      if (aiRes.ok) {
        const reader = aiRes.body?.getReader();
        if (reader) {
          let full = ''; const decoder = new TextDecoder();
          while (true) { const { done, value } = await reader.read(); if (done) break; const c = decoder.decode(value, { stream: true }); const lines = c.split('\n'); for (const l of lines) { if (l.startsWith('data: ')) { try { const d = JSON.parse(l.slice(6)); if (d.summary) full = d.summary; if (d.text) full += d.text; } catch {} } } }
          const m = full.match(/\{[\s\S]*\}/);
          if (m) {
            const parsed = JSON.parse(m[0]);
            for (const slot of textSlots) {
              if (parsed[slot]) filled[slot] = parsed[slot];
            }
          }
        }
      }
      console.log('[template-fill] AI 重构完成, slots filled:', Object.keys(filled).length);
    } catch (aiErr: any) {
      console.warn('[template-fill] AI 重构失败，回退机械填充:', aiErr.message);
    }

    // 4. 回退：AI 失败时机械填充保证不空白
    if (Object.keys(filled).length < textSlots.length) {
      const sentences = plainText.split(/(?<=[。！？!?\n])/g).map(s => s.trim()).filter(Boolean);
      for (let i = 0; i < textSlots.length; i++) {
        if (!filled[textSlots[i]]) {
          filled[textSlots[i]] = sentences[i] || sentences[i % sentences.length] || plainText.slice(0, 40);
        }
      }
    }

    // 5. 素材严格匹配
    const allMedia = (groupMedia || []).flatMap((g: any) => g.media || []);
    const mediaWarnings: string[] = [];
    if (allMedia.length < mediaSlots.length) mediaWarnings.push(`素材不足(${allMedia.length}/${mediaSlots.length})，将循环复用`);
    if (allMedia.length > mediaSlots.length) mediaWarnings.push(`素材超出(${allMedia.length}/${mediaSlots.length})，仅用前${mediaSlots.length}个`);
    for (let i = 0; i < mediaSlots.length; i++) {
      filled[mediaSlots[i]] = allMedia[i] || allMedia[i % allMedia.length] || '';
    }

    return c.json({
      success: true,
      data: { clipsParam: filled, textSlots, mediaSlots, templateName, aiEnhanced: Object.keys(filled).length >= textSlots.length, warnings: mediaWarnings.length > 0 ? mediaWarnings : undefined },
    });
  } catch (err: any) {
    return serverError(c, err, '模板填充失败');
  }
});

// POST /api/video/template-submit — 使用公共模板提交成片
route.post('/template-submit', async (c) => {
  const body = await c.req.json();
  const { templateId, clipsParam, orientation, title } = body as {
    templateId: string;
    clipsParam: Record<string, string>;
    orientation?: string;
    title?: string;
  };
  if (!templateId || !clipsParam) {
    return c.json({ success: false, error: '缺少必要参数' }, 400);
  }
  try {
    const bucket = process.env.OSS_BUCKET || 'pms-zhisu';
    const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';
    const isLandscape = orientation === 'landscape';
    const outW = isLandscape ? 1920 : 1080;
    const outH = isLandscape ? 1080 : 1920;

    // 构建 IMS 请求
    const rp: Record<string, string> = {
      Action: 'SubmitMediaProducingJob', Version: '2020-11-09',
      AccessKeyId: process.env.ALIYUN_ACCESS_KEY_ID || '',
      Timestamp: new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'),
      SignatureMethod: 'HMAC-SHA1', SignatureVersion: '1.0', Format: 'JSON',
      SignatureNonce: `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      TemplateId: templateId,
      ClipsParam: JSON.stringify(clipsParam),
      OutputMediaConfig: JSON.stringify({
        MediaURL: `https://${bucket}.${ossRegion}.aliyuncs.com/fastcut/tpl_${Date.now()}.mp4`,
        Width: outW, Height: outH,
      }),
    };
    const crypto = await import('crypto');
    const sortedKeys = Object.keys(rp).sort();
    const query = sortedKeys.map(k => `${encodeURIComponent(k)}=${encodeURIComponent(rp[k])}`).join('&');
    const signStr = `GET&${encodeURIComponent('/')}&${encodeURIComponent(query)}`;
    const sig = crypto.createHmac('sha1', `${process.env.ALIYUN_ACCESS_KEY_SECRET || ''}&`).update(signStr).digest('base64');
    const imsUrl = `https://ice.cn-beijing.aliyuncs.com/?${query}&Signature=${encodeURIComponent(sig)}`;
    const imsRes = await fetch(imsUrl);
    const imsData = (await imsRes.json()) as any;
    const jobId = imsData.JobId || '';

    if (!jobId) throw new Error(`模板成片失败: ${JSON.stringify(imsData)}`);

    const id = `tpl_${Date.now()}`;
    await db.insert(pmsBuiVideoTasks).values({
      id, merchantId: 'default', type: 'template', status: 'processing',
      aliyunTaskId: jobId,
      inputParams: { templateId, script: title || clipsParam?.Text0 || '模板快剪', orientation },
    } as any);
    return c.json({ success: true, data: { id, jobId, status: 'processing' } });
  } catch (err: any) {
    return serverError(c, err, '模板成片失败');
  }
});

// GET /api/video/templates — 获取公共模板库列表
route.get('/templates', async (c) => {
  try {
    const list = await db.select().from(pmsBuiImsTemplates).orderBy(desc(pmsBuiImsTemplates.createdAt));
    return c.json({ success: true, data: list });
  } catch (err: any) {
    return serverError(c, err, '查询模板库失败');
  }
});

export default route;
