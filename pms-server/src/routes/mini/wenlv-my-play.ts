// C 端首页「继续玩」条的聚合读口。**单独挂载**在 /api/mini/wenlv/my-play，
// 理由是顺序：若做成 mini/wenlv.ts 里的一个路径，就必须声明在该文件的 `route.get('/:id')` 之前，
// 否则 /:id 会把 'my-play' 当成产品 id（恒 404）。单独挂载 + 窄前缀先注册把它变成结构
// （先例与同款理由：src/routes/mini/unified-orders.ts 与 src/index.ts 里它的挂载点）。
//
// 为什么要有这条读口：客户端用现有读口拼是 1 + N 次请求（券列表一次 + 每个
// contentProductId 一次进度），N 随在玩剧本数增长。本条把 N 压成**一次** inArray 查询，全落在本服务内。
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiWenlvProgress,
  pmsBuiWenlvPlayerProgress,
  pmsBuiWenlvCollectibles,
  pmsBuiWenlvProducts,
  pmsBuiWenlvDialogues,
} from '../../db/schema/index.js';
import type { WenlvState } from '../../db/schema/wenlv.js';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { listWenlvTickets } from '../../services/platform-client.js';
import { serverError } from '../../lib/http-error.js';
import { getEndingBySan } from '../../services/wenlv/san-service.js';
import { selectEnding } from '../../services/wenlv-engine.js';
// 0079：结局 = type='ending' 场景投影（内部保留 triggerCondition/priority 供 selectEnding）。
import { loadRuntimeGraph } from '../../services/wenlv/script-room.js';

const route = new Hono();

