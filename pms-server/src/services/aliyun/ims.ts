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

// ====== 单条快剪 ======
export async function submitFastCut(params: any): Promise<{ taskId: string }> {
  const width = params.width || 1080; const height = params.height || 1920;
  const useTransition = params.transition !== 'none'; const useFilter = params.filter === 'warm';
  const subY = params.subtitleY ?? 0.88; const subAlign = params.subtitleAlign || 'BottomCenter';
  const subFont = params.subFont || 'Alibaba PuHuiTi'; const subFontSize = params.subFontSize || 60;
  const subEffectStyle = params.subEffectStyle || '';
  const SUB_Y_PX: Record<string, number> = { TopCenter: 180, TopLeft: 180, TopRight: 180, Center: 960, CenterLeft: 960, CenterRight: 960, BottomCenter: 1740, BottomLeft: 1740, BottomRight: 1740 };
  function buildSubtitleEffects(content: string): any[] {
    const e: any = { Type: 'AI_ASR', Content: content, Alignment: subAlign, FontSize: subFontSize, FontColor: '#FFFFFF', Outline: 4, OutlineColour: '000000', FontFace: { Bold: true }, Y: SUB_Y_PX[subAlign] ?? 1740, AdaptMode: 'AutoWrap', TextWidth: 0.85 };
    if (subFont && subFont !== 'Alibaba PuHuiTi') e.Font = subFont;
    if (subEffectStyle) { e.EffectColorStyle = subEffectStyle; delete e.Outline; delete e.OutlineColour; }
    return [e];
  }
  const videoClips = params.images.map((img: string, i: number) => {
    const isLast = i === params.images.length - 1;
    const effects: any[] = [{ Type: 'KenBurns' }];
    if (useTransition && !isLast) effects.push({ Type: 'Transition', SubType: 'random', Duration: 0.8 });
    return { MediaURL: img, Type: 'Image', Duration: 5, Effects: effects.length > 0 ? effects : undefined };
  });
  const audioClips: any[] = [];
  if (params.ttsText) {
    const c: any = { Type: 'AI_TTS', Content: params.ttsText, Voice: params.ttsVoice || 'zhichu' };
    if (params.asrText) c.Effects = buildSubtitleEffects(params.asrText);
    audioClips.push(c);
  } else if (params.audioUrl) {
    const c: any = { MediaURL: params.audioUrl };
    if (params.asrText) c.Effects = buildSubtitleEffects(params.asrText);
    audioClips.push(c);
  }
  const timeline: any = { VideoTracks: [{ VideoTrackClips: videoClips }] };
  if (audioClips.length > 0) timeline.AudioTracks = [{ AudioTrackClips: audioClips }];
  if (useFilter) timeline.EffectTracks = [{ EffectTrackItems: [{ Type: 'Filter', SubType: 'color', ExtParams: 'effect=color,brightness=5,contrast=8,saturation=15,kelvin_temperature=5800,dark_corner_ratio=15' }] }];
  if (params.subtitles?.length > 0 && !params.asrText) {
    const bc: any = { Type: 'Text', Alignment: subAlign, FontSize: subFontSize, FontColor: '#FFFFFF', Outline: 4, OutlineColour: '000000', FontFace: { Bold: true }, Y: SUB_Y_PX[subAlign] ?? 1740, AdaptMode: 'AutoWrap', TextWidth: 0.85 };
    if (subFont && subFont !== 'Alibaba PuHuiTi') bc.Font = subFont;
    if (subEffectStyle) { bc.EffectColorStyle = subEffectStyle; delete bc.Outline; delete bc.OutlineColour; }
    timeline.SubtitleTracks = [{ SubtitleTrackClips: params.subtitles.map((s: any) => ({ ...bc, Content: s.text, TimelineIn: s.start, TimelineOut: s.end })) }];
  }
  const rp = { ...baseParams('SubmitMediaProducingJob'), ProjectMetadata: JSON.stringify({ Title: 'PMS快剪', Description: '智宿管家' }), Timeline: JSON.stringify(timeline), OutputMediaConfig: JSON.stringify({ MediaURL: `${params.outputBucket}/${params.outputKey}`, Width: width, Height: height }), TemplateId: 'Custom', ProduceConfig: JSON.stringify({ Resolution: `${width}x${height}` }) };
  const sig = sign('GET', rp); const up = new URLSearchParams({ ...rp, Signature: sig });
  const res = await fetch(`${IMS_ENDPOINT}/?${up}`, { method: 'GET' });
  const data = (await res.json()) as any;
  const jobId = data.JobId || '';
  if (!jobId) throw new Error(`IMS任务提交失败: ${JSON.stringify(data)}`);
  return { taskId: jobId };
}

