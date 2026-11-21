/**
 * AR 素材黑底质检（P2-C）。
 *
 * AR 显影素材必须是**纯黑背景**，前端用 `mix-blend-mode: screen` 把黑底变透明。
 * 本服务用 ffmpeg `blackdetect` 滤镜检测视频中黑色画面的时长占比。
 *
 * 阈值：黑色像素占比 ≥ 70% 判定为合格（黑底足够纯净，screen 混合后残留少）。
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import ffmpegPath from 'ffmpeg-static';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const execFileAsync = promisify(execFile);

export interface BlackCheckResult {
  /** 是否通过质检（黑底占比 ≥ 阈值） */
  passed: boolean;
  /** 黑色时长占总时长的比例（0~1） */
  blackRatio: number;
  /** 视频总时长（秒） */
  duration: number;
  /** 检测到的黑色片段总时长（秒） */
  blackDuration: number;
}

/**
 * 检测视频黑底占比。
 *
 * @param videoUrl 视频 URL（http/https 或本地路径）
 * @param threshold 合格阈值（0~1），默认 0.7
 * @param pixelThreshold 像素阈值（0~1），低于此亮度视为黑色，默认 0.10
 */
export async function checkBlackBackground(
  videoUrl: string,
  threshold = 0.7,
  pixelThreshold = 0.10,
): Promise<BlackCheckResult> {
  // mock 占位素材（placeholder.local）跳过真实质检，直接视为通过 ——
  // 与 image-provider 的 mock 不进 LLM 评审同口径：mock 没向上游付费，产物是占位，
  // 让它走 ffmpeg 只会因下载失败而误判 failed。
  if (videoUrl.startsWith('https://placeholder.local')) {
    return { passed: true, blackRatio: 1, duration: 0, blackDuration: 0 };
  }

  // 1. 下载视频到临时文件（ffmpeg blackdetect 需要本地文件或支持流式读取）
  const tmpFile = path.join(os.tmpdir(), `ar-check-${Date.now()}.mp4`);
  try {
    if (videoUrl.startsWith('http')) {
      const res = await fetch(videoUrl);
      if (!res.ok) throw new Error(`下载视频失败: ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      fs.writeFileSync(tmpFile, buf);
    } else {
      // 本地文件直接用
      fs.copyFileSync(videoUrl, tmpFile);
    }

    // 2. 用 ffprobe 获取总时长
    const duration = await getDuration(tmpFile);
    if (duration <= 0) {
      return { passed: false, blackRatio: 0, duration: 0, blackDuration: 0 };
    }

    // 3. 用 ffmpeg blackdetect 检测黑色片段
    const blackDuration = await detectBlackDuration(tmpFile, pixelThreshold);
    const blackRatio = blackDuration / duration;

    return {
      passed: blackRatio >= threshold,
      blackRatio,
      duration,
      blackDuration,
    };
  } finally {
    try { fs.unlinkSync(tmpFile); } catch { /* ignore */ }
  }
}

/** 获取视频时长（秒） */
async function getDuration(file: string): Promise<number> {
  const ffprobePath = (ffmpegPath || '').replace('ffmpeg', 'ffprobe');
  try {
    const { stdout } = await execFileAsync(ffprobePath, [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      file,
    ]);
    return parseFloat(stdout.trim()) || 0;
  } catch {
    return 0;
  }
}

/** 用 ffmpeg blackdetect 检测黑色片段总时长 */
async function detectBlackDuration(file: string, pixelThreshold: number): Promise<number> {
  if (!ffmpegPath) return 0;
  try {
    // blackdetect 输出到 stderr，格式：
    // [blackdetect @ 0x...] black_start:0.000000 black_end:2.500000 black_duration:2.500000
    const { stderr } = await execFileAsync(ffmpegPath, [
      '-i', file,
      '-vf', `blackdetect=d=0.1:pix_th=${pixelThreshold}`,
      '-an',
      '-f', 'null',
      '-',
    ], { maxBuffer: 10 * 1024 * 1024 });

    // 提取所有 black_duration 值并求和
    const durations = stderr
      .split('\n')
      .filter((l) => l.includes('black_duration'))
      .map((l) => {
        const m = l.match(/black_duration:([\d.]+)/);
        return m ? parseFloat(m[1]) : 0;
      });

    return durations.reduce((a, b) => a + b, 0);
  } catch {
    return 0;
  }
}
