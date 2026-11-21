/**
 * 火山引擎 MediaKit REST API 客户端
 * 每个函数内部: 提交 → 轮询 → 备份 OSS → 返回 URL
 */
import { uploadToOSS } from '../aliyun/oss.js';

const ENDPOINT = process.env.MEDIAKIT_ENDPOINT || 'https://mediakit.cn-beijing.volces.com';
const API_KEY = process.env.MEDIAKIT_API_KEY || '';

async function mkPost(path: string, body: any): Promise<any> {
  const res = await fetch(`${ENDPOINT}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${API_KEY}` },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function mkGet(taskId: string): Promise<any> {
  const res = await fetch(`${ENDPOINT}/api/v1/tasks/${taskId}`, {
    headers: { 'Authorization': `Bearer ${API_KEY}` },
  });
  return res.json();
}

/** 轮询直到任务完成，然后下载视频并备份到 OSS */
async function pollAndBackup(taskId: string, label: string): Promise<string> {
  while (true) {
    const data = await mkGet(taskId);
    if (data.status === 'completed' && data.result?.video_url) {
      const res = await fetch(data.result.video_url);
      const buf = Buffer.from(await res.arrayBuffer());
      const ossUrl = await uploadToOSS(buf, `pms/mediakit/${label}_${Date.now()}.mp4`, 'video/mp4');
      console.log(`[mediakit] ${label} 完成:`, ossUrl);
      return ossUrl;
    }
    if (data.status === 'failed') {
      throw new Error(`${label} 失败: ${JSON.stringify(data)}`);
    }
    await new Promise(r => setTimeout(r, 3000));
  }
}

/** 图片转视频（Ken Burns 动画） */
export async function imageToVideo(images: Array<{ url: string; duration: number }>): Promise<string> {
  const data = await mkPost('/api/v1/tools/image-to-video', {
    images: images.map((img, i) => ({
      image_url: img.url,
      duration: img.duration,
      animation_type: i === 0 ? 'zoom_in' : 'move_right',
    })),
  });
  if (!data.task_id) throw new Error(`image-to-video 提交失败`);
  return pollAndBackup(data.task_id, 'img2vid');
}

/** 视频裁剪（从 0 到指定时长） */
export async function trimVideo(videoUrl: string, duration: number): Promise<string> {
  const data = await mkPost('/api/v1/tools/trim-video', {
    video_url: videoUrl,
    start_time: 0,
    end_time: duration,
  });
  if (!data.task_id) throw new Error(`trim-video 提交失败`);
  return pollAndBackup(data.task_id, 'trim');
}

/** 视频拼接（支持转场） */
export async function concatVideo(videoUrls: string[], transitions?: string[]): Promise<string> {
  const body: any = { video_urls: videoUrls };
  if (transitions?.length) body.transitions = transitions;
  const data = await mkPost('/api/v1/tools/concat-video', body);
  if (!data.task_id) throw new Error(`concat-video 提交失败`);
  return pollAndBackup(data.task_id, 'concat');
}

/** 音视频合成（替换原声） */
export async function muxAudioVideo(videoUrl: string, audioUrl: string): Promise<string> {
  const data = await mkPost('/api/v1/tools/mux-audio-video', {
    video_url: videoUrl,
    audio_url: audioUrl,
    is_audio_reserve: false,
  });
  if (!data.task_id) throw new Error(`mux-audio-video 提交失败`);
  return pollAndBackup(data.task_id, 'mux');
}

/** 字幕压制 */
export async function addSubtitle(
  videoUrl: string,
  subtitles: Array<{ text: string; start: number; end: number }>,
  config?: { fontType?: string; fontSize?: number; fontColor?: string; posPreset?: string },
): Promise<string> {
  const data = await mkPost('/api/v1/tools/add-subtitle-to-video', {
    video_url: videoUrl,
    subtitles: subtitles.map(s => ({
      subtitle_text: s.text,
      start_time: s.start,
      end_time: s.end,
    })),
    subtitle_font_type: config?.fontType || 'ali_puhui',
    subtitle_font_size: config?.fontSize || 48,
    subtitle_font_color: config?.fontColor || '#FFFFFFFF',
    subtitle_pos_preset: config?.posPreset || 'bottom_center',
  });
  if (!data.task_id) throw new Error(`add-subtitle 提交失败`);
  return pollAndBackup(data.task_id, 'sub');
}
