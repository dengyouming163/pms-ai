import { randomUUID } from 'node:crypto';
import { eq, and, inArray, sql } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvNpcJobs, pmsBuiWenlvNpcs, pmsBuiWenlvProducts,
  pmsBuiWenlvCharacters, pmsBuiWenlvCollectibles, pmsBuiWenlvRewards,
  pmsBuiWenlvScenes, pmsBuiWenlvChapters, pmsBuiWenlvScriptRooms, pmsBuiWenlvFlows,
} from '../../../db/schema/index.js';
import type { WenlvNpcPersona, WenlvNpcRelationship } from '../../../db/schema/wenlv.js';
// 0074 节点二元化：节点精修（keep/scene/npc）异步任务，草稿写入 job.result 供前端落库。
import { refineNode } from '../node-refiner/index.js';
// 发布流程阻塞一键疏通（flow_repair）：机械修复 + 孤儿线索 LLM 派挂，事务内自动落库。
import { repairProductFlow } from '../flow-repair/index.js';
import { getScriptRoomByContentId, getScriptRoomChapters, createChapter, createScene, createFlow, updateScene } from '../script-room.js';

const AI_HOST = process.env.PMS_AGENT_HOST || 'localhost';
const AI_PORT = process.env.PMS_AGENT_PORT || '8000';
const CHECK_INTERVAL_MS = 10_000;
const STALE_MINUTES = 5;

export type NpcJobStatus = 'pending' | 'running' | 'succeeded' | 'failed';

/**
 * 原子领取一条 pending job（UPDATE ... RETURNING）。
 *
 * drizzle 的 typed update 不支持 ORDER BY / LIMIT，故用 raw SQL
 * （同 asset-gen/claim.ts 的 claimNextJobs）：子查询选最早的 pending 行，
 * 外层 UPDATE 抢占并 RETURNING id，再按 id 查整行拿 camelCase 映射。
 */
export async function claimNextNpcJob(): Promise<typeof pmsBuiWenlvNpcJobs.$inferSelect | null> {
  const res = await db.execute(sql`
    UPDATE pms_bui_wenlv_npc_jobs
       SET status = 'running', updated_at = now()
     WHERE id = (
       SELECT id FROM pms_bui_wenlv_npc_jobs
        WHERE status = 'pending'
        ORDER BY created_at
        LIMIT 1
        FOR UPDATE SKIP LOCKED
     )
    RETURNING id`);
  const rows = (res as any).rows ?? (res as any);
  const id = rows?.[0]?.id;
  if (!id) return null;
  const [row] = await db.select().from(pmsBuiWenlvNpcJobs)
    .where(eq(pmsBuiWenlvNpcJobs.id, id)).limit(1);
  return row ?? null;
}

/** 超时收口：running 超过 STALE_MINUTES 分钟的重置为 pending。 */
async function reclaimStale(): Promise<void> {
  await db.update(pmsBuiWenlvNpcJobs)
    .set({ status: 'pending', updatedAt: new Date() })
    .where(and(
      eq(pmsBuiWenlvNpcJobs.status, 'running'),
      sql`${pmsBuiWenlvNpcJobs.updatedAt} < now() - interval '1 minute' * ${STALE_MINUTES}`,
    ));
}

/** 调 AI crew refine。stage='npc_setting'（批量）或 'npc_optimize'（单个）。 */
async function callAiCrew(projectId: string, stage: string, instruction: string): Promise<any> {
  const res = await fetch(`http://${AI_HOST}:${AI_PORT}/api/wenlv-creation/refine`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project_id: projectId, stage, instruction }),
    signal: AbortSignal.timeout(180_000),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`AI crew ${res.status}: ${text}`);
  }
  return res.json();
}

/** 删除 product 的所有 NPC（先解绑场景引用）。0079：节点即 scenes。 */
async function deleteAllNpcsOfProduct(productId: string): Promise<void> {
  // scenes 属 chapter→script_room.contentId，用子查询定位该产品的全部场景。
  const chapterIds = db.select({ id: pmsBuiWenlvChapters.id })
    .from(pmsBuiWenlvChapters)
    .innerJoin(pmsBuiWenlvScriptRooms, eq(pmsBuiWenlvChapters.scriptRoomId, pmsBuiWenlvScriptRooms.id))
    .where(eq(pmsBuiWenlvScriptRooms.contentId, productId));
  await db.update(pmsBuiWenlvScenes)
    .set({ npcId: null, npcLineIds: [], updatedAt: new Date() })
    .where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds));
  await db.delete(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, productId));
}

