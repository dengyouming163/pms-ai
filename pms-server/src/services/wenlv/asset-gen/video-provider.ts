/**
 * 文生视频 provider（P2-C）：字节 Seedance（火山方舟）。
 *
 * 用于 AR 显影灵体素材：生成纯黑背景的视频，配合前端 screen 混合模式实现透明叠加。
 *
 * **契约是同步的**（与 image-provider 一致）：resolve 即素材就绪。
 * Seedance 视频生成本身是异步任务 API（/contents/generations/tasks），
 * 由 provider 内部轮询消化，不让复杂性漏进调度器。
 */

export type VideoGenResult = { url: string; provider: string; model: string };

export type VideoGenOptions = {
  /** 时长（秒），默认 5 */
  duration?: number;
  /** 分辨率：'480p' | '720p'，默认 720p */
  resolution?: '480p' | '720p';
  /** 宽高比，默认 '16:9' */
  ratio?: '16:9' | '9:16' | '1:1';
};

export interface VideoProvider {
  readonly name: string;
  generate(prompt: string, opts?: VideoGenOptions): Promise<VideoGenResult>;
}

/**
 * Seedance 视频生成 provider。
 *
 * 流程：
 * 1. 提交生成任务（POST /contents/generations/tasks）
 * 2. 轮询任务状态（GET /contents/generations/tasks/{id}）直到 succeeded
 * 3. 返回视频 URL
 *
 * prompt 强制要求"纯黑色背景"，以配合前端 screen 混合模式。
 */
export class SeedanceVideoProvider implements VideoProvider {
  readonly name = 'seedance';
  private readonly apiKey: string;
  private readonly baseUrl = 'https://ark.cn-beijing.volces.com/api/v3';
  private readonly model = 'doubao-seedance-1-0-pro-250528';
  private readonly pollIntervalMs = 5000;
  private readonly pollTimeoutMs = 300_000; // 5 分钟超时

  constructor(apiKey?: string) {
    this.apiKey = apiKey || process.env.SEEDANCE_API_KEY || process.env.ARK_API_KEY || '';
  }

  async generate(prompt: string, opts?: VideoGenOptions): Promise<VideoGenResult> {
    if (!this.apiKey) {
      throw new Error('Seedance API key 未配置（SEEDANCE_API_KEY / ARK_API_KEY）');
    }

    const duration = opts?.duration ?? 5;
    const resolution = opts?.resolution ?? '720p';
    const ratio = opts?.ratio ?? '16:9';

    // 强制黑底：AR 显影素材必须是纯黑背景，前端用 screen 混合变透明
    const enforcedPrompt = `${prompt}\n\n要求：纯黑色背景，主体居中，无任何文字或水印。`;

    // 1. 提交任务
    const taskId = await this.submitTask(enforcedPrompt, { duration, resolution, ratio });

    // 2. 轮询结果
    const url = await this.pollTask(taskId);

    return { url, provider: this.name, model: this.model };
  }

  private async submitTask(prompt: string, opts: { duration: number; resolution: string; ratio: string }): Promise<string> {
    const res = await fetch(`${this.baseUrl}/contents/generations/tasks`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        content: [{ type: 'text', text: prompt }],
        generate_config: {
          duration: opts.duration,
          resolution: opts.resolution,
          aspect_ratio: opts.ratio,
        },
      }),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Seedance 任务提交失败: ${res.status} ${err}`);
    }

    const data = await res.json();
    const taskId = data?.id;
    if (!taskId) throw new Error('Seedance 响应缺少任务 ID');
    return taskId;
  }

  private async pollTask(taskId: string): Promise<string> {
    const start = Date.now();
    while (Date.now() - start < this.pollTimeoutMs) {
      const res = await fetch(`${this.baseUrl}/contents/generations/tasks/${taskId}`, {
        headers: { Authorization: `Bearer ${this.apiKey}` },
      });
      if (!res.ok) {
        await new Promise((r) => setTimeout(r, this.pollIntervalMs));
        continue;
      }
      const data = await res.json();
      const status = data?.status;
      if (status === 'succeeded') {
        const url = data?.content?.[0]?.video_url || data?.output?.video_url;
        if (!url) throw new Error('Seedance 任务成功但无视频 URL');
        return url;
      }
      if (status === 'failed') {
        throw new Error(`Seedance 任务失败: ${data?.error?.message || '未知错误'}`);
      }
      // pending / running → 继续轮询
      await new Promise((r) => setTimeout(r, this.pollIntervalMs));
    }
    throw new Error('Seedance 任务轮询超时（5 分钟）');
  }
}

/** 默认实例（惰性） */
let _defaultProvider: VideoProvider | null = null;

/** 占位 provider：无 key 时的回退，与 image-provider 的 MockImageProvider 同口径。
 *  产物是占位 URL，**不静默**（spec §8）—— model 标 'mock'，pricing 记账 ¥0。 */
export class MockVideoProvider implements VideoProvider {
  readonly name = 'mock';
  async generate(prompt: string, opts?: VideoGenOptions): Promise<VideoGenResult> {
    const q = encodeURIComponent(prompt.slice(0, 32));
    const res = opts?.resolution ?? '720p';
    const dur = opts?.duration ?? 5;
    // 占位 URL 带参数，一眼能看出是 mock 产物，不会被误当真实视频。
    return {
      url: `https://placeholder.local/ar?mock=1&q=${q}&res=${res}&dur=${dur}`,
      provider: 'mock',
      model: 'mock',
    };
  }
}

/** 按 env 选择 provider；未配置时回落 mock（与 getImageProvider 同口径）。 */
export function getVideoProvider(): VideoProvider {
  if (_defaultProvider) return _defaultProvider;
  const raw = process.env.WENLV_VIDEO_PROVIDER;
  const name = (raw ?? '').trim().toLowerCase();
  if (name === 'seedance' || name === 'ark') {
    _defaultProvider = new SeedanceVideoProvider();
  } else if (name === '' || name === 'mock') {
    _defaultProvider = new MockVideoProvider();
  } else {
    // 非空但不认识 → 一定是拼错了。必须出声：静默用 mock 等于「以为生成了真视频，实际是占位且没花钱」。
    console.warn(`[wenlv-asset-gen] 未识别的 WENLV_VIDEO_PROVIDER「${raw}」，已回落 mock（不产生真实视频、记账 ¥0）`);
    _defaultProvider = new MockVideoProvider();
  }
  return _defaultProvider;
}