export async function getMediaJobStatus(jobId: string): Promise<{ status: string; outputUrl?: string; duration?: unknown; message?: unknown }> {
  const rp = { ...baseParams('GetMediaProducingJob'), JobId: jobId };
  const sig = sign('GET', rp); const up = new URLSearchParams({ ...rp, Signature: sig });
  const res = await fetch(`${IMS_ENDPOINT}/?${up}`, { method: 'GET' });
  const data = (await res.json()) as any;
  const job = data.MediaProducingJob || data.Job || {};
  const sm: Record<string, string> = { Success: 'completed', Failed: 'failed', Init: 'processing', Queuing: 'processing', Processing: 'processing', Pending: 'processing' };
  return { status: sm[job.Status] || 'processing', outputUrl: job.MediaURL || job.Output?.MediaURL || undefined, duration: job.Duration, message: job.Message };
}

// ====== 智能图文混剪（Scene:General）======
export async function submitSmartMix(params: {
  mediaUrls: string[]; script: string; title: string;
  outputBucket: string; orientation?: string;
  bgmStyle?: string; voiceId?: string;
}): Promise<{ jobId: string }> {
  const isLandscape = params.orientation === 'landscape';
  const outW = isLandscape ? 1920 : 1080;
  const outH = isLandscape ? 1080 : 1920;

  const inputConfig = JSON.stringify({
    MediaArray: params.mediaUrls,
    SceneInfo: { Scene: 'General' },
    SpeechTextArray: [params.script.slice(0, 1000)],
    TitleArray: [params.title.slice(0, 50)],
  });

  const editingConfig = JSON.stringify({
    MediaConfig: { Volume: 0 },
    SpeechConfig: { Volume: 1, SpeechRate: 0, ...(params.voiceId ? { Voice: params.voiceId } : {}) },
    BackgroundMusicConfig: { Volume: 0.15, Style: params.bgmStyle || undefined },
    ProcessConfig: {
      EnableClipSplit: true,
      AllowTransition: true,
      AllowVfxEffect: true,
      TransitionDuration: 0.6,
      ImageDuration: 3,
    },
    CanvasConfig: { Width: outW, Height: outH },
  });

  const outputConfig = JSON.stringify({
    MediaURL: `${params.outputBucket}/smartmix/out_{index}.mp4`,
    Count: 1, Width: outW, Height: outH,
  });

  const rp: Record<string, string> = {
    ...baseParams('SubmitBatchMediaProducingJob'),
    ClientToken: `pms_sm_${Date.now()}`,
    InputConfig: inputConfig,
    EditingConfig: editingConfig,
    OutputConfig: outputConfig,
  };
  const sig = sign('POST', rp);
  const body = new URLSearchParams(rp); body.append('Signature', sig);
  const res = await fetch(`${IMS_ENDPOINT}/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: body.toString() });
  const data = (await res.json()) as any;
  const jobId = data.JobId || '';
  if (!jobId) throw new Error(`智能混剪提交失败: ${JSON.stringify(data)}`);
  return { jobId };
}

// ====== 批量一键成片 ======
export async function submitBatchJob(params: {
  voiceId: string; script: string; title: string;
  groupMedia: Array<{ step?: number; desc?: string; media?: string[]; GroupName?: string; MediaArray?: string[]; SpeechTextArray?: string[]; Duration?: number }>;
  outputBucket: string; transition?: boolean; imageDuration?: number;
  editingConfig?: any; orientation?: string;
}): Promise<{ jobId: string }> {
  // 兼容两种格式：旧格式 { step, desc, media } → 全局口播；新格式 { GroupName, MediaArray, SpeechTextArray, Duration } → 分组口播
  const isGroupNarration = params.groupMedia.some((g: any) => g.SpeechTextArray?.length > 0);
  const inputConfig: any = {
    MediaGroupArray: params.groupMedia.map(g => ({
      GroupName: (g.GroupName || g.desc || '').slice(0, 50),
      MediaArray: g.MediaArray || g.media || [],
      ...(isGroupNarration ? { SpeechTextArray: g.SpeechTextArray, Duration: g.Duration } : {}),
    })),
  };
  // 全局口播模式才需要顶层 SpeechTextArray
  if (!isGroupNarration) {
    inputConfig.SpeechTextArray = [params.script.slice(0, 1000)];
  }
  // 仅 IMS 自定义音色传 CustomizedVoice，系统音色不传
  const isSystemVoice = /^(long|zhi|loong)/i.test(params.voiceId || '');
  const speechConfig: any = { Volume: 1 };
  if (!isSystemVoice && params.voiceId) {
    speechConfig.CustomizedVoice = params.voiceId;
  }

  const defaultEditing: any = {
    MediaConfig: { Volume: 0 },
    SpeechConfig: speechConfig,
    BackgroundMusicConfig: { Volume: 0 },
    ProcessConfig: { AllowTransition: params.transition ?? true, TransitionDuration: 0.6, ImageDuration: params.imageDuration ?? 4 },
  };
  // 深度合并：SpeechConfig/AsrConfig 会被 extra 补充，而非覆盖
  const extra = params.editingConfig || {};
  if (extra.SpeechConfig) {
    defaultEditing.SpeechConfig = { ...defaultEditing.SpeechConfig, ...extra.SpeechConfig };
    delete extra.SpeechConfig;
  }
  if (extra.BackgroundMusicConfig) {
    defaultEditing.BackgroundMusicConfig = extra.BackgroundMusicConfig;
    delete extra.BackgroundMusicConfig;
  }
  if (extra.BackgroundImageConfig) {
    defaultEditing.BackgroundImageConfig = extra.BackgroundImageConfig;
    delete extra.BackgroundImageConfig;
  }
  const finalEditing = { ...defaultEditing, ...extra };
  console.log('[submitBatchJob] EditingConfig keys:', Object.keys(finalEditing));
  console.log('[submitBatchJob] SpeechConfig:', JSON.stringify(finalEditing.SpeechConfig));
  console.log('[submitBatchJob] TitleConfig:', JSON.stringify(finalEditing.TitleConfig));
  const editingConfig = JSON.stringify(finalEditing);
  const isLandscape = params.orientation === 'landscape';
  const outWidth = isLandscape ? 1920 : 1080;
  const outHeight = isLandscape ? 1080 : 1920;
  const outputConfig = JSON.stringify({
    MediaURL: `${params.outputBucket}/batch/out_{index}.mp4`, Count: 1, Width: outWidth, Height: outHeight,
  });
  const rp: Record<string, string> = { ...baseParams('SubmitBatchMediaProducingJob'), ClientToken: `pms_${Date.now()}`, InputConfig: JSON.stringify(inputConfig), EditingConfig: editingConfig, OutputConfig: outputConfig };
  const sig = sign('POST', rp);
  const bodyStr = Object.keys(rp).sort().map(k => `${encodeURIComponent(k)}=${encodeURIComponent(rp[k])}`).join('&') + `&Signature=${encodeURIComponent(sig)}`;
  const res = await fetch(`${IMS_ENDPOINT}/`, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: bodyStr });
  const data = (await res.json()) as any;
  const jobId = data.JobId || '';
  if (!jobId) throw new Error(`批量成片提交失败: ${JSON.stringify(data)}`);
  return { jobId };
}

// 过滤 emoji（IMS Timeline 不支持 emoji 字符）
function stripEmoji(s: string): string {
  return s.replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F1E0}-\u{1F1FF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{FE00}-\u{FE0F}\u{1F900}-\u{1F9FF}\u{200D}]/gu, '').replace(/\s+/g, ' ').trim();
}

// ====== 快剪 V2: Timeline + 音频 + 字幕（精简版） ======
export async function submitFastCutV2(params: {
  voiceId: string; script: string; title: string;
  subtitleText?: string;
  groupMedia: Array<{ step: number; desc: string; media: string[] }>;
  outputBucket: string; orientation?: string;
  transition?: boolean; imageDuration?: number;
  showSubtitle?: boolean; subtitlePos?: string;
  subFontSize?: number; subFont?: string; subFontColor?: string;
  subOutline?: number; subOutlineColour?: string;
  subEffectStyle?: string; subEffects?: any[]; subBubble?: string;
  audioUrl?: string;       // 预合成/混音后 TTS 音频 OSS URL
  showTitle?: boolean;     // 是否显示片头标题卡
  titleText?: string;      // 标题卡文字
  bgmUrl?: string;         // BGM 背景音乐 OSS URL
  bgmVolume?: number;      // BGM 音量 0-1
}): Promise<{ jobId: string }> {
  const isLandscape = params.orientation === 'landscape';
  const outW = isLandscape ? 1920 : 1080;
  const outH = isLandscape ? 1080 : 1920;
  const TITLE_DUR = 2.5;

  // === 片头标题卡 ===
  const titleClips: any[] = [];
  if (params.showTitle !== false && params.titleText) {
    const tc = stripEmoji(params.titleText);
    if (tc) {
      titleClips.push({
        Type: 'Text', Content: tc, Duration: TITLE_DUR,
        Alignment: 'Center', AdaptMode: 'AutoWrap', TextWidth: 0.8,
        FontSize: 72, Font: 'Alibaba PuHuiTi', FontColor: '#FFFFFF',
        FontFace: { Bold: true },
        Effects: [{ Type: 'Background', SubType: 'Color', Color: '#0f172a' }],
      });
    }
  }

  // === 视频素材 ===
  const allClips = params.groupMedia.flatMap(g => g.media.map(url => ({
    url, isVideo: /\.(mp4|mov|webm|avi)/i.test(url),
  })));
  const videoClips = allClips.map((clip, i) => {
    const isLast = i === allClips.length - 1;
    const c: any = { MediaURL: clip.url };
    if (clip.isVideo) { c.Type = 'Video'; }
    else { c.Type = 'Image'; c.Duration = params.imageDuration || 4; }
    if (params.transition !== false && !isLast) {
      c.Effects = [{ Type: 'Transition', SubType: 'random', Duration: 0.6 }];
    }
    return c;
  });

  // === 组装视频轨（调试阶段：仅视频素材，无片头片尾） ===
  const allVideoClips = videoClips;

  // === 音频轨 ===
  const audioClip: any = params.audioUrl
    ? { Type: 'Media', MediaURL: params.audioUrl }
    : { Type: 'AI_TTS', Content: params.script.slice(0, 1000), CustomizedVoice: params.voiceId, SpeechRate: 0, DisableSubtitle: true };
  const audioTracks: any[] = [{ AudioTrackClips: [audioClip] }];
  // BGM 背景音乐（用 Effects 数组设音量，IMS 可能不认识 Volume 顶层参数但认识 Effect）
  if (params.bgmUrl) {
    const gain = ((params.bgmVolume ?? 0.05) * 100).toFixed(0);
    audioTracks.push({
      AudioTrackClips: [{ Type: 'Media', MediaURL: params.bgmUrl, Effects: [{ Type: 'Volume', Gain: gain }] }],
    });
  }

  const timeline: any = {
    VideoTracks: [{ VideoTrackClips: allVideoClips }],
    AudioTracks: audioTracks,
  };

  // === 字幕轨（仅底部逐句口播字幕） ===
  if (params.showSubtitle !== false) {
    const subContent = stripEmoji(params.subtitleText || params.script.replace(/<[^>]+>/g, '').trim());
    const CHAR_PER_SEC = 4.5, MIN_DUR = 1.2, GAP = 0.3, MAX_LEN = 25;
    // IMS SubtitleTracks X/Y 绝对像素定位
    const SUB_Y = isLandscape ? (outH * 0.88) : (outH * 0.80); // 竖屏距顶80%≈中下部

    // 断句
    let chunks = subContent.split(/(?<=[。！？!?\n])/).filter((s: string) => s.trim().length > 0);
    if (chunks.length === 0) chunks = [subContent];
    chunks = chunks.flatMap((s: string) =>
      s.replace(/\s/g, '').length > MAX_LEN
        ? s.split(/(?<=[，,])/).filter((ss: string) => ss.trim().length > 0)
        : [s]
    ).filter((s: string) => s.trim().length > 0);
    // 短句合并
    const merged: string[] = [];
    for (const s of chunks) {
      const prev = merged.length > 0 ? merged[merged.length - 1] : '';
      if (prev && (prev.length + s.length) < 8) merged[merged.length - 1] = prev + s;
      else merged.push(s);
    }

    // IMS SubtitleTracks Alignment 方向与直觉相反: TopCenter→底部, BottomCenter→顶部
    // 前端字幕预设中的 Alignment 需要翻转
    const ALIGN_FLIP: Record<string, string> = {
      BottomCenter: 'TopCenter', BottomLeft: 'TopLeft', BottomRight: 'TopRight',
      TopCenter: 'BottomCenter', TopLeft: 'BottomLeft', TopRight: 'BottomRight',
    };
    const rawAlign = params.subtitlePos || 'BottomCenter';
    const subAlign = ALIGN_FLIP[rawAlign] || rawAlign;

    // 字号和定位固定，风格参数从预设透传
    const baseStyle: any = {
      Type: 'Text',
      Alignment: subAlign,
      Y: SUB_Y,
      FontSize: params.subFontSize || 70, Font: params.subFont || 'Alibaba PuHuiTi',
      FontColor: params.subFontColor || '#FFFFFF',
      AdaptMode: 'AutoWrap', TextWidth: 0.85,
    };
    if (params.subEffectStyle) {
      baseStyle.EffectColorStyle = params.subEffectStyle;
    } else {
      baseStyle.Outline = params.subOutline ?? 4;
      baseStyle.OutlineColour = params.subOutlineColour || '000000';
    }
    if (params.subEffects?.length) { baseStyle.SubtitleEffects = params.subEffects; }
    if (params.subBubble) { baseStyle.BubbleStyleId = params.subBubble; baseStyle.BubbleWidth = 0.7; baseStyle.BubbleHeight = 0.25; }

    const subStart = titleClips.length > 0 ? TITLE_DUR : 0;
    let cursor = subStart;
    const subClips = merged.map((sentence: string) => {
      const dur = Math.max(sentence.replace(/\s/g, '').length / CHAR_PER_SEC, MIN_DUR) + GAP;
      const clip = { ...baseStyle, Content: sentence.trim(), TimelineIn: cursor, TimelineOut: cursor + dur };
      cursor += dur;
      return clip;
    });

    timeline.SubtitleTracks = [{ SubtitleTrackClips: subClips }];
  }

  const rp = {
    ...baseParams('SubmitMediaProducingJob'),
    Timeline: JSON.stringify(timeline),
    OutputMediaConfig: JSON.stringify({ MediaURL: `${params.outputBucket}/fastcut/out_${Date.now()}.mp4`, Width: outW, Height: outH }),
  };
  console.log('[submitFastCutV2] Timeline preview:', JSON.stringify(timeline).slice(0, 500));
  const sig = sign('GET', rp); const up = new URLSearchParams({ ...rp, Signature: sig });
  const res = await fetch(`${IMS_ENDPOINT}/?${up}`, { method: 'GET' });
  const data = (await res.json()) as any;
  const jobId = data.JobId || '';
  if (!jobId) throw new Error(`快剪提交失败: ${JSON.stringify(data)}`);
  return { jobId };
}

export async function getBatchJobStatus(jobId: string): Promise<{ status: string; outputUrls?: string[] }> {
  const rp = { ...baseParams('GetBatchMediaProducingJob'), JobId: jobId };
  const sig = sign('GET', rp); const up = new URLSearchParams({ ...rp, Signature: sig });
  const res = await fetch(`${IMS_ENDPOINT}/?${up}`, { method: 'GET' });
  const data = (await res.json()) as any;
  // 批量API: Finished=完成, Failed=失败, Processing=处理中
  const sm: Record<string, string> = { Finished: 'completed', Success: 'completed', Failed: 'failed', Processing: 'processing' };
  const job = data.EditingBatchJob || data;
  let urls: string[] = [];
  if (job.SubJobList) urls = job.SubJobList.filter((s: any) => s.Status === 'Success' && s.MediaURL).map((s: any) => s.MediaURL);
  else if (job.Output?.MediaURL) urls = Array.isArray(job.Output.MediaURL) ? job.Output.MediaURL : [job.Output.MediaURL];
  return { status: sm[job.Status || data.Status] || 'processing', outputUrls: urls };
}

// ====== 字幕叠加（数字人口播第二步） ======
export async function submitSubtitleOverlay(params: {
  videoUrl: string;
  scriptText: string;
  outputKey: string;
  subtitleConfig?: {
    preset?: string;
    fontSize?: number;
    fontColor?: string;
    outline?: number;
    outlineColor?: string;
    alignment?: string;
    y?: number;
    font?: string;
  };
  width?: number;
  height?: number;
}): Promise<{ jobId: string }> {
  const width = params.width || 1080;
  const height = params.height || 1920;
  const bucket = process.env.OSS_BUCKET || 'pms-zhisu';
  const ossRegion = process.env.OSS_REGION || 'oss-cn-beijing';

  const sc = params.subtitleConfig || {};
  const subAlign = sc.alignment || 'BottomCenter';
  const subFontSize = sc.fontSize || 48;
  const subFontColor = sc.fontColor || '#FFFFFF';
  const subOutline = sc.outline ?? 4;
  const subOutlineColor = sc.outlineColor || '#000000';
  const subFont = sc.font || 'Alibaba PuHuiTi';

  const SUB_Y_MAP: Record<string, number> = {
    TopCenter: 180, BottomCenter: 1740, Center: 960,
  };

  const subtitleEffects: any = {
    Type: 'AI_ASR',
    Content: params.scriptText,
    Alignment: subAlign,
    FontSize: subFontSize,
    FontColor: subFontColor,
    Outline: subOutline,
    OutlineColour: subOutlineColor,
    FontFace: { Bold: true },
    Y: sc.y || SUB_Y_MAP[subAlign] || 1740,
    AdaptMode: 'AutoWrap',
    TextWidth: 0.85,
  };
  if (subFont && subFont !== 'Alibaba PuHuiTi') {
    subtitleEffects.Font = subFont;
  }

  const timeline: any = {
    VideoTracks: [{
      VideoTrackClips: [{
        MediaURL: params.videoUrl,
        Type: 'Video',
      }],
    }],
    AudioTracks: [{
      AudioTrackClips: [{
        MediaURL: params.videoUrl,
        Type: 'Video',
        Effects: [subtitleEffects],
      }],
    }],
  };

  const rp = {
    ...baseParams('SubmitMediaProducingJob'),
    ProjectMetadata: JSON.stringify({ Title: 'PMS数字人口播', Description: '智宿管家' }),
    Timeline: JSON.stringify(timeline),
    OutputMediaConfig: JSON.stringify({
      MediaURL: `https://${bucket}.${ossRegion}.aliyuncs.com/${params.outputKey}`,
      Width: width,
      Height: height,
    }),
    TemplateId: 'Custom',
    ProduceConfig: JSON.stringify({ Resolution: `${width}x${height}` }),
  };

  const sig = sign('GET', rp);
  const up = new URLSearchParams({ ...rp, Signature: sig });
  const res = await fetch(`${IMS_ENDPOINT}/?${up}`, { method: 'GET' });
  const data = (await res.json()) as any;
  const jobId = data.JobId || '';

  if (!jobId) {
    throw new Error(`ICE 字幕叠加任务提交失败: ${JSON.stringify(data)}`);
  }

  console.log('[IMS/SubtitleOverlay] 任务已提交:', jobId);
  return { jobId };
}
