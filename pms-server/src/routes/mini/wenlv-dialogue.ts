import { Hono } from 'hono';
import { randomUUID } from 'node:crypto';
import { db } from '../../db/index.js';
import { pmsBuiWenlvNpcs, pmsBuiWenlvDialogues, pmsBuiWenlvTeams, pmsBuiWenlvPlayerProgress, pmsBuiWenlvProgress, pmsBuiWenlvCollectibles, pmsBuiWenlvProducts } from '../../db/schema/index.js';
import { eq, and, inArray } from 'drizzle-orm';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { streamNpcReply } from '../../services/wenlv/npc-dialogue/llm-client.js';
import { checkGoalReached, computeHitIndices, evaluateCriteriaWithLLM, normalizeCriteria } from '../../services/wenlv/npc-dialogue/goal-checker.js';
import { evaluateMove, type MoveVerdict } from '../../services/wenlv/npc-dialogue/attitude-evaluator.js';
import { generateVisualAnchors, type VisualAnchor } from '../../services/wenlv/npc-dialogue/visual-anchor.js';
import { summarizeMemory } from '../../services/wenlv/npc-dialogue/memory-summarizer.js';
import { drainMentions, queueMention } from '../../services/wenlv/npc-dialogue/mention-broker.js';
import { recordStatement, detectContradictions, clearStatements } from '../../services/wenlv/npc-dialogue/lie-tracker.js';
import { desensitizeCriteria } from '../../services/wenlv/npc-dialogue/criteria-mask.js';
import type { WenlvNpcPersona, WenlvState } from '../../db/schema/wenlv.js';
import { selectEnding } from '../../services/wenlv-engine.js';
import { getEndingBySan } from '../../services/wenlv/san-service.js';
import { generateEndingPoster } from '../../services/wenlv/asset-gen/poster-gen.js';
import { traverseEdges } from '../../services/wenlv/graph-traversal.js';
// 0079：对话运行时全切规范图投影——node=非 ending 场景投影（nodeId=scene.id）、
// NPC 取 graph.npcs、结局取 runtime.endings；海报回写走 scene（updateScene），旧 nodes/endings 表零读写。
import { loadRuntimeGraph, updateScene } from '../../services/wenlv/script-room.js';
import { isNpcDrivenNode } from '../../services/wenlv/node-model.js';
import { mapNpcVoiceToDashScope } from '../../services/wenlv/asset-gen/tts-provider.js';
import { synthesizeSpeech } from '../../services/aliyun/voice.js';
import { uploadToOSS } from '../../services/aliyun/oss.js';

const route = new Hono();

/**
 * 合并两套证物状态为统一的 clueId 列表：
 * - collectedCollectibles：通过 /trigger/report 扫码收集的独立证物
 * - state.collected：通过节点 effects.grant 发放的证物
 * NPC 对话的 clueIds 判定与 discoveredClues 需同时覆盖两者，否则节点发放的证物对对话不可见。
 */
function getCollectedClueIds(progress: { collectedCollectibles?: string[] | null; state?: WenlvState | null } | null | undefined): string[] {
  const fromCollectibles = progress?.collectedCollectibles || [];
  const fromState = Object.keys(progress?.state?.collected || {});
  return Array.from(new Set([...fromCollectibles, ...fromState]));
}

const EMPTY_PERSONA: WenlvNpcPersona = {};

// 提示级别缓存：dialogueId -> criteriaIndex -> level (1/2/3)
// 仅内存存储，重启丢失可接受（提示是临时辅助）
const hintLevelCache = new Map<string, Map<number, number>>();

// DM 三态引导引擎：按 dialogueId 维度缓存命中集、卡关轮次、态度档位
const STAGGER_LIMIT = Number(process.env.WENLV_DM_STAGGER_LIMIT || 3);
const engineHitCache = new Map<string, Set<number>>();
const engineStallCache = new Map<string, number>();
const engineAttitudeCache = new Map<string, 1 | 2 | 3>();
// Task 7：emotive-persuade 情感意图分（0-100），与态度档同节奏每 3 轮评一次，缓存最新一档供每轮 progress/completed 事件透传。
const engineEmotiveCache = new Map<string, number>();

