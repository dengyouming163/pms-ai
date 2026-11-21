import { Hono } from 'hono';
import { desc, eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiBatchJobs } from '../db/schema/promotion.js';
import { imageToVideo, trimVideo, concatVideo, muxAudioVideo, addSubtitle } from '../services/mediakit/client.js';
import { synthesizeSpeech } from '../services/aliyun/voice.js';
import { uploadToOSS } from '../services/aliyun/oss.js';

const route = new Hono();

// POST /api/mediakit/batch-submit — 提交 MediaKit 一键成片任务
route.post('/batch-submit', async (c) => {
  const { voiceId, shots, subtitleConfig, title, transitions, speechRate } = await c.req.json() as any;
  if (!shots?.length) return c.json({ success: false, error: '缺少素材' }, 400);

  const id = `mk_${Date.now()}`;
  await db.insert(pmsBuiBatchJobs).values({
    id, merchantId: 'default', voiceId, status: 'processing',
    title: title || 'MediaKit成片',
  } as any);

  // 异步执行管线
  (async () => {
    try {
      const speechRateVal = speechRate || 1.0;
      const MIN_DUR = 1.2;  // 单条最少秒数
      const MIN_LEN = 4;    // 短句合并阈值
      const MAX_LEN = 16;   // 竖屏视频单行最多16字（1080px ÷ 56px字号 ≈ 19字，取保守值）

      // ====== Step 1: 逐镜 TTS → 每镜独立合成 → 文件大小精确测时 ======
      console.log(`[mediakit] 逐镜TTS开始, ${shots.length}镜, 语速${speechRateVal}x`);
      const ttsResults: Array<{ buf: Buffer; dur: number }> = [];
      for (const s of shots) {
        const buf = await synthesizeSpeech(s.script, voiceId, speechRateVal, 50);
        // 百炼 CosyVoice 输出: PCM WAV 24000Hz mono 16bit = 48000 bytes/s
        // 文件大小直接推算时长，比解析WAV头可靠
        let dur = buf.length > 44 ? (buf.length - 44) / 48000 : buf.length / 48000;
        // 异常值兜底：每个shot至少0.5秒，最多300秒
        if (dur < 0.5 || dur > 300) {
          dur = (s.script || '').replace(/\s/g, '').length / (3.5 * speechRateVal) || 1;
        }
        console.log(`[mediakit]   镜${s.index}: ${dur.toFixed(1)}s "${(s.script || '').slice(0, 35)}"`);
        ttsResults.push({ buf, dur });
      }

      // ====== Step 2: 拼接WAV音频 ======
      const wavHdr = 44;
      const sr = 24000, ch = 1, bps = 16;
      const totalData = ttsResults.reduce((sum, r) => sum + Math.max(r.buf.length - wavHdr, 0), 0);
      const mergedAudio = Buffer.alloc(wavHdr + totalData);
      mergedAudio.write('RIFF', 0);
      mergedAudio.writeUInt32LE(36 + totalData, 4);
      mergedAudio.write('WAVEfmt ', 8);
      mergedAudio.writeUInt32LE(16, 16);
      mergedAudio.writeUInt16LE(1, 20);
      mergedAudio.writeUInt16LE(ch, 22);
      mergedAudio.writeUInt32LE(sr, 24);
      mergedAudio.writeUInt32LE(sr * ch * (bps / 8), 28);
      mergedAudio.writeUInt16LE(ch * (bps / 8), 32);
      mergedAudio.writeUInt16LE(bps, 34);
      mergedAudio.write('data', 36);
      mergedAudio.writeUInt32LE(totalData, 40);
      let off = wavHdr;
      for (const r of ttsResults) {
        const d = Math.max(r.buf.length - wavHdr, 0);
        if (d > 0) r.buf.copy(mergedAudio, off, wavHdr, wavHdr + d);
        off += d;
      }
      const audioUrl = await uploadToOSS(mergedAudio, `pms/tts/mk_${Date.now()}.wav`, 'audio/wav');

      const shotDurs = ttsResults.map(r => r.dur);
      const totalDuration = shotDurs.reduce((sum, d) => sum + d, 0);
      console.log(`[mediakit] TTS总时长: ${totalDuration.toFixed(1)}s`);

      // ====== Step 3: 视频素材裁剪（尾镜+1s防黑屏，字幕仍按真实TTS时长） ======
      const clipJobs = shots.map((s: any, i: number) => {
        const url = s.media?.[0];
        if (!url) throw new Error(`镜头${s.index}无素材`);
        // 最后一个镜头多加0.8秒，确保视频略长于音频
        const dur = i === shots.length - 1 ? shotDurs[i] + 0.8 : shotDurs[i];
        const isVideo = /\.(mp4|mov|webm|avi|mkv)/i.test(url);
        if (isVideo) return trimVideo(url, dur);
        return imageToVideo([{ url, duration: dur }]);
      });
      const clips = await Promise.all(clipJobs);
      const concat = await concatVideo(clips, transitions?.length > 0 ? transitions : undefined);

      // ====== Step 4: 音视频合成 ======
      const muxed = await muxAudioVideo(concat, audioUrl);

      // ====== Step 5: 字幕压制 — 按标点拆条，时间轴=真实TTS时长 ======
      let finalUrl = muxed;
      if (subtitleConfig) {
        // 去标点：保留标点用于拆分，输出时剔除
        // 去标点但保留小数点
        const stripPunct = (t: string) => t.replace(/[。！？；，、！？,?!;:：\s-]/g, '');
        const splitScript = (text: string): string[] => {
          const clean = (text || '').replace(/\s/g, '');
          if (!clean) return [];
          // 按标点拆分（保留小数点不参与拆分）
          const raw = clean.split(/(?<=[。！？；，、,?!;:：-])/).map(stripPunct).filter(Boolean);
          if (raw.length === 0) return [stripPunct(clean)];
          // 合并过短句
          const merged: string[] = [];
          for (const seg of raw) {
            if (!seg) continue;
            if (merged.length > 0 && (merged[merged.length - 1].length < MIN_LEN || seg.length < MIN_LEN)) {
              merged[merged.length - 1] += seg;
            } else {
              merged.push(seg);
            }
          }
          // 超长句切分
          const result: string[] = [];
          for (const seg of merged) {
            if (seg.length <= MAX_LEN) { result.push(seg); }
            else { for (let i = 0; i < seg.length; i += MAX_LEN) result.push(seg.slice(i, i + MAX_LEN)); }
          }
          return result.length > 0 ? result : [stripPunct(clean)];
        };

        let cursor = 0;
        const subtitles: Array<{ text: string; start: number; end: number }> = [];
        shots.forEach((s: any, i: number) => {
          const shotDur = shotDurs[i];
          const chunks = splitScript(s.script);
          const chunkDur = Math.max(shotDur / chunks.length, MIN_DUR);
          chunks.forEach((text: string) => {
            if (!text) return;
            subtitles.push({ text, start: +cursor.toFixed(1), end: +(cursor + chunkDur).toFixed(1) });
            cursor += chunkDur;
          });
        });
        console.log(`[mediakit] 字幕: ${shots.length}镜 → ${subtitles.length}条`);
        finalUrl = await addSubtitle(muxed, subtitles, subtitleConfig);
      }

      await db.update(pmsBuiBatchJobs)
        .set({ status: 'completed', outputUrls: [finalUrl], updatedAt: new Date() } as any)
        .where(eq(pmsBuiBatchJobs.id, id));
      console.log(`[mediakit] 任务完成: ${id}`);
    } catch (err: any) {
      console.error(`[mediakit] 任务失败: ${id}`, err.message);
      await db.update(pmsBuiBatchJobs)
        .set({ status: 'failed', errorMessage: err.message, updatedAt: new Date() } as any)
        .where(eq(pmsBuiBatchJobs.id, id));
    }
  })();

  return c.json({ success: true, data: { id, status: 'processing' } });
});

// GET /api/mediakit/batch-status/:id — 查询单个任务状态
route.get('/batch-status/:id', async (c) => {
  const id = c.req.param('id');
  const [job] = await db.select().from(pmsBuiBatchJobs)
    .where(eq(pmsBuiBatchJobs.id, id)).limit(1);
  if (!job) return c.json({ success: false, error: '任务不存在' }, 404);
  return c.json({ success: true, data: { status: job.status, outputUrls: job.outputUrls } });
});

// GET /api/mediakit/batch-jobs — 查询任务列表
route.get('/batch-jobs', async (c) => {
  const list = await db.select().from(pmsBuiBatchJobs)
    .where(eq(pmsBuiBatchJobs.merchantId, 'default'))
    .orderBy(desc(pmsBuiBatchJobs.createdAt)).limit(20);
  return c.json({ success: true, data: list });
});

export default route;
