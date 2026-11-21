/**
 * 结局档案海报生成器。
 *
 * 复用 image-provider.ts 的 ImageProvider（与场地背景/锚图同链路），
 * 不为海报另起一条生成通道。assetType='ending-poster' 仅用于计费/日志区分，
 * 不影响上游模型 —— 模型只看 prompt。
 *
 * 设计取舍：prompt 直拼，不调 LLM 二次润色。
 *  - 收益：少一次 LLM 调用（约 ¥0.002）+ 链路简单 + 失败点少
 *  - 代价：文案不如 LLM 润色灵活
 *  - 选直拼：结局海报是「氛围 > 文案」的产物，且 ending.text 已是 LLM 生成的成品，
 *    再润色一次的边际收益小于稳定性收益
 *
 * 异步语义：调用方应**不阻塞**主流程（海报写入失败不应让通关失败）。
 * 见 wenlv-dialogue.ts completeNode 分支的 .then(...).catch(() => {}) 用法。
 */
import { getImageProvider, type GenResult } from './image-provider.js';
import type { SanEnding } from '../san-service.js';

export interface PosterGenParams {
  endingTitle: string;
  endingText: string;
  productName: string;
  sanLevel: SanEnding;
  playerAlias?: string;
  collectedCount: number;
}

/**
 * 生成结局档案海报。返回图片 URL（写回 pmsBuiWenlvScenes.image，type='ending'）。
 * 失败抛错 —— 由调用方 catch（不阻塞 SSE 通关流）。
 */
export async function generateEndingPoster(params: PosterGenParams): Promise<string> {
  const provider = getImageProvider();

  const moodMap: Record<SanEnding, string> = {
    good: '温暖金色光芒，破晓晨曦穿透云层',
    normal: '朦胧月光，薄雾笼罩古巷',
    bad: '阴暗雨夜，破碎倒影映在湿石板',
  };
  const mood = moodMap[params.sanLevel];

  const prompt = [
    `剧本杀结局档案海报：${params.endingTitle}`,
    `场景氛围：${mood}`,
    `剧本：${params.productName}`,
    params.playerAlias ? `玩家：${params.playerAlias}` : '',
    `收集证物：${params.collectedCount} 件`,
    '',
    '要求：电影级构图，竖版海报，底部留白用于叠加文字，不要出现具体人脸，氛围感优先于细节。',
    '风格：东方悬疑、水墨与光影混合、高级灰调，色温随结局情绪。',
  ].filter(Boolean).join('\n');

  const result: GenResult = await provider.generate(prompt, {
    assetType: 'ending-poster',
    candidates: 1,
  });
  return result.urls[0];
}