// POST /api/mini/wenlv/dialogue/start — 创建对话，返回开场白
// 团队模式（传 teamId）：按 (teamId, nodeId) get-or-create 共享对话，所有队员复用同一条记录。
// 单人模式（不传 teamId）：每次新建一条对话。
route.post('/start', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const { productId, nodeId, characterId, teamId } = await c.req.json();
  if (!productId || !nodeId) return c.json({ success: false, error: '缺少 productId 或 nodeId' }, 400);

  // 0079：NPC 节点 = type='npc' 的场景（nodeId=scene.id），从运行时规范图投影取；
  // 必须是 npc 驱动模式（二元 nodeType==='npc' 且绑了 npcId、配了 chapterGoal）。
  const runtime = await loadRuntimeGraph(productId);
  const node = runtime.nodes.find((n) => n.id === nodeId);
  if (!node) return c.json({ success: false, error: '节点不存在' }, 404);
  if (!isNpcDrivenNode(node)) return c.json({ success: false, error: '该节点不是 NPC 驱动模式' }, 400);

  // 查 NPC（随规范图装配的全行 NPC）
  const npc = runtime.graph?.npcs.find((n) => n.id === node.npcId);
  if (!npc) return c.json({ success: false, error: 'NPC 不存在' }, 404);

  // 查询玩家进度（实体优先：扫码/信标解锁的线索注入对话）
  const [playerProgress] = await db.select().from(pmsBuiWenlvPlayerProgress)
    .where(and(
      eq(pmsBuiWenlvPlayerProgress.productId, productId),
      eq(pmsBuiWenlvPlayerProgress.miniUserId, auth.miniUserId),
    ))
    .limit(1);

  // 同时取主进度表的 state.collected（节点 effects.grant 发放的证物）
  const [mainProgress] = await db.select({ state: pmsBuiWenlvProgress.state }).from(pmsBuiWenlvProgress)
    .where(and(
      eq(pmsBuiWenlvProgress.productId, productId),
      eq(pmsBuiWenlvProgress.miniUserId, auth.miniUserId),
    ))
    .limit(1);

  // 收集的线索文本（从 collectibles 表查名称）—— 合并 state.collected 与 collectedCollectibles
  let discoveredClues: string[] = [];
  const collectedClueIds = getCollectedClueIds({
    collectedCollectibles: playerProgress?.collectedCollectibles,
    state: mainProgress?.state as WenlvState | null,
  });
  if (collectedClueIds.length) {
    const collectibles = await db.select({ name: pmsBuiWenlvCollectibles.name })
      .from(pmsBuiWenlvCollectibles)
      .where(inArray(pmsBuiWenlvCollectibles.id, collectedClueIds));
    discoveredClues = collectibles.map((c) => c.name).filter(Boolean);
  }

  // 团队模式：get-or-create 共享对话
  if (teamId) {
    // 校验队员身份
    const [team] = await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);
    const isMember = team.members?.some((m) => m.userId === auth.miniUserId);
    if (!isMember) return c.json({ success: false, error: '你不是该队伍成员' }, 403);

    // 按 (teamId, nodeId) 查已有对话
    const [existing] = await db.select().from(pmsBuiWenlvDialogues)
      .where(and(eq(pmsBuiWenlvDialogues.teamId, teamId), eq(pmsBuiWenlvDialogues.nodeId, nodeId)))
      .limit(1);
    if (existing && existing.status === 'active') {
      return c.json({
        success: true,
        data: {
          dialogueId: existing.id,
          openingLine: existing.messages[0]?.content || '',
          messages: existing.messages,
          npc: { id: npc.id, name: npc.name, portraitUrl: npc.portraitUrl, voiceId: npc.voiceId },
          teamMode: true,
        },
      });
    }
  }

  // 开场白：优先用预设，否则 LLM 生成一句（单人模式或团队首次进入）
  let openingLine = node.openingLine || '';
  if (!openingLine) {
    // 模块 B：在 NPC 出场前，把它 pending_mentions 队列里其他 NPC 提到它的内容取出来注入 prompt
    const pendingMentions = await drainMentions(npc.id);
    // Task 6：读剧本调音（family 亲子模式等），注入 system prompt。
    // 只 select config 单列，$type 已收窄为 WenlvProductConfig，tuneMode 缺键 = undefined（消费侧按 standard）。
    const [productRow] = await db.select({ config: pmsBuiWenlvProducts.config })
      .from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, productId))
      .limit(1);
    const tuneMode = productRow?.config?.tuneMode;
    const chunks: string[] = [];
    for await (const chunk of streamNpcReply({
      messages: [],
      persona: npc.persona || EMPTY_PERSONA,
      goal: node.chapterGoal,
      npcName: npc.name,
      npcRole: npc.role || '',
      npcMemory: npc.memory || undefined,
      relationships: npc.relationships || [],
      pendingMentions,
      visualAnchors: [],
      criteriaHints: node.chapterGoal?.criteriaHints,
      attitudeLevel: undefined,
      discoveredClues,
      tuneMode,
    })) {
      if (chunk.type === 'text') chunks.push(chunk.delta);
    }
    openingLine = chunks.join('');
  }

  // 生成视觉锚点：基于节点场景图，为每条通关条件找到画面里可指给玩家看的元素。
  // 失败静默降级（不阻塞对话创建）。
  let visualAnchors: VisualAnchor[] = [];
  if (node.image) {
    try {
      visualAnchors = await generateVisualAnchors(node, node.chapterGoal);
    } catch { /* 视觉失败静默降级 */ }
  }

  // 创建对话记录
  const dialogueId = randomUUID();
  await db.insert(pmsBuiWenlvDialogues).values({
    id: dialogueId,
    productId,
    nodeId,
    npcId: node.npcId,
    miniUserId: auth.miniUserId,
    characterId: characterId || null,
    teamId: teamId || null,
    messages: [{ role: 'assistant', content: openingLine, ts: Date.now() }],
    status: 'active',
    visualAnchors,
  });

  return c.json({
    success: true,
    data: {
      dialogueId,
      openingLine,
      npc: { id: npc.id, name: npc.name, portraitUrl: npc.portraitUrl, voiceId: npc.voiceId },
      teamMode: !!teamId,
    },
  });
});

