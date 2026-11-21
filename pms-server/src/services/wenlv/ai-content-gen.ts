/**
 * ai-content-gen.ts - AI 内容生成（轻量代理，调用 AI Crew）。
 *
 * 重构说明（设计文档 §2.3）：
 * - 移除直调 DashScope 代码，改为通过调度器异步任务调用 AI Crew
 * - 各代理函数只负责创建异步任务（npc_jobs），生成由调度器完成
 * - 新增 generateCollectibleImage/optimizeCharacter/optimizeEnding/batchGenerateRewards
 */
import { randomUUID } from 'node:crypto';
import { db } from '../../db/index.js';
import { pmsBuiWenlvNpcJobs } from '../../db/schema/index.js';
import type { WenlvAiJobType, WenlvAiJobTargetType } from '../../db/schema/wenlv.js';

/** 创建异步 AI 任务。 */
export async function createAiJob(params: {
  productId: string;
  type: WenlvAiJobType;
  targetType?: WenlvAiJobTargetType;
  targetId?: string;
  stage?: string;
}): Promise<string> {
  const id = `job_${randomUUID()}`;
  await db.insert(pmsBuiWenlvNpcJobs).values({
    id,
    productId: params.productId,
    npcId: params.targetType === 'npc' ? params.targetId : null,
    nodeId: params.targetType === 'node' ? params.targetId : null,
    targetType: params.targetType ?? null,
    targetId: params.targetId ?? null,
    stage: params.stage ?? null,
    type: params.type,
    status: 'pending',
  });
  return id;
}

/** 创建线索图鉴图生成任务。 */
export async function generateCollectibleImage(productId: string, collectibleId: string): Promise<string> {
  return createAiJob({
    productId, type: 'collectible_image',
    targetType: 'collectible', targetId: collectibleId, stage: 'collectible_image',
  });
}

/** 创建角色优化任务。 */
export async function optimizeCharacter(productId: string, characterId: string): Promise<string> {
  return createAiJob({
    productId, type: 'character_optimize',
    targetType: 'character', targetId: characterId, stage: 'character_optimize',
  });
}

/** 创建结局优化任务。 */
export async function optimizeEnding(productId: string, endingId: string): Promise<string> {
  return createAiJob({
    productId, type: 'ending_optimize',
    targetType: 'ending', targetId: endingId, stage: 'ending_optimize',
  });
}

/** 创建批量奖励生成任务。 */
export async function batchGenerateRewards(productId: string): Promise<string> {
  return createAiJob({
    productId, type: 'reward_batch', stage: 'reward_batch',
  });
}

/** 创建剧情骨架生成任务。instruction（节点数/结局数等描述）暂存 targetId 字段，scheduler 读取。 */
export async function generateSkeleton(productId: string, instruction: string): Promise<string> {
  return createAiJob({
    productId, type: 'skeleton_generate', stage: 'skeleton_generate',
    targetId: instruction || undefined,
  });
}