route.get('/', async (c) => {
  // 鉴权：parseMiniToken + 显式 401，**不是** getMiniUser（后者无用户时 throw ⇒ 拿不到 401）
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);

  try {
    const r = await listWenlvTickets(miniUser.miniUserId);
    const ticketsOk = r.ok && Array.isArray(r.data?.data?.list);
    if (!ticketsOk) {
      // 失败 ⇒ 返回空 list + degraded:true + console.error（页面**不读** degraded ⇒ 渲染上与「真的没买过」无异；本字段是给将来的错误提示留的信号）。页面拿到空 list 就整块不渲染（无自动重试 —— 靠 onShow 再次进入时重取）。
      console.error('[wenlv-my-play] 券列表不可用，本次返回降级结果', { status: r.status });
      return c.json({ success: true, data: { list: [], degraded: true } });
    }
    const tickets = r.data.data.list as any[];

    // 「可用券」谓词与平台 I2 **同形**：status='unused' 且 expiresAt 非空且未过期。
    // 🔴 「未用」≠「可用」：付过钱但过了期的券在平台侧**永远是** status='unused'（平台到期清扫
    //    只收 expiresAt IS NULL 的未激活券）⇒ 只数 status 会把「已过期」显示成「买了还没玩」
    //    「票 N 张」，点进去被鉴权拒（403）⇒ 用户重复购买。
    // 🔴 now 只取一次：同一请求内所有券用**同一个时刻**判定（平台 usableTicketConds 同款理由）。
    const now = Date.now();

    // 按 contentProductId 归组：张数只数**可用**券；过期时间取可用券里**最早**一张的
    // （券未用也可能是「玩过但没核销」，所以张数与「未开始」是两件事）
    const groups = new Map<string, {
      contentProductId: string; productId: string | null; productName: string | null;
      unusedTicketCount: number; expiresAt: string | null;
    }>();
    for (const t of tickets) {
      const cid = t?.contentProductId ? String(t.contentProductId) : '';
      if (!cid) continue;
      const g = groups.get(cid) ?? { contentProductId: cid, productId: null, productName: null, unusedTicketCount: 0, expiresAt: null };
      if (t.productId) g.productId = String(t.productId);          // 详情页入参（交易侧 uuid）
      if (t.productName && !g.productName) g.productName = String(t.productName);
      if (t.status === 'unused' && t.expiresAt && new Date(String(t.expiresAt)).getTime() > now) {
        g.unusedTicketCount += 1;
        const exp = String(t.expiresAt);
        if (g.expiresAt === null || new Date(exp).getTime() < new Date(g.expiresAt).getTime()) g.expiresAt = exp;
      }
      groups.set(cid, g);
    }

    // 进度：一次 inArray 查齐（**不**逐条查 —— 那是 N+1）
    const contentIds = [...groups.keys()];
    const progRows = contentIds.length
      ? await db.select({
          productId: pmsBuiWenlvProgress.productId,
          status: pmsBuiWenlvProgress.status,
          updatedAt: pmsBuiWenlvProgress.updatedAt,
        }).from(pmsBuiWenlvProgress)
          .where(and(eq(pmsBuiWenlvProgress.miniUserId, miniUser.miniUserId), inArray(pmsBuiWenlvProgress.productId, contentIds)))
      : [];

    // ⚠️ 同一 (miniUserId, productId) 可能**同时**有散客行与团队行 —— 两条**部分**唯一索引各管各的
    //    （见 pmsBuiWenlvProgress 的 uq_wenlv_progress_solo / uq_wenlv_progress_team）。
    //    取 updatedAt 最大的那行（＝最近在玩的那一场）作为权威；这不是 spec 覆盖的情形，是此处补的确定规则。
    const prog = new Map<string, { status: string; updatedAt: Date }>();
    for (const p of progRows) {
      const cur = prog.get(p.productId);
      if (!cur || p.updatedAt.getTime() > cur.updatedAt.getTime()) prog.set(p.productId, { status: p.status, updatedAt: p.updatedAt });
    }

    const list = [...groups.values()].map((g) => {
      const p = prog.get(g.contentProductId);
      // playState 判据**正列举**（不写 `!==`）：无进度行 ⇒ none；completed ⇒ completed；其余 ⇒ playing
      const playState = !p ? 'none' : (p.status === 'completed' ? 'completed' : 'playing');
      return {
        contentProductId: g.contentProductId,
        productName: g.productName,
        productId: g.productId,
        playState,
        unusedTicketCount: g.unusedTicketCount,
        expiresAt: g.expiresAt,
        updatedAt: p ? p.updatedAt.toISOString() : null,
      };
    });
    // 排序只为一个目的：多个候选时页面取「第一条」的**结果确定**（最近更新的在前；
    // 无进度的沉底）。页面的优先级选择是 playwright 之外的另一条规则，不靠这个顺序。
    list.sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')) || a.contentProductId.localeCompare(b.contentProductId));

    // ⚠️ 刻意**不下发** state / visitedCount：play.vue 的「已探索 N 个节点」是用产品节点列表过滤出来的
    //    （sortedNodes.filter(isVisited)），不是 state.visited 的键数 ⇒ 在服务端复刻它就是造第二个真相源。
    return c.json({ success: true, data: { list } });
  } catch (e: any) {
    return serverError(c, e, '加载游玩记录失败');
  }
});