/** 处理一条 job。成功标记 succeeded，失败标记 failed。 */
export async function processNpcJob(job: typeof pmsBuiWenlvNpcJobs.$inferSelect): Promise<void> {
  try {
    if (job.type === 'batch_generate') {
      const data = await callAiCrew(job.productId, 'npc_setting', '');
      const npcsRaw = data?.output?.npcs?.npcs ?? data?.output?.npcs ?? [];
      const npcs = (Array.isArray(npcsRaw) ? npcsRaw : []).filter((n: any) => n && n.id && n.name);
      if (npcs.length === 0) throw new Error('AI 未返回 NPC 数据');

      await deleteAllNpcsOfProduct(job.productId);

      let order = 0;
      await db.transaction(async (tx) => {
        for (const n of npcs) {
          await tx.insert(pmsBuiWenlvNpcs).values({
            id: String(n.id),
            productId: job.productId,
            orderId: order++,
            name: String(n.name),
            role: n.role ?? null,
            description: n.description ?? null,
            portraitPrompt: n.portrait_prompt ?? n.portraitPrompt ?? null,
            voiceId: n.voice_id ?? n.voiceId ?? null,
            characterId: n.character_id ?? n.characterId ?? null,
            lines: Array.isArray(n.lines) ? n.lines : [],
            persona: n.persona ?? {},
            relationships: n.relationships ?? [],
          });
        }
      });

      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: { npcCount: npcs.length, npcNames: npcs.map((n: any) => n.name) }, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));
    } else if (job.type === 'single_optimize') {
      const npcId = job.npcId;
      if (!npcId) throw new Error('single_optimize 缺少 npcId');
      const [existing] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, npcId)).limit(1);
      if (!existing) throw new Error('NPC 不存在');

      const instruction = `请优化 NPC「${existing.name}」（id=${npcId}），全字段重生，含 persona 和 relationships。`;
      const data = await callAiCrew(job.productId, 'npc_optimize', instruction);
      const npcsRaw = data?.output?.npcs?.npcs ?? data?.output?.npcs ?? [];
      const optimized = (Array.isArray(npcsRaw) ? npcsRaw : [])[0];
      if (!optimized || !optimized.name) throw new Error('AI 未返回优化后的 NPC');

      await db.update(pmsBuiWenlvNpcs)
        .set({
          name: String(optimized.name),
          role: optimized.role ?? null,
          description: optimized.description ?? null,
          portraitPrompt: optimized.portrait_prompt ?? optimized.portraitPrompt ?? null,
          voiceId: optimized.voice_id ?? optimized.voiceId ?? null,
          characterId: optimized.character_id ?? optimized.characterId ?? null,
          lines: Array.isArray(optimized.lines) ? optimized.lines : [],
          persona: optimized.persona ?? {},
          // AI crew 的 WenlvNpcRelationship 输出 target_npc_id / relation_type（snake_case），
          // 前端 npc-form 读 targetNpcId / relationType（camelCase），此处做字段名归一。
          relationships: (Array.isArray(optimized.relationships) ? optimized.relationships : []).map((r: any) => ({
            targetNpcId: r.target_npc_id ?? r.targetNpcId ?? '',
            relationType: r.relation_type ?? r.relationType ?? '',
            description: r.description ?? '',
          })),
          updatedAt: new Date(),
        })
        .where(eq(pmsBuiWenlvNpcs.id, npcId));

      // 用 portraitPrompt 调素材流水线生成 NPC 头像并回写 portraitUrl
      // （与 character_optimize 的头像生成同款逻辑，之前 single_optimize 漏了这步导致头像只存了 prompt 没出图）。
      const portraitPrompt = optimized.portrait_prompt ?? optimized.portraitPrompt;
      if (portraitPrompt) {
        try {
          const imgRes = await fetch(`http://${AI_HOST}:${AI_PORT}/api/wenlv-creation/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: portraitPrompt, asset_type: 'avatar' }),
            signal: AbortSignal.timeout(180_000),
          });
          if (imgRes.ok) {
            const imgData = await imgRes.json();
            const portraitUrl = imgData?.data?.url;
            if (portraitUrl) {
              await db.update(pmsBuiWenlvNpcs)
                .set({ portraitUrl, updatedAt: new Date() })
                .where(eq(pmsBuiWenlvNpcs.id, npcId));
            }
          }
        } catch (err) {
          console.warn('[npc-gen-scheduler] npc portrait 生成失败:', err);
        }
      }

      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: { npcName: optimized.name }, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));
    } else if (job.type === 'node_refine') {
      const nodeId = job.nodeId;
      if (!nodeId) throw new Error('node_refine 缺少 nodeId');
      // 入队时参数暂存于 result（{ targetType, linkNpcId }）；完成后被草稿覆盖。
      const params = (job.result ?? {}) as { targetType?: 'keep' | 'scene' | 'npc'; linkNpcId?: string | null };
      const { draft } = await refineNode(job.productId, nodeId, params.targetType ?? 'keep', params.linkNpcId ?? null);
      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: { refine: draft } as any, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));
    } else if (job.type === 'flow_repair') {
      // 产品级流程疏通：机械修复（completed→visited、all 死锁子句松弛）+ 孤儿线索 AI 派挂。
      // 与 node_refine 不同：修复结果在服务端白名单校验后事务内直接落库，无前端采纳步骤；
      // 修改明细（边/节点/结局/派挂/残留）写入 job.result 供任务中心展示。
      const result = await repairProductFlow(job.productId);
      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: result as any, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));
    } else if (job.type === 'character_optimize') {
      const targetId = job.targetId || job.npcId;  // 兼容老字段
      if (!targetId) throw new Error('character_optimize 缺少 targetId');
      const [existing] = await db.select().from(pmsBuiWenlvCharacters)
        .where(eq(pmsBuiWenlvCharacters.id, targetId)).limit(1);
      if (!existing) throw new Error('角色不存在');
      const instruction = `请优化角色「${existing.name}」（single_character_id=${targetId}），全字段重生。`;
      const data = await callAiCrew(job.productId, 'character_optimize', instruction);
      const charsRaw = data?.output?.script?.characters?.characters ?? data?.output?.characters?.characters ?? data?.output?.characters ?? [];
      const optimized = (Array.isArray(charsRaw) ? charsRaw : [])[0];
      if (!optimized || !optimized.name) {
        console.error('[npc-gen-scheduler] character_optimize AI 返回为空，raw output:', JSON.stringify(data?.output).slice(0, 500));
        throw new Error('AI 未返回优化后的角色');
      }
      await db.update(pmsBuiWenlvCharacters).set({
        identity: optimized.identity ?? existing.identity,
        identityDesc: optimized.identity_desc ?? optimized.identityDesc ?? existing.identityDesc,
        ipPrompt: optimized.ip_prompt ?? optimized.ipPrompt ?? existing.ipPrompt,
        faction: optimized.faction ?? existing.faction,
        factionColor: optimized.faction_color ?? optimized.factionColor ?? existing.factionColor,
        vitality: typeof optimized.vitality === 'number' ? optimized.vitality : existing.vitality,
        wisdom: typeof optimized.wisdom === 'number' ? optimized.wisdom : existing.wisdom,
        insight: typeof optimized.insight === 'number' ? optimized.insight : existing.insight,
        skills: Array.isArray(optimized.skills) ? optimized.skills : existing.skills,
        hiddenQuest: optimized.hidden_quest ?? optimized.hiddenQuest ?? existing.hiddenQuest,
        updatedAt: new Date(),
      }).where(eq(pmsBuiWenlvCharacters.id, targetId));
      // 用 ipPrompt 调素材流水线生成头像并回写 avatarUrl
      const ipPromptForAvatar = optimized.ip_prompt ?? optimized.ipPrompt;
      if (ipPromptForAvatar) {
        try {
          const imgRes = await fetch(`http://${AI_HOST}:${AI_PORT}/api/wenlv-creation/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: ipPromptForAvatar, asset_type: 'avatar' }),
            signal: AbortSignal.timeout(180_000),
          });
          if (imgRes.ok) {
            const imgData = await imgRes.json();
            const avatarUrl = imgData?.data?.url;
            if (avatarUrl) {
              await db.update(pmsBuiWenlvCharacters)
                .set({ avatarUrl, updatedAt: new Date() })
                .where(eq(pmsBuiWenlvCharacters.id, targetId));
            }
          }
        } catch (err) {
          console.warn('[ai-gen-scheduler] character avatar 生成失败:', err);
        }
      }
      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: { characterName: optimized.name }, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));

    } else if (job.type === 'skeleton_generate') {
      // instruction 暂存 targetId（节点数/结局数等描述）
      const instruction = job.targetId || '';
      const data = await callAiCrew(job.productId, 'skeleton_generate', instruction);
      const skeleton = data?.skeleton ?? data?.output?.skeleton;
      if (!skeleton?.nodes?.length) throw new Error('AI 未返回剧情骨架');

      // 0079：节点即 scenes（需 chapterId），边即 flows。先找剧本房 + 章节。
      const room = await getScriptRoomByContentId(job.productId);
      if (!room) throw new Error('产品未绑定剧本房，无法生成骨架');
      const chapters = await getScriptRoomChapters(room.id);
      const chapterId = chapters[0]?.id ?? (await createChapter(room.id, { title: '第一章' })).id;

      const validNodeTypes = new Set(['scene', 'npc']);
      const validEdgeTypes = new Set(['auto', 'choice', 'puzzle_pass', 'puzzle_fail']);
      const nodeIds = new Set(skeleton.nodes.map((n: any) => n.id));

      // 结构校验
      for (const n of skeleton.nodes) {
        if (!validNodeTypes.has(n.nodeType)) throw new Error(`节点 ${n.id} 类型非法: ${n.nodeType}`);
      }
      const edges = Array.isArray(skeleton.edges) ? skeleton.edges : [];
      for (const e of edges) {
        if (!nodeIds.has(e.from_node_id)) throw new Error(`边起点不存在: ${e.from_node_id}`);
        if (!nodeIds.has(e.to_node_id)) throw new Error(`边终点不存在: ${e.to_node_id}`);
      }

      // 批量创建场景 + 流转（事务）。scene.type：'scene'→'narrative'，'npc'→'npc'。
      const idMap = new Map<string, string>();
      await db.transaction(async (tx) => {
        for (let i = 0; i < skeleton.nodes.length; i++) {
          const sn = skeleton.nodes[i];
          const sceneType = sn.nodeType === 'npc' ? 'npc' : 'narrative';
          const [scene] = await tx.insert(pmsBuiWenlvScenes).values({
            id: `node_${randomUUID()}`,
            chapterId,
            title: sn.title || `节点 ${i + 1}`,
            type: sceneType,
            content: sn.brief || '',
            order: i,
            grants: [],
            requires: null,
          }).returning();
          idMap.set(sn.id, scene.id);
        }
        for (let i = 0; i < edges.length; i++) {
          const se = edges[i];
          const fromId = idMap.get(se.from_node_id);
          const toId = idMap.get(se.to_node_id);
          if (!fromId || !toId) continue;
          const edgeType = validEdgeTypes.has(se.edge_type) ? se.edge_type : 'auto';
          await tx.insert(pmsBuiWenlvFlows).values({
            id: `flow_${randomUUID()}`,
            fromSceneId: fromId,
            toSceneId: toId,
            type: edgeType,
            choiceText: se.label || null,
            grants: [],
            sanDelta: 0,
            sortOrder: i,
          });
        }
      });

      await db.update(pmsBuiWenlvNpcJobs)
        .set({
          status: 'succeeded',
          result: { nodeCount: skeleton.nodes.length, edgeCount: edges.length },
          updatedAt: new Date(),
        })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));

    } else if (job.type === 'collectible_image') {
      const targetId = job.targetId;
      if (!targetId) throw new Error('collectible_image 缺少 targetId');
      const [existing] = await db.select().from(pmsBuiWenlvCollectibles)
        .where(eq(pmsBuiWenlvCollectibles.id, targetId)).limit(1);
      if (!existing) throw new Error('线索不存在');
      const instruction = `collectibleId=${targetId}`;
      const data = await callAiCrew(job.productId, 'collectible_image', instruction);
      const imagePrompt = data?.image_prompt ?? data?.output?.image_prompt;
      if (!imagePrompt) throw new Error('AI 未返回 image_prompt');
      // 调素材流水线生成图鉴图
      const imgRes = await fetch(`http://${AI_HOST}:${AI_PORT}/api/wenlv-creation/generate-image`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt: imagePrompt, asset_type: 'collectible_image' }),
        signal: AbortSignal.timeout(180_000),
      });
      if (!imgRes.ok) throw new Error(`素材生成失败: ${imgRes.status}`);
      const imgData = await imgRes.json();
      const imageUrl = imgData?.data?.url;
      if (!imageUrl) throw new Error('素材未返回 url');
      await db.update(pmsBuiWenlvCollectibles)
        .set({ image: imageUrl, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvCollectibles.id, targetId));
      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: { imageUrl }, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));

    } else if (job.type === 'ending_optimize') {
      const targetId = job.targetId;
      if (!targetId) throw new Error('ending_optimize 缺少 targetId');
      // 0079：结局即 scenes（type='ending'）。
      const [existing] = await db.select().from(pmsBuiWenlvScenes)
        .where(eq(pmsBuiWenlvScenes.id, targetId)).limit(1);
      if (!existing) throw new Error('结局不存在');
      const instruction = `endingId=${targetId}`;
      const data = await callAiCrew(job.productId, 'ending_optimize', instruction);
      const e = data?.output?.script?.endings?.endings?.[0] ?? data?.output?.endings?.endings?.[0] ?? data?.output?.endings?.[0];
      if (!e?.title) throw new Error('AI 未返回结局数据');
      await updateScene(targetId, {
        title: String(e.title),
        content: e.text ?? existing.content,
        // triggerCondition 是 jsonb WenlvCondition，AI 输出的 condition_hint 是字符串，不能直接写
        // 这里保留 existing.triggerCondition（不覆盖），让前端编辑器单独处理条件转换
        priority: typeof e.priority === 'number' ? e.priority : existing.priority,
      });
      // 如有 ending_image_prompt，生成结局图
      const endingImagePrompt = data?.ending_image_prompt ?? data?.output?.ending_image_prompt;
      if (endingImagePrompt) {
        try {
          const imgRes = await fetch(`http://${AI_HOST}:${AI_PORT}/api/wenlv-creation/generate-image`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ prompt: endingImagePrompt, asset_type: 'ending_image' }),
            signal: AbortSignal.timeout(180_000),
          });
          if (imgRes.ok) {
            const imgData = await imgRes.json();
            if (imgData?.data?.url) {
              await updateScene(targetId, { image: imgData.data.url });
            }
          }
        } catch (err) {
          console.warn('[ai-gen-scheduler] ending image 生成失败:', err);
        }
      }
      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: { endingTitle: e.title }, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));

    } else if (job.type === 'reward_batch') {
      const data = await callAiCrew(job.productId, 'reward_batch', '');
      const rewardsRaw = data?.rewards?.rewards ?? data?.output?.rewards?.rewards ?? data?.output?.rewards ?? [];
      const rewards = (Array.isArray(rewardsRaw) ? rewardsRaw : []).filter((r: any) => r && r.name);
      if (rewards.length === 0) throw new Error('AI 未返回奖励数据');
      await db.transaction(async (tx) => {
        for (const r of rewards) {
          await tx.insert(pmsBuiWenlvRewards).values({
            id: `rw_${randomUUID()}`,
            productId: job.productId,
            name: String(r.name),
            type: r.type ?? 'coupon',
            value: r.value ?? null,
            description: r.description ?? null,
          });
        }
      });
      await db.update(pmsBuiWenlvNpcJobs)
        .set({ status: 'succeeded', result: { count: rewards.length }, updatedAt: new Date() })
        .where(eq(pmsBuiWenlvNpcJobs.id, job.id));
    }
  } catch (e: any) {
    await db.update(pmsBuiWenlvNpcJobs)
      .set({ status: 'failed', error: String(e?.message ?? e), updatedAt: new Date() })
      .where(eq(pmsBuiWenlvNpcJobs.id, job.id));
  }
}

let running = false;
async function tick(): Promise<void> {
  if (running) return;
  running = true;
  try {
    await reclaimStale();
    let job = await claimNextNpcJob();
    while (job) {
      await processNpcJob(job);
      job = await claimNextNpcJob();
    }
  } catch (e) {
    console.error('[npc-gen-scheduler] tick error:', e);
  } finally {
    running = false;
  }
}

export function startNpcGenScheduler(): void {
  setInterval(tick, CHECK_INTERVAL_MS);
}