// POST /api/mini/wenlv/dialogue/:id/message — 玩家发消息，SSE 流式返回 NPC 回复
route.post('/:id/message', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const dialogueId = c.req.param('id');
  const { text } = await c.req.json();
  if (!text) return c.json({ success: false, error: '缺少 text' }, 400);

  // 查对话
  const [dialogue] = await db.select().from(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.id, dialogueId)).limit(1);
  if (!dialogue) return c.json({ success: false, error: '对话不存在' }, 404);
  if (dialogue.status !== 'active') return c.json({ success: false, error: '对话已结束' }, 400);
  // 团队模式：任何队员可发消息；单人模式：仅本人
  if (dialogue.teamId) {
    const [team] = await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, dialogue.teamId)).limit(1);
    const isMember = team?.members?.some((m) => m.userId === auth.miniUserId);
    if (!isMember) return c.json({ success: false, error: '你不是该队伍成员' }, 403);
  } else if (dialogue.miniUserId !== auth.miniUserId) {
    return c.json({ success: false, error: '无权操作' }, 403);
  }

  // 查询玩家进度（实体优先：扫码/信标解锁的线索注入对话）
  const [playerProgress] = await db.select().from(pmsBuiWenlvPlayerProgress)
    .where(and(
      eq(pmsBuiWenlvPlayerProgress.productId, dialogue.productId),
      eq(pmsBuiWenlvPlayerProgress.miniUserId, auth.miniUserId),
    ))
    .limit(1);

  // 同时取主进度表的 state.collected（节点 effects.grant 发放的证物）
  const [mainProgress] = await db.select({ state: pmsBuiWenlvProgress.state }).from(pmsBuiWenlvProgress)
    .where(and(
      eq(pmsBuiWenlvProgress.productId, dialogue.productId),
      eq(pmsBuiWenlvProgress.miniUserId, auth.miniUserId),
    ))
    .limit(1);

  // 收集的线索文本（从 collectibles 表查名称）—— 合并 state.collected 与 collectedCollectibles
  let discoveredClues: string[] = [];
  const collectedClueIds = getCollectedClueIds({
    collectedCollectibles: playerProgress?.collectedCollectibles,
    state: mainProgress?.state as WenlvState | null,
  });
  if (collectedClueIds.length) {
    const collectibles = await db.select({ name: pmsBuiWenlvCollectibles.name })
      .from(pmsBuiWenlvCollectibles)
      .where(inArray(pmsBuiWenlvCollectibles.id, collectedClueIds));
    discoveredClues = collectibles.map((c) => c.name).filter(Boolean);
  }

  // 0079：节点/NPC/边/结局一次装配复用全处理器（node=非 ending 场景投影，nodeId=scene.id）。
  const runtime = await loadRuntimeGraph(dialogue.productId);
  const node = runtime.nodes.find((n) => n.id === dialogue.nodeId);
  const npc = runtime.graph?.npcs.find((n) => n.id === dialogue.npcId);
  if (!node || !npc || !node.chapterGoal) return c.json({ success: false, error: '配置不完整' }, 500);

  // Task 6（演员升级①）：剧本调音（product.config.tuneMode），一次读取供本轮全部 streamNpcReply 复用。
  // 只 select config 单列，$type 已收窄为 WenlvProductConfig，tuneMode 缺键 = undefined（消费侧按 standard）。
  const [productRow] = await db.select({ config: pmsBuiWenlvProducts.config })
    .from(pmsBuiWenlvProducts)
    .where(eq(pmsBuiWenlvProducts.id, dialogue.productId))
    .limit(1);
  const tuneMode = productRow?.config?.tuneMode;

  // 团队模式：算 teamSize，供 checkGoalReached 协作校验用
  let teamSize: number | undefined;
  if (dialogue.teamId) {
    const [team] = await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, dialogue.teamId)).limit(1);
    teamSize = team?.members?.length;
  }

  // 追加玩家消息。团队模式加队员前缀，让 LLM 区分发言者
  const senderPrefix = dialogue.teamId
    ? `[队员${auth.miniUserId.slice(0, 6)}] `
    : '';
  const messages = [...dialogue.messages, { role: 'user' as const, content: senderPrefix + text, ts: Date.now() }];
  const turnCount = messages.filter((m) => m.role === 'user').length;

  const persona = npc.persona || EMPTY_PERSONA;
  const goal = node.chapterGoal!;

  // DM 三态引导引擎：计算本轮引擎态并生成导演指令
  const normalizedCriteria = normalizeCriteria(goal.answerCriteria);
  const prevHits = engineHitCache.get(dialogueId) || new Set<number>();
  let curHitIndices = computeHitIndices(goal, messages);
  const newHits = curHitIndices.filter((i) => !prevHits.has(i));
  let stallCount = engineStallCache.get(dialogueId) || 0;
  if (newHits.length > 0) { stallCount = 0; } else { stallCount += 1; }

  let engineState: 'opening' | 'exploring' | 'hit' | 'stalled' | 'closing' = 'exploring';
  if (turnCount === 1) engineState = 'opening';
  else if (newHits.length > 0) engineState = 'hit';
  else if (stallCount >= STAGGER_LIMIT) engineState = 'stalled';

  const directives: string[] = [];
  if (engineState === 'hit') {
    const remaining = normalizedCriteria.map((_, i) => i).filter((i) => !curHitIndices.includes(i));
    directives.push(
      `玩家刚刚触及了关键线索。请以入戏的方式确认他的发现（不要复述条件原文），然后把话题自然引向：${
        remaining.length ? `第 ${remaining[0] + 1} 个方向` : '收尾'
      }。`,
    );
  } else if (engineState === 'stalled') {
    const anchors = (dialogue.visualAnchors as VisualAnchor[] | undefined) || [];
    const anchor = anchors.find((a) => !curHitIndices.includes(a.criteriaIndex)) || anchors[0];
    if (anchor) {
      directives.push(
        `玩家已经原地打转 ${stallCount} 轮。请用环境观察把他拉回来，参考这个画面元素：${anchor.anchor}。可以这样起头：「${anchor.line}」。只描述画面，不说结论。`,
      );
    } else {
      directives.push(
        `玩家已经原地打转 ${stallCount} 轮。请换个角度，描述一个场景里的具体细节来重新吸引他，不要直接给答案。`,
      );
    }
  }

  // Task 7（I-2）：每 3 轮一次的 evaluateMove 多维评分与 SSE 流并行——此处只「立即启动」（fetch
  // 此刻即发出）而绝不 await，消除此前每 3 轮玩家发消息后要先干等评分 LLM（最长 20s）才看到
  // NPC 开口的 UX 回退。评分结果的落库统一推迟到流内幂等结算器 settleMove：在 completed 发送前、
  // 流后 progress 合并前两个「使用点」await 同一 promise（首个调用点真正结算，第二个为 no-op）。
  // 时序红线：先快照上一档 attitude（laggedAttitude），本轮新评出的态度绝不进入本轮 NPC prompt，
  // 「态度档滞后一档注入」的既有行为不变（三处 streamNpcReply 注入点统一读该快照）。
  // I-1：verdict 为 null（LLM 非 ok/网络/超时/坏 JSON）时三个缓存全部维持上一档，
  // 绝不允许故障档把真实分刷成伪「中立 50」；evaluateMove 契约不抛。
  const laggedAttitude = engineAttitudeCache.get(dialogueId);
  const moveVerdictPromise: Promise<MoveVerdict | null> =
    turnCount % 3 === 0
      ? evaluateMove({
          goalDescription: goal.description,
          answerCriteria: normalizedCriteria,
          // 防剧透纪律：第三参只接节点脱敏 hints；严禁把 normalizedCriteria（答案判据原文）传进来。
          criteriaHints: goal.criteriaHints,
          playerText: text,
          secretLayer: persona.secretLayer,
        })
      : Promise.resolve(null);
  // 防御性吞掉 rejection：evaluateMove 契约不抛，这里仅为杜绝 unhandled rejection；
  // 真正的结算仍走 settleMove（await 的是原 promise，不受此派生 catch 影响）。
  moveVerdictPromise.catch(() => { /* evaluateMove 契约不抛；防御性吞掉 */ });

  // SSE 响应
  return new Response(
    new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (obj: unknown) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(obj)}\n\n`));

        let assistantText = '';
        let completed = false;
        let nextNodeId: string | undefined;

        // Task 7：并行评分的幂等结算器。moveVerdictPromise 在 return 之前已与 NPC 流并行启动，
        // 这里只在「使用点」落缓存：通关轮在 completed 发送前首次结算，流后 progress 块再调一次
        // （moveApplied 保证第二次为 no-op）。两个使用点都在 NPC 台词流跑完之后，正常情况下
        // 评分 promise 早已 resolve，await 几乎零等待；仅当评分慢于两段台词流时，通关轮的收官
        // 事件会稍候片刻（仍远优于旧版每 3 轮流前阻塞最长 20s）。
        // moveHitIndices 全模块只在流后 progress 块消费，故随结算器一并收在闭包内。
        let moveApplied = false;
        let moveHitIndices: number[] = [];
        const settleMove = async () => {
          if (moveApplied) return;
          moveApplied = true;
          // evaluateMove 契约不抛；try/catch 为防御性兜底——意外 throw 时按故障档收敛
          //（三缓存不写、moveHitIndices 留空），绝不让评分错误炸掉整个 SSE 流。
          let verdict: MoveVerdict | null = null;
          try {
            verdict = await moveVerdictPromise;
          } catch (e) {
            console.warn('[wenlv-dialogue] evaluateMove 意外失败，按故障档处理', e instanceof Error ? e.name : typeof e);
            return;
          }
          if (!verdict) return;
          const level: 1 | 2 | 3 = verdict.attitude === '认同' ? 3 : verdict.attitude === '中立' ? 2 : 1;
          engineAttitudeCache.set(dialogueId, level);
          engineEmotiveCache.set(dialogueId, verdict.emotiveScore);
          moveHitIndices = verdict.hitCriteriaIndices;
          // engineHitCache 提前并集写一次：completed 分支可能在流后权威覆写之前就读缓存（防御）；
          // 该缓存全模块仅读于本处理函数顶部 prevHits（本轮已读过）与流后 progress payload/下一轮，
          // streamNpcReply 与 checkGoalReached 流内零读取（goal-checker 用自己的模块私有
          // criteriaCache，不共享）；流后还会用 criteria 路权威全集覆写一次。
          // 集合构造沿用流前时代原样：prevHits/curHitIndices 是外层 handler 的局部 const/let
          //（L279-280），本闭包可直接捕获，故并集语义与旧实现逐字节一致。
          engineHitCache.set(dialogueId, new Set<number>([...prevHits, ...curHitIndices, ...moveHitIndices]));
        };

        // 密信显影：流式文本处理器，将 [reveal]...[/reveal] 标记拆为 reveal 事件
        // 缓冲跨 chunk 的不完整 [reveal] 标记，保证 LLM 分 token 输出时也能正确识别
        let revealBuffer = '';
        const emitTextWithReveal = (delta: string) => {
          if (!delta) return;
          revealBuffer += delta;
          // 找出所有完整的 [reveal]...[/reveal] 片段，逐段发送 text/reveal 事件
          const matches = [...revealBuffer.matchAll(/\[reveal\]([\s\S]*?)\[\/reveal\]/g)];
          let scanFrom = 0;
          for (const m of matches) {
            const idx = m.index!;
            if (idx > scanFrom) send({ type: 'text', delta: revealBuffer.slice(scanFrom, idx) });
            send({ type: 'reveal', delta: m[1] });
            scanFrom = idx + m[0].length;
          }
          // 检查 tail 中是否有未闭合的 [reveal]，若有则保留到下次处理
          const tail = revealBuffer.slice(scanFrom);
          const openIdx = tail.lastIndexOf('[reveal]');
          if (openIdx !== -1) {
            const before = tail.slice(0, openIdx);
            if (before) send({ type: 'text', delta: before });
            revealBuffer = tail.slice(openIdx);
          } else {
            if (tail) send({ type: 'text', delta: tail });
            revealBuffer = '';
          }
        };
        const flushReveal = () => {
          // 流结束时若仍有未闭合 [reveal]，作为普通文本发出
          if (revealBuffer) {
            send({ type: 'text', delta: revealBuffer });
            revealBuffer = '';
          }
        };

        // P3-C Task 1：证词交叉章节——剥离 [claim topic="..."]...[/claim] 标记
        // claim 内文本作为可见 text 走 reveal 处理（玩家看到 NPC 台词），同时记录到 statementStore 供矛盾比对
        // 仅 cross-examine 章节启用；其他章节不会产出 [claim] 标记（prompt 未注入），不进入此分支
        const isCrossExamine = goal.type === 'cross-examine';
        let claimBuffer = '';
        const drainClaimAndEmit = (delta: string) => {
          if (!delta) return;
          claimBuffer += delta;
          const claimPattern = /\[claim\s+topic="([^"]+)"\]([\s\S]*?)\[\/claim\]/g;
          let scanFrom = 0;
          let match: RegExpExecArray | null;
          while ((match = claimPattern.exec(claimBuffer)) !== null) {
            const idx = match.index!;
            if (idx > scanFrom) emitTextWithReveal(claimBuffer.slice(scanFrom, idx));
            emitTextWithReveal(match[2]);
            recordStatement(dialogueId, npc.id, node.id, match[2], match[1]);
            scanFrom = idx + match[0].length;
          }
          const tail = claimBuffer.slice(scanFrom);
          const openClaimIdx = tail.lastIndexOf('[claim');
          if (openClaimIdx !== -1) {
            const before = tail.slice(0, openClaimIdx);
            if (before) emitTextWithReveal(before);
            claimBuffer = tail.slice(openClaimIdx);
          } else {
            if (tail) emitTextWithReveal(tail);
            claimBuffer = '';
          }
        };
        const flushClaim = () => {
          if (claimBuffer) {
            emitTextWithReveal(claimBuffer);
            claimBuffer = '';
          }
        };
        const processTextDelta = isCrossExamine ? drainClaimAndEmit : emitTextWithReveal;

        // 卡关 hint：轮次超过 minTurns * 1.5 仍未完成时，从 answerCriteria 取一条作为暗示注入。
        // 不直接说答案，让 NPC 自然地在对话中引导。前端收到 hint 事件会以金色提示气泡展示。
        let hintInjected: string | null = null;
        const effectiveMessages = [...messages];
        if (!completed && turnCount >= (goal.minTurns || 3) * 1.5 && normalizedCriteria.length) {
          const criteria = normalizedCriteria;
          const hitSet = new Set(
            messages
              .filter((m) => m.role === 'user')
              .flatMap((m) => criteria.filter((c) => m.content.toLowerCase().includes(c.toLowerCase())))
          );
          const remaining = criteria.filter((c) => !hitSet.has(c));
          const pick = remaining[0] || criteria[0];
          hintInjected = pick;
          effectiveMessages.push({
            role: 'system' as const,
            content: `玩家似乎卡住了（已超过最小轮次 1.5 倍）。请在不直接泄露答案的前提下，自然地暗示这条线索：${pick}`,
            ts: Date.now(),
          });
          send({ type: 'hint', text: pick });
        }

        // 导演指令注入：把 DM 三态引导引擎生成的指令作为 system 消息追加到 effectiveMessages
        if (directives.length) {
          effectiveMessages.push({
            role: 'system' as const,
            content: `【导演指令】\n${directives.join('\n')}`,
            ts: Date.now(),
          });
        }

        // 记录对话开始时已收集的证物，用于检测对话中新解锁的证物（扫码等）
        // 用顶部已合并的 collectedClueIds（state.collected + collectedCollectibles）
        const initialCollected = new Set(collectedClueIds);
        let clueCheckCounter = 0;

        for await (const chunk of streamNpcReply({
          messages: effectiveMessages,
          persona,
          goal,
          npcName: npc.name,
          npcRole: npc.role || '',
          npcMemory: npc.memory || undefined,
          relationships: npc.relationships || [],
          visualAnchors: (dialogue.visualAnchors as VisualAnchor[] | undefined) || [],
          criteriaHints: goal.criteriaHints,
          // I-2：读流前快照而非实时缓存——本轮新评的态度下一轮才注入（滞后一档行为不变）。
          attitudeLevel: laggedAttitude,
          discoveredClues,
          tuneMode,
        })) {
          if (chunk.type === 'text') {
            assistantText += chunk.delta;
            processTextDelta(chunk.delta);
            // 每 10 个 text chunk 检查一次是否有新证物被收集（扫码解锁等）
            clueCheckCounter++;
            // playerProgress 是实体进度行（仅扫码/信标解锁实体的玩家才有）：
            // 纯节点玩法玩家无行 ⇒ 无实体收集可检，直接跳过本检查（下方主进度 state 已覆盖）。
            if (clueCheckCounter % 10 === 0 && playerProgress) {
              const [freshProgress] = await db.select().from(pmsBuiWenlvPlayerProgress)
                .where(eq(pmsBuiWenlvPlayerProgress.id, playerProgress.id)).limit(1);
              // freshProgress 只有 collectedCollectibles；state.collected 在对话中不变，复用顶部的 mainProgress
              const currentCollected = getCollectedClueIds({
                collectedCollectibles: freshProgress?.collectedCollectibles,
                state: mainProgress?.state as WenlvState | null,
              });
              const newIds = currentCollected.filter((id) => !initialCollected.has(id));
              if (newIds.length) {
                const newCollectibles = await db.select().from(pmsBuiWenlvCollectibles)
                  .where(inArray(pmsBuiWenlvCollectibles.id, newIds));
                for (const c of newCollectibles) {
                  send({ type: 'clue-found', clueId: c.id, clueName: c.name });
                  initialCollected.add(c.id);
                }
              }
            }
          } else if (chunk.type === 'tool_call' && chunk.name === 'completeNode') {
            // 防偷懒校验（convince 走 LLM 评分，需 await；collaborative 校验所有队员贡献）
            // 取最新 playerProgress（对话中可能扫码收集了新证物），合并主进度 state.collected
            // 无实体进度行（playerProgress undefined）⇒ 跳过实体表查询，freshForGoal 为 undefined，
            // getCollectedClueIds 侧已有 `?.` 容忍 —— 只合并主进度 state.collected。
            const [freshForGoal] = playerProgress
              ? await db.select().from(pmsBuiWenlvPlayerProgress)
                .where(eq(pmsBuiWenlvPlayerProgress.id, playerProgress.id)).limit(1)
              : [undefined];
            const goalClueIds = getCollectedClueIds({
              collectedCollectibles: freshForGoal?.collectedCollectibles,
              state: mainProgress?.state as WenlvState | null,
            });
            const check = await checkGoalReached({ goal, messages, turnCount, teamSize, dialogueId, collectedClueIds: goalClueIds });
            if (check.passed) {
              completed = true;
              nextNodeId = (chunk.args.nextNodeId as string) || undefined;

              // 剧情图遍历：NPC 节点完成后沿边流转（边由顶部 runtime 规范图投影；空集 = 无边剧本）
              // auto 边自动解锁下一节点；choice 边返回选项给前端
              if (runtime.edges.length) {
                // 构造当前 state（与结局判定同款：从 dialogues 派生）
                const dlgRows = await db.select({ nodeId: pmsBuiWenlvDialogues.nodeId, status: pmsBuiWenlvDialogues.status })
                  .from(pmsBuiWenlvDialogues)
                  .where(and(
                    eq(pmsBuiWenlvDialogues.miniUserId, auth.miniUserId),
                    eq(pmsBuiWenlvDialogues.productId, dialogue.productId),
                  ));
                const visitedMap: Record<string, true> = Object.fromEntries(dlgRows.map((d) => [d.nodeId, true]));
                const completedMap: Record<string, true> = Object.fromEntries(dlgRows.filter((d) => d.status === 'completed').map((d) => [d.nodeId, true]));
                completedMap[dialogue.nodeId] = true;
                visitedMap[dialogue.nodeId] = true;
                const travState: WenlvState = { visited: visitedMap, completed: completedMap, collected: {} };

                const trav = traverseEdges(runtime.edges, dialogue.nodeId, travState, 'all');
                // auto 边的第一个解锁节点作为 nextNodeId（覆盖 LLM 建议）
                if (trav.autoUnlocked.length) {
                  nextNodeId = trav.autoUnlocked[0];
                }
                // choice 边随 completed 事件下发给前端展示选项
                if (trav.choices.length) {
                  send({ type: 'choices', choices: trav.choices });
                }
              }

              // 通关仪式收尾：让 NPC 用一句入戏的收官台词自然结束对话（不调用工具、不出戏）
              const closingMessages = [
                ...messages,
                {
                  role: 'system' as const,
                  content: '【导演指令】目标已达成。请用一句入戏的收官台词收尾（不要调用任何工具，不要说"恭喜通关"之类出戏的话），自然结束这段对话。',
                  ts: Date.now(),
                },
              ];
              for await (const c of streamNpcReply({
                messages: closingMessages, persona, goal,
                npcName: npc.name, npcRole: npc.role || '', npcMemory: npc.memory || undefined,
                relationships: npc.relationships || [],
                visualAnchors: (dialogue.visualAnchors as VisualAnchor[] | undefined) || [],
                criteriaHints: goal.criteriaHints,
                // I-2：读流前快照而非实时缓存——本轮新评的态度下一轮才注入（滞后一档行为不变）。
                attitudeLevel: laggedAttitude,
                discoveredClues,
                tuneMode,
              })) {
                if (c.type === 'text') {
                  assistantText += c.delta;
                  processTextDelta(c.delta);
                }
              }
              // Task 7：completed 透传情感意图分。评分 promise 与主 NPC 流并行启动，主台词流 +
              // closing 流已先后跑完，此刻先幂等结算（首个使用点）：评分通常早已 resolve，await
              // 零等待；评分真慢于两段台词流时只让通关轮收官事件稍候。通关轮（常见 minTurns=3
              // 且 turnCount%3===0）也能读到本档新鲜分；非评分轮/评分故障读上一档，首档前为 null。
              await settleMove();
              send({ type: 'completed', nextNodeId, summary: chunk.args.summary, emotiveScore: engineEmotiveCache.get(dialogueId) ?? null });

              // 结局判定：用 selectEnding 真相源按 triggerCondition 匹配，不再盲取 priority 最高
              // 真相源：services/wenlv-engine.ts 的 selectEnding（与 wenlv-my-play.ts /report 同源）
              try {
                // 0079：结局 = type='ending' 场景投影（runtime.endings 内部保留 triggerCondition/priority
                // 供 selectEnding 真相源消费；text/image 复用 scene.content/image 列）。
                const allEndings = runtime.endings;

                if (allEndings.length) {
                  // 拉全部对话的 (nodeId, status) 用于构造 WenlvState 的 visited/completed
                  const dialogueRows = await db.select({
                    id: pmsBuiWenlvDialogues.id,
                    nodeId: pmsBuiWenlvDialogues.nodeId,
                    status: pmsBuiWenlvDialogues.status,
                  }).from(pmsBuiWenlvDialogues)
                    .where(and(
                      eq(pmsBuiWenlvDialogues.miniUserId, auth.miniUserId),
                      eq(pmsBuiWenlvDialogues.productId, dialogue.productId),
                    ));
                  // 当前节点 nodeId 加入 completed 集合（这一刻刚通关，state 应反映）
                  const completedMap: Record<string, true> = {};
                  const visitedMap: Record<string, true> = {};
                  for (const d of dialogueRows) {
                    visitedMap[d.nodeId] = true;
                    if (d.status === 'completed') completedMap[d.nodeId] = true;
                  }
                  completedMap[dialogue.nodeId] = true;
                  visitedMap[dialogue.nodeId] = true;

                  // 结局判定的 collected 需合并两套来源（节点 effects.grant + 扫码收集）
                  // 复用 completeNode 时取的最新合并集合 goalClueIds
                  const mergedCollectedIds = goalClueIds;
                  const collectedMap: Record<string, true> = Object.fromEntries(
                    mergedCollectedIds.map((id) => [id, true]),
                  );
                  const state: WenlvState = { visited: visitedMap, completed: completedMap, collected: collectedMap };

                  const { endingId } = selectEnding(allEndings, state);
                  let ending = endingId ? allEndings.find((e) => e.id === endingId) || null : null;
                  // 兜底：未命中条件 ⇒ priority 最高（与 /report 行为对齐）
                  if (!ending) {
                    const sorted = [...allEndings].sort((a, b) => b.priority - a.priority);
                    ending = sorted[0] || null;
                  }

                  if (ending) {
                    const sanLevel = getEndingBySan(playerProgress?.san ?? 100);
                    // SSE 推送结局达成事件（前端弹 EndingCeremony）
                    send({
                      type: 'ending',
                      ending: {
                        id: ending.id,
                        title: ending.title,
                        text: ending.text || '',
                        image: ending.image || '',
                        sanLevel,
                      },
                    });

                    // 异步生成海报：仅当 ending.image 为空时（避免每玩家重复生成覆写）
                    // 失败不阻塞通关流（catch 吞错），海报缺位只影响分享体验
                    if (!ending.image) {
                      const [product] = await db.select({ name: pmsBuiWenlvProducts.name })
                        .from(pmsBuiWenlvProducts)
                        .where(eq(pmsBuiWenlvProducts.id, dialogue.productId))
                        .limit(1);
                      generateEndingPoster({
                        endingTitle: ending.title,
                        endingText: ending.text || '',
                        productName: product?.name || '',
                        sanLevel,
                        collectedCount: mergedCollectedIds.length,
                      }).then(async (url) => {
                        // 0079：结局承载于 scenes（scene.id=ending.id），海报 image 回写场景，旧 endings 表不再写。
                        await updateScene(ending!.id, { image: url });
                      }).catch(() => { /* 海报失败不影响通关 */ });
                    }
                  }
                }
              } catch (e) {
                // 结局判定失败不影响章节完成
                console.error('[wenlv-dialogue] 结局判定失败', e);
              }
            } else {
              // 未通过：注入继续引导提示，让 NPC 再说一句
              const retryMessages = [
                ...messages,
                { role: 'system' as const, content: check.reason, ts: Date.now() },
              ];
              for await (const retry of streamNpcReply({
                messages: retryMessages, persona, goal,
                npcName: npc.name, npcRole: npc.role || '', npcMemory: npc.memory || undefined,
                relationships: npc.relationships || [],
                visualAnchors: (dialogue.visualAnchors as VisualAnchor[] | undefined) || [],
                criteriaHints: goal.criteriaHints,
                // I-2：读流前快照而非实时缓存——本轮新评的态度下一轮才注入（滞后一档行为不变）。
                attitudeLevel: laggedAttitude,
                discoveredClues,
                tuneMode,
              })) {
                if (retry.type === 'text') {
                  assistantText += retry.delta;
                  processTextDelta(retry.delta);
                }
              }
            }
          } else if (chunk.type === 'tool_call' && (chunk.name === 'mentionNpc' || chunk.name === 'transferInfo')) {
            // 模块 B：NPC 提到/向另一 NPC 传递信息 —— 写入目标 NPC 的 pending_mentions 队列，
            // 目标 NPC 下次出场时由 drainMentions 取出注入 prompt。同时推 mention 事件给 C 端展示通知。
            const targetId = chunk.name === 'mentionNpc' ? chunk.args.targetNpcId : chunk.args.toNpcId;
            const context = chunk.name === 'mentionNpc' ? chunk.args.context : chunk.args.info;
            if (targetId && context) {
              await queueMention({
                targetNpcId: String(targetId),
                fromNpcId: dialogue.npcId,
                fromNpcName: npc.name,
                context: String(context),
              });
              send({ type: 'mention', targetNpcId: String(targetId), context: String(context) });
            }
          }
        }

        // 持久化：追加 assistant 消息 + 更新状态
        const finalMessages = [...messages, { role: 'assistant' as const, content: assistantText, ts: Date.now() }];
        await db.update(pmsBuiWenlvDialogues)
          .set({ messages: finalMessages, status: completed ? 'completed' : 'active' })
          .where(eq(pmsBuiWenlvDialogues.id, dialogueId));

        // 章节完成：异步生成 NPC 对玩家印象摘要，写入 pms_bui_wenlv_npcs.memory。
        // 复用 finalMessages（含本轮全部对话），不阻塞 SSE 关闭；失败不影响章节完成。
        if (completed) {
          summarizeMemory({
            messages: finalMessages,
            npcName: npc.name,
            npcRole: npc.role || '',
          }).then((memory) => {
            if (memory) {
              return db.update(pmsBuiWenlvNpcs)
                .set({ memory, updatedAt: new Date() })
                .where(eq(pmsBuiWenlvNpcs.id, dialogue.npcId));
            }
          }).catch(() => { /* 记忆失败不影响章节完成 */ });
        }

        // 推送进度事件：回合数 + answerCriteria 命中数，供前端进度条展示。
        // 用 LLM 语义匹配替代精确字符串匹配，让玩家自然对话也能正确显示进度。
        let hitCriteriaIndices = computeHitIndices(goal, finalMessages);
        try {
          hitCriteriaIndices = await evaluateCriteriaWithLLM(goal, finalMessages, dialogueId);
        } catch { /* LLM 失败则用同步兜底结果 */ }

        // 第二个使用点：幂等结算并行评分。通关轮已在 completed 发送前结算过，此处直接 no-op；
        // 非通关（含 retry）路径在此首次结算——评分已与整段 NPC 流并行跑完，通常同样零等待。
        // 必须放在下方 attitude 读缓存 / moveHitIndices 合并 / emotiveScore 读取之前。
        await settleMove();

        // attitudeLevel 读缓存：评分轮 verdict 非 null 时 settleMove 已写入本档新分，
        // verdict 为 null 或非评分轮时这里自然读到上一档（首档缺省 2）——不再有故障伪 50 覆盖。
        const attitudeLevel: 1 | 2 | 3 = engineAttitudeCache.get(dialogueId) || 2;
        // Task 7：evaluateMove 与 NPC 流并行、按每 3 轮节流执行（I-2），此处只把其判据命中并入
        // criteria 路结果（两路 LLM 独立判 hit，只增不减，避免轮间抖动）；
        // verdict 为 null 时 moveHitIndices 为空，命中集完全沿用 criteria 路结果。
        for (const idx of moveHitIndices) {
          if (!hitCriteriaIndices.includes(idx)) hitCriteriaIndices.push(idx);
        }
        hitCriteriaIndices.sort((a, b) => a - b);
        const emotiveScore = engineEmotiveCache.get(dialogueId) ?? null;

        const hitSet = new Set(hitCriteriaIndices);
        engineHitCache.set(dialogueId, hitSet);
        const llmNewHits = hitCriteriaIndices.filter((i) => !prevHits.has(i));
        if (llmNewHits.length > 0) { stallCount = 0; }
        engineStallCache.set(dialogueId, stallCount);

        const allHit = normalizedCriteria.length > 0 && hitCriteriaIndices.length >= normalizedCriteria.length;
        if (allHit) engineState = 'closing';

        send({
          type: 'progress',
          turnCount,
          minTurns: goal.minTurns,
          criteriaHit: hitCriteriaIndices.length,
          hitCriteriaIndices,
          totalCriteria: normalizedCriteria.length || 0,
          engineState,
          stallCount,
          attitudeLevel,
          // Task 7：情感意图分（最近一档；未评到首档时 null）。只新增键，既有 payload 不变。
          emotiveScore,
          san: playerProgress?.san ?? 100,
          collectedCount: initialCollected.size,
        });

        // 流结束前冲洗 claim 缓冲：未闭合的 [claim] 作为普通文本发出，避免内容丢失
        flushClaim();
        // 流结束前冲洗 reveal 缓冲：未闭合的 [reveal] 作为普通文本发出，避免内容丢失
        flushReveal();

        // P3-C Task 1：证词交叉章节——流结束前检测矛盾证词并推 contradiction 事件
        // 失败静默（LLM 不可用时不误报矛盾，避免误导玩家）
        if (isCrossExamine) {
          try {
            const contradictions = await detectContradictions(dialogueId);
            if (contradictions.length) {
              send({ type: 'contradiction', count: contradictions.length });
            }
          } catch { /* 矛盾检测失败不影响对话结束 */ }
        }

        send({ type: 'done' });
        controller.close();

        // 对话结束时清理引擎态缓存，避免内存泄漏
        if (completed) {
          engineHitCache.delete(dialogueId);
          engineStallCache.delete(dialogueId);
          engineAttitudeCache.delete(dialogueId);
          engineEmotiveCache.delete(dialogueId);
          // P3-C Task 1：清理本对话的陈述库（仅 cross-examine 章节会有累积）
          if (isCrossExamine) clearStatements(dialogueId);
        }
      },
    }),
    // SSE 响应。Connection: close 确保流结束后连接关闭，
    // 微信小程序 wx.request(enableChunked) 依赖响应结束来触发 success 回调。
    { headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'close', 'X-Accel-Buffering': 'no' } }
  );
});

// POST /api/mini/wenlv/dialogue/:id/choice — 玩家选择分支（choice 类型章节）
route.post('/:id/choice', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const dialogueId = c.req.param('id');
  const { optionIndex } = await c.req.json();

  const [dialogue] = await db.select().from(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.id, dialogueId)).limit(1);
  if (!dialogue) return c.json({ success: false, error: '对话不存在' }, 404);

  // 0079：节点 = 非 ending 场景投影（nodeId=scene.id）。
  const runtime = await loadRuntimeGraph(dialogue.productId);
  const node = runtime.nodes.find((n) => n.id === dialogue.nodeId);
  if (!node?.chapterGoal || node.chapterGoal.type !== 'choice') {
    return c.json({ success: false, error: '该章节不是选择类型' }, 400);
  }

  const options = node.chapterGoal.options || [];
  if (optionIndex < 0 || optionIndex >= options.length) {
    return c.json({ success: false, error: '选项索引越界' }, 400);
  }

  const nextNodeId = options[optionIndex].nextNodeId;
  await db.update(pmsBuiWenlvDialogues)
    .set({ status: 'completed' })
    .where(eq(pmsBuiWenlvDialogues.id, dialogueId));

  return c.json({ success: true, data: { nextNodeId } });
});

// POST /api/mini/wenlv/dialogue/:id/hint — 玩家主动请求渐进式提示
route.post('/:id/hint', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const dialogueId = c.req.param('id');
  const { criteriaIndex } = await c.req.json().catch(() => ({}));

  const [dialogue] = await db.select().from(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.id, dialogueId)).limit(1);
  if (!dialogue) return c.json({ success: false, error: '对话不存在' }, 404);
  // 团队模式：任何队员可请求提示；单人模式：仅本人
  if (dialogue.teamId) {
    const [team] = await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, dialogue.teamId)).limit(1);
    const isMember = team?.members?.some((m) => m.userId === auth.miniUserId);
    if (!isMember) return c.json({ success: false, error: '你不是该队伍成员' }, 403);
  } else if (dialogue.miniUserId !== auth.miniUserId) {
    return c.json({ success: false, error: '无权操作' }, 403);
  }

  // 0079：节点 = 非 ending 场景投影（nodeId=scene.id）。
  const runtime = await loadRuntimeGraph(dialogue.productId);
  const node = runtime.nodes.find((n) => n.id === dialogue.nodeId);
  const criteria = normalizeCriteria(node?.chapterGoal?.answerCriteria);
  if (!criteria.length) {
    return c.json({ success: false, error: '该章节无可提示内容' }, 400);
  }

  // 确定请求哪个条件的提示：优先用传入的 index，否则取第一个未命中的
  let targetIndex = typeof criteriaIndex === 'number' ? criteriaIndex : -1;
  if (targetIndex < 0 || targetIndex >= criteria.length) {
    const userMsgs = dialogue.messages.filter((m) => m.role === 'user').map((m) => m.content.toLowerCase());
    targetIndex = criteria.findIndex((c) => !userMsgs.some((m) => m.includes(c.toLowerCase())));
    if (targetIndex < 0) targetIndex = 0;
  }

  const targetCriteria = criteria[targetIndex];

  // 获取/递增提示级别
  if (!hintLevelCache.has(dialogueId)) hintLevelCache.set(dialogueId, new Map());
  const levelMap = hintLevelCache.get(dialogueId)!;
  const currentLevel = levelMap.get(targetIndex) || 0;
  const nextLevel = Math.min(3, currentLevel + 1);
  levelMap.set(targetIndex, nextLevel);

  // 根据级别生成提示文本
  let hintText = '';
  switch (nextLevel) {
    case 1:
      hintText = `试着聊聊关于"${desensitizeCriteria([targetCriteria])[0]}"的话题`;
      break;
    case 2:
      hintText = `他可能想看看${extractObject(targetCriteria)}`;
      break;
    case 3:
      if (extractAction(targetCriteria) === '展示') {
        hintText = `你身上有没有${extractObject(targetCriteria)}可以展示？`;
      } else {
        hintText = `或许你该提一提${extractObject(targetCriteria)}`;
      }
      break;
  }

  return c.json({
    success: true,
    text: hintText,
    level: nextLevel,
    criteriaIndex: targetIndex,
  });
});

// 从 criteria 提取对象（脱敏后去掉动词前缀）
function extractObject(criteria: string): string {
  const masked = desensitizeCriteria([criteria])[0] || criteria;
  return masked.replace(/^(说出|提到|告诉|提及|透露|展示|拿出|给)/, '').trim() || '相关物品';
}
// 判断动作类型：展示（实物）/ 提及（抽象）
function extractAction(criteria: string): string {
  const masked = desensitizeCriteria([criteria])[0] || criteria;
  if (/^(展示|拿出|给)/.test(masked)) return '展示';
  return '提及';
}

// GET /api/mini/wenlv/dialogue/:id — 获取对话历史
route.get('/:id', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const dialogueId = c.req.param('id');
  const [dialogue] = await db.select().from(pmsBuiWenlvDialogues).where(eq(pmsBuiWenlvDialogues.id, dialogueId)).limit(1);
  if (!dialogue) return c.json({ success: false, error: '对话不存在' }, 404);
  // 团队模式：任何队员可读；单人模式：仅本人
  if (dialogue.teamId) {
    const [team] = await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, dialogue.teamId)).limit(1);
    const isMember = team?.members?.some((m) => m.userId === auth.miniUserId);
    if (!isMember) return c.json({ success: false, error: '你不是该队伍成员' }, 403);
  } else if (dialogue.miniUserId !== auth.miniUserId) {
    return c.json({ success: false, error: '无权操作' }, 403);
  }

  const [npc] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, dialogue.npcId)).limit(1);

  return c.json({
    success: true,
    data: {
      id: dialogue.id,
      nodeId: dialogue.nodeId,
      npc: npc ? { id: npc.id, name: npc.name, portraitUrl: npc.portraitUrl, voiceId: npc.voiceId } : null,
      messages: dialogue.messages,
      status: dialogue.status,
    },
  });
});

// POST /api/mini/wenlv/dialogue/tts — NPC 对话实时语音合成
// 入参 text + voiceId（NPC 的火山 voice_id，如 male_young），
// 内部映射到 DashScope 音色后合成，上传 OSS 返回 audioUrl 供端上播放。
route.post('/tts', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const { text, voiceId } = await c.req.json() as { text?: string; voiceId?: string | null };
  // 计费端点护栏：非字符串/空白 ⇒ 400；超 2000 字 ⇒ 400（防止滥用刷 TTS 计费）。
  if (typeof text !== 'string' || text.trim().length === 0) return c.json({ success: false, error: '缺少文本' }, 400);
  if (text.trim().length > 2000) return c.json({ success: false, error: '文本过长' }, 400);

  try {
    const dashVoice = mapNpcVoiceToDashScope(voiceId);
    const buf = await synthesizeSpeech(text.trim(), dashVoice, 1.0, 50);
    const url = await uploadToOSS(buf, `pms/wenlv/dialogue-tts/${Date.now()}-${randomUUID()}.mp3`, 'audio/mpeg');
    return c.json({ success: true, audioUrl: url });
  } catch (err: any) {
    console.error('[wenlv-dialogue] TTS 合成失败', err);
    return c.json({ success: false, error: 'TTS 合成失败，请稍后重试' }, 500);
  }
});

export default route;