// GET /api/mini/wenlv/my-play/report/:productId — 通关探案报告
// 返回：证物墙、结局、SAN、用时、隐藏结局提示
route.get('/report/:productId', async (c) => {
  const auth = parseMiniToken(c.req.header('Authorization'));
  if (!auth) return c.json({ success: false, error: '未登录' }, 401);

  const productId = c.req.param('productId');

  try {
    // 查玩家进度（SAN、已收集证物、时间）
    const [progress] = await db.select().from(pmsBuiWenlvPlayerProgress)
      .where(and(
        eq(pmsBuiWenlvPlayerProgress.miniUserId, auth.miniUserId),
        eq(pmsBuiWenlvPlayerProgress.productId, productId),
      )).limit(1);

    if (!progress) {
      return c.json({ success: false, error: '无游玩记录' }, 404);
    }

    // 通关判断：该用户在该剧本下是否有 status='completed' 的 dialogue
    // 同时拉全部对话的 (nodeId, status)：用于构造 WenlvState 的 visited/completed 映射
    const dialogueRows = await db.select({
      id: pmsBuiWenlvDialogues.id,
      nodeId: pmsBuiWenlvDialogues.nodeId,
      status: pmsBuiWenlvDialogues.status,
    }).from(pmsBuiWenlvDialogues)
      .where(and(
        eq(pmsBuiWenlvDialogues.miniUserId, auth.miniUserId),
        eq(pmsBuiWenlvDialogues.productId, productId),
      ));
    const hasCompleted = dialogueRows.some((d) => d.status === 'completed');
    if (!hasCompleted) {
      return c.json({ success: false, error: '尚未通关' }, 400);
    }

    // 构造 WenlvState：visited/completed 来自 dialogues；collected 来自 progress
    // selectEnding 是真相源（wenlv-engine.ts），不可在此另写一份匹配逻辑
    const playerState: WenlvState = {
      visited: Object.fromEntries(dialogueRows.map((d) => [d.nodeId, true])),
      completed: Object.fromEntries(dialogueRows.filter((d) => d.status === 'completed').map((d) => [d.nodeId, true])),
      collected: Object.fromEntries((progress.collectedCollectibles || []).map((id) => [id, true])),
    };

    // 用时：player_progress.updatedAt - createdAt（通关时间近似）
    const durationSec = Math.round((progress.updatedAt.getTime() - progress.createdAt.getTime()) / 1000);

    // 剧本信息
    const [product] = await db.select({ name: pmsBuiWenlvProducts.name })
      .from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, productId))
      .limit(1);

    // 已收集证物
    const collectedIds = progress.collectedCollectibles || [];
    const collectibles = collectedIds.length > 0
      ? await db.select({
          id: pmsBuiWenlvCollectibles.id,
          name: pmsBuiWenlvCollectibles.name,
          image: pmsBuiWenlvCollectibles.image,
          stampMeta: pmsBuiWenlvCollectibles.stampMeta,
        }).from(pmsBuiWenlvCollectibles)
          .where(inArray(pmsBuiWenlvCollectibles.id, collectedIds))
      : [];

    // 结局：用 selectEnding 真相源匹配 triggerCondition（不再盲取 priority 最高）
    // 真相源：services/wenlv-engine.ts 的 selectEnding —— 全库唯一多结局解析器
    // 0079：结局集来自规范图投影（type='ending' 场景），不再读旧 endings 表。
    const sanEnding = getEndingBySan(progress.san);
    const { endings: allEndings } = await loadRuntimeGraph(productId);
    const { endingId, satisfiedIds } = selectEnding(allEndings, playerState);
    let ending = endingId ? (allEndings.find((e) => e.id === endingId) || null) : null;
    // 兜底：selectEnding 未命中任何条件 ⇒ 退回 priority 最高（保持原行为，不破坏存量）
    if (!ending && allEndings.length) {
      const sorted = [...allEndings].sort((a, b) => b.priority - a.priority);
      ending = sorted[0];
    }

    // 隐藏结局提示：除当前结局外的其他结局（已触发但被更高优先级覆盖的单独标记）
    const satisfiedSet = new Set(satisfiedIds);
    const hiddenEndingHints = allEndings
      .filter((e) => !ending || e.id !== ending.id)
      .map((e) => satisfiedSet.has(e.id) && e.id !== ending?.id
        ? `「${e.title}」（已触发但被更高优先级覆盖）`
        : `还有「${e.title}」等你发现…`);

    return c.json({
      success: true,
      data: {
        productName: product?.name || '',
        ending: ending ? { id: ending.id, title: ending.title, text: ending.text || '' } : null,
        san: progress.san,
        sanEnding,
        collectibles,
        durationSec,
        hiddenEndingHints,
      },
    });
  } catch (e: any) {
    return serverError(c, e, '加载探案报告失败');
  }
});

export default route;
