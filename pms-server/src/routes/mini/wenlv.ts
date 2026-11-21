import { Hono } from 'hono';
import { randomUUID, randomInt } from 'node:crypto';
import { db } from '../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvCollectibles,
  pmsBuiWenlvProgress, pmsBuiWenlvEvents,
  pmsBuiWenlvRewardTiers, pmsBuiWenlvRewards, pmsBuiWenlvClaims,
  pmsBuiWenlvVenuePoints, pmsBuiWenlvVenues, pmsBuiWenlvClientReports,
  pmsBuiWenlvBeacons, pmsBuiWenlvSessions, pmsBuiWenlvNpcs, pmsBuiWenlvCharacters,
  pmsBuiWenlvTeams,
} from '../../db/schema/index.js';
import type { WenlvState, WenlvInteraction, WenlvAtom } from '../../db/schema/wenlv.js';
import { eq, and, desc, inArray, sql, notInArray, count, isNotNull } from 'drizzle-orm';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import {
  evalCondition, markVisited, applyGrants, mergeStates,
  isAnswerCorrect, maskInteractionAnswers, buildClaimState, nodeRequiresCredential,
  nodeDisplayLocation,
  isQuizInteraction, conditionReferencesSkill,
} from '../../services/wenlv-engine.js';
import { traverseEdges, applyTraversalResult } from '../../services/wenlv/graph-traversal.js';
// 剧本房统一模型（0079）：C端读/写端点恒由规范图装配（loadRuntimeGraph / loadRoomGraphByContentId），
// scenes/flows → nodes/edges/endings 全量投影；无 hasChapters 双读分流，旧 nodes/node_edges/endings 表不再读。
import {
  loadRoomGraphByContentId, projectScenesToNodes, projectFlowsToEdges, projectScenesToEndings,
  projectEndingToClient, toClientNpcPersona,
  loadRuntimeGraph, findProductIdsByVenuePoint, findSceneTitlesByIds,
} from '../../services/wenlv/script-room.js';
// 节点完成链路（Task 4 自本文件 /answer 抽取）：helper 与 applyNodeCompletion 共用同一份。
import {
  applyNodeCompletion, rallyStampOnSiteErr, syncPlayerCollectibles,
  settleEndings, teamEndings,
} from '../../services/wenlv/node-graph/complete-node.js';
import { checkTicket } from '../../services/wenlv-ticket-client.js';
import { loadDesignTokensForProduct, loadDesignTokensForProducts } from '../../services/wenlv-design-load.js';
import { resolveBgmUrl } from '../../services/bgm-library.js';
import { normalizeCategory, isDuplicateWithin } from '../../services/wenlv-report.js';
import { normalizeUuid, isValidBeaconNumber } from '../../services/wenlv-beacon.js';
import { getWenlvOrderByLeaderCode, transferWenlvTicket, returnWenlvTicket } from '../../services/platform-client.js';
import { genTeamCode } from '../../services/wenlv-session-code.js';
import { serverError } from '../../lib/http-error.js';
import { pickPublicProduct } from './wenlv-public-fields.js';
import { clientSupportsBinaryNodes, legacyWireNodeType } from './client-version.js';
import { desensitizeCriteria } from '../../services/wenlv/npc-dialogue/criteria-mask.js';
import { normalizeCriteria } from '../../services/wenlv/npc-dialogue/goal-checker.js';
// 实景原子读端投影：老剧本 puzzle → 兼容 quiz 原子（不落库，仅 DTO 下发）。
import { puzzleToAtom, toClientAtom } from '../../services/wenlv/atoms/project.js';
// 原子核验（7 种 verify 语义分派）+ 必填原子清单（节点完成判定）。
import { verifyAtom, AtomVerifyUnsupportedError } from '../../services/wenlv/atoms/verify.js';
import { requiredAtomIds } from '../../services/wenlv/atoms/registry.js';
// 导演 v1（Task 16）：行为事件后惰性 tick。一律 fire-and-forget，不阻塞主请求。
import { tickDirector } from '../../services/wenlv/director.js';

// POST /track 允许落库的商业/行为事件白名单（events.event_type varchar(20)，无枚举约束，零迁移）。
const TRACK_EVENT_TYPES = ['task_grant', 'arrived', 'cipher_redeemed', 'purchased', 'token_redeemed', 'shared', 'paid_customization'];

// 统一写 pms_bui_wenlv_events：原子端点与 /track 共用，字段组装口径与 applyNodeCompletion 一致。
async function trackEvent(
  productId: string, miniUserId: string, eventType: string,
  payload: Record<string, unknown> = {}, nodeId?: string | null,
) {
  await db.insert(pmsBuiWenlvEvents).values({
    id: randomUUID(), productId, miniUserId, eventType, nodeId: nodeId ?? null, payload,
  });
}

// 付费墙：校验有效门票，未持票返 403。
// 旁路双条件：仅当显式设 WENLV_BYPASS_TICKET=1 且 NODE_ENV 非 production 才返回 null。
// ⚠️ 旁路是**真正的双守卫**：`docker-compose.yml` 五个服务均设 `NODE_ENV=production`
//   （2026-09 补设；此前 pms-server 块漏设，致该条件在生产恒真、旁路退化为单看 WENLV_BYPASS_TICKET），
//   故 `NODE_ENV !== 'production'` 在生产恒为假 —— 即便 `WENLV_BYPASS_TICKET` 被带进
//   pms-server 的环境变量也不会旁路。该键目前仅测试文件设置（影响 /trigger /answer /redeem /start）。
async function assertTicket(c: any, contentProductId: string, miniUserId: string): Promise<Response | null> {
  if (process.env.WENLV_BYPASS_TICKET === '1' && process.env.NODE_ENV !== 'production') return null;
  // 免费剧本放行：管理员在内容产品上显式标了 `is_free` ⇒ 不查票。
  //
  // 🔴 这是**独立分支**，与上面那条 `WENLV_BYPASS_TICKET` 旁路无关、也**不得**合并：
  //    那条旁路带 `NODE_ENV !== 'production'` 守卫，在生产恒为假 —— 拿它当免费放行，
  //    生产环境免费剧本一律进不去。本片的免费是**业务属性**，与运行环境无关。
  // 🔴 必须排在 `checkTicket` **之前**：不是性能优化，而是语义 ——
  //    免费剧本**不应产生任何跨服务请求**（测试用例 wenlv-free-script.test.ts 钉死这一点）。
  const [free] = await db.select({ isFree: pmsBuiWenlvProducts.isFree })
    .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, contentProductId)).limit(1);
  if (free?.isFree) return null;
  const ticket = await checkTicket(contentProductId, miniUserId);
  if (!ticket.valid) return c.json({ success: false, error: '请先购买门票券' }, 403);
  return null;
}

const route = new Hono();

// 去掉谜题答案，仅下发题目（游客端不能拿到答案）：single/input/judge→answer=''；multiple→answer=[]；photo 原样
function stripAnswers(puzzle: WenlvInteraction | null | undefined): WenlvInteraction | null {
  if (!puzzle) return null;
  return maskInteractionAnswers(puzzle);
}

// GET /api/mini/wenlv — 已发布文旅产品列表
route.get('/', async (c) => {
  try {
    const rows = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.status, 'published'))
      .orderBy(desc(pmsBuiWenlvProducts.createdAt));
    // 批量解析设计 token（一次查齐模板），避免逐条查模板的 N+1
    const tokenMap = await loadDesignTokensForProducts(rows);
    const list = rows.map((r) => ({ ...pickPublicProduct(r), designTokens: tokenMap.get(r.id) ?? {} }));
    return c.json({ success: true, data: { list, total: list.length } });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// GET /api/mini/wenlv/venues — 公开场地列表（只给 `live` 的；C 端「按场地」视角的数据源）
//
// ⚠️ 本路由与 `/enter` 一样**必须注册在 `route.get('/:id')` 之前**。Hono 按注册顺序匹配，
//    追加到文件末尾会被 `/:id` 先吃掉，表现为「产品不存在」404 —— 而「不存在的 id → 404」
//    的用例照样绿，光看测试全绿发现不了这个错位（同款说明见下方 `/enter` 上方的注释）。
//
// 公开性：`/api/mini/wenlv` 已在 `pms-server/src/middleware/mini-auth.ts` 的 `MINI_PUBLIC_PREFIXES` 里
// ⇒ 中间件层免登录。**handler 内不调 `parseMiniToken`**（同文件 `GET /` 就是无 token 的先例）。
// 纯查询：不写任何表。
route.get('/venues', async (c) => {
  try {
    // 🔴 **显式白名单投影，不许 `db.select()` 整行**：场地行含 contactName（联系人）、
    //    contactPhone（电话）、ownerStaffId（我方负责人）、remark（备注），整行下发等于把
    //    内部联系人与备注发给任意游客，而且**将来新加的列会自动跟着流出去**
    //    （同 `wenlv-public-fields.ts` 立下的规矩：「漏删一列是静默的」）。
    // 本轮**不下发** latitude/longitude：⑤-A 没有地图与「场地附近可住」的消费方，
    // 等 ⑤-B 的场地主页要用时再加，别提前开面。
    const rows = await db.select({
      id: pmsBuiWenlvVenues.id,
      name: pmsBuiWenlvVenues.name,
      city: pmsBuiWenlvVenues.city,
      address: pmsBuiWenlvVenues.address,
      coverImage: pmsBuiWenlvVenues.coverImage,
      liveAt: pmsBuiWenlvVenues.liveAt,
    }).from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.status, 'live'));

    // 排序：`liveAt` 降序（null 排最后），再按 `name` 升序兜底 —— 顺序**确定**，首屏不抖。
    // `liveAt` 的取值来自 `pms-server/src/services/wenlv-venue.ts:39`（`case 'live': return 'liveAt'`）的映射；
    // 但该列「只在为 null 时盖章（首次进入），返工不进覆盖」（`pms-server/src/db/schema/wenlv.ts:436` 注释）
    // ⇒ 早于该机制的存量 live 场地可能为 null，故必须容忍 null。
    const stamp = (v: any): number | null => (v && Number.isFinite(new Date(v).getTime()) ? new Date(v).getTime() : null);  // 不可解析 ⇒ NaN；NaN !== null 会被当「有章」而污染首屏 ⇒ 归一成 null
    const sorted = [...rows].sort((a, b) => {
      const x = stamp(a.liveAt);
      const y = stamp(b.liveAt);
      if (x !== null && y !== null && x !== y) return y - x;
      if (x === null && y !== null) return 1;
      if (x !== null && y === null) return -1;
      return a.name.localeCompare(b.name, 'zh-Hans-CN');
    });
    // 🔴 空列表是**合法响应（200）**，不是 404：没有 live 场地是正常业务状态（设计 §5 坏状态 #2）。
    return c.json({ success: true, data: { list: sorted, total: sorted.length } });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});
/** 建**一支**队。撞码（uq_wenlv_sessions_code）⇒ 换码重试；**只认这一个约束名**。 */
async function insertTeamOnce(v: {
  orderId: string; slotId: string | null; productId: string; seq: number; name: string;
}) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db.insert(pmsBuiWenlvSessions)
        .values({ id: randomUUID(), ...v, code: genTeamCode() })
        .returning();
      return row;
    } catch (e: unknown) {
      // 🔴 必须穿透 drizzle 的包装层：0.45.2 的 queryWithCache 抛 DrizzleQueryError
      //   （只有 message/query/params/cause）⇒ `e.code` 恒 undefined、读法会静默失效。
      //   先例与其原文说明见 `pms-server/src/routes/admin/wenlv.ts:538-562` 的 uq_wenlv_venue_points_code 那段。
      const pgErr = ((e as any)?.cause ?? e) as { code?: string; constraint?: string } | undefined;
      if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_sessions_code') continue;
      // 别的 23505（含 id 主键）一律上抛：把真故障报成「换码重试」会掩盖它
      throw e;
    }
  }
  // 31^8 里连撞 5 次不是运气问题，是生成器坏了（字符集被改小 / 随机源恒返回同一个值）
  throw new Error('队伍码连续冲突 5 次：请检查 genTeamCode 的字符集与随机源');
}

/** 建队响应里的队伍投影（**不下发** order_id —— 那属于交易层内部信息） */
function publicSession(r: { id: string; seq: number; name: string; code: string; status: string; teamId?: string }) {
  return { sessionId: r.id, seq: r.seq, name: r.name, code: r.code, status: r.status, teamId: r.teamId ?? r.id };
}

/**
 * 建成员行（幂等）。返回**本次新建**的那行；已存在（撞 uq_wenlv_progress_team）⇒ `null`。
 * 返回 null 而不是读回既有行，是**有意**的：调用方只在「本次新建」时才允许回滚删除它
 * （见 join 的 ③）—— 读回既有行会让回滚删掉别人的历史行。
 */
async function ensureMember(session: { id: string; productId: string }, miniUserId: string) {
  const inserted = await db.insert(pmsBuiWenlvProgress).values({
    id: randomUUID(),
    productId: session.productId,
    miniUserId,
    sessionId: session.id,
  })
    // 🔴 谓词键是 **`where`**（形态 3），不是 `targetWhere`（形态 4 被静默丢弃 ⇒ 42P10）。
    //   也**不许**用裸 `onConflictDoNothing()`（形态 1）：它吞掉**所有**唯一冲突 ——
    //   将来别处再给这张表加一个唯一索引，冲突会被静默读成「已入队」。
    .onConflictDoNothing({
      target: [pmsBuiWenlvProgress.miniUserId, pmsBuiWenlvProgress.productId, pmsBuiWenlvProgress.sessionId],
      where: isNotNull(pmsBuiWenlvProgress.sessionId),
    })
    .returning({ id: pmsBuiWenlvProgress.id });
  return inserted[0] ?? null;
}

// GET /api/mini/wenlv/enter?c=<短码> — 扫码入口
//
// ⚠️ 本路由**必须注册在 `/:id` 之前**。Hono 按注册顺序匹配，追加到文件末尾会被
// `route.get('/:id')` 先吃掉，表现为「产品不存在」404 —— 而「不存在的码 → 404」
// 的用例照样绿，所以光看测试全绿发现不了这个错位。
//
// 纯查询：不写进度、不扣门票、不建订单。
route.get('/enter', async (c) => {
  // 生产 nginx 的 /api/ 前缀未关缓存；本端点 cache key 是 URL，同一张二维码所有游客 URL 相同，
  // 一旦被缓存就会把第一个游客的 hasTicket 回放给后来者 —— 显式禁缓存。
  c.header('Cache-Control', 'no-store');
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const code = (c.req.query('c') ?? '').trim();
    if (!code) return c.json({ success: false, error: '缺少短码' }, 400);

    // ── 码即身份（P2 §三）：**先**查本服务库的队伍码，命中 ⇒ 团队通道；否则才走下面的产品码/点位码解析。
    //    判定不靠格式猜测（格式约定会是第二个真相源）。
    //    ⚠️ 顺序不可颠倒：两族字符集**有重叠**，同字码在场时谁赢由这两行的先后决定；
    //      而调换顺序**不会**让任何既有用例变红（点位表里通常没有这个码）⇒ 靠 `wenlv-enter.test.ts`
    //      的「同字码」用例钉住。
    let [team] = await db.select().from(pmsBuiWenlvSessions)
      .where(eq(pmsBuiWenlvSessions.code, code)).limit(1);
    if (!team) {
      // 与点位码同款的大小写不敏感兜底；两行只差大小写时**不猜**（宁可不命中）
      // ⚠️ 成本：`upper(code) = …` 把函数套在了列上 ⇒ **用不上** `uq_wenlv_sessions_code`（索引失效），
      //    这一跳是全表扫 sessions。当前队伍表量级小，先接受；同属计划台账那条待办。
      const near = await db.select().from(pmsBuiWenlvSessions)
        .where(sql`upper(${pmsBuiWenlvSessions.code}) = ${code.toUpperCase()}`)
        .limit(2);
      if (near.length === 1) team = near[0];
    }
    if (team) {
      const [cntRow] = await db.select({ c: count() }).from(pmsBuiWenlvProgress)
        .where(eq(pmsBuiWenlvProgress.sessionId, team.id));
      const [mine] = await db.select({ id: pmsBuiWenlvProgress.id }).from(pmsBuiWenlvProgress)
        .where(and(
          eq(pmsBuiWenlvProgress.sessionId, team.id),
          eq(pmsBuiWenlvProgress.miniUserId, miniUser.miniUserId),
        )).limit(1);
      const [prod] = await db.select({
        id: pmsBuiWenlvProducts.id,
        name: pmsBuiWenlvProducts.name,
        coverImage: pmsBuiWenlvProducts.coverImage,
        mode: pmsBuiWenlvProducts.mode,
      }).from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, team.productId)).limit(1);
      // 打通 sessions 表与 teams 表：以 session.id 为 team.id get-or-create 队伍，
      // 使 play-team.vue 能拿到 teamId 调用 teams 系列 API（GET /teams/:id、POST /teams/join 等）。
      const teamRow = await getOrCreateTeamForSession(team.id, team.productId, miniUser.miniUserId);
      return c.json({
        success: true,
        data: {
          // 团队通道的标记。**散客/点位通道不加 kind** —— 既有响应的形状一个字段都不动
          // （既有的 16 条用例与 nimi 的解析都按现状写，加字段是白担风险）。
          kind: 'team',
          team: {
            sessionId: team.id,
            // teamId = teams 表主键，play-team.vue 用它调 teams 系列 API。
            // 与 sessionId 同值（以 session.id 作为 team.id 打通两套体系）。
            teamId: teamRow.id,
            seq: team.seq,
            name: team.name,
            code: team.code,
            status: team.status,   // 页面据此禁用「加入」；join 侧另有一道 409（Task 7）
            memberCount: Number(cntRow?.c ?? 0),
            joined: Boolean(mine),
          },
          // 剧本摘要**可空，仅当产品行物理不存在**（session.productId 悬空 / 行被硬删）——
          // 那时仍要让队员看到队名并自己判断，不能让整个入口塌成 404（会让队员以为「码失效了」）。
          // ⚠️ 别把本行读成「产品删了/下架了 ⇒ 摘要为 null」：本系统「删除」是软删（status='deleted'，
          //    行仍在）、「下架」是 draft/archived（行仍在）⇒ 这两条路径 `prod` **非空**，摘要**照常回传**。
          // ⚠️ 本分支**不滤 status**（对比散客 candidates 那条 `eq(status,'published')`）——
          //    要不要滤属产品决策，已记进计划台账；此处**不加**过滤。
          product: prod ?? null,
        },
      });
    }

    // 先精确匹配；未命中再大小写不敏感兜底 —— 现场手输常写成小写。
    // 两行只差大小写时**不猜**（宁可不命中），避免把游客送进错误的剧本。
    let [point] = await db.select().from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.code, code)).limit(1);
    if (!point) {
      const near = await db.select().from(pmsBuiWenlvVenuePoints)
        .where(sql`upper(${pmsBuiWenlvVenuePoints.code}) = ${code.toUpperCase()}`)
        .limit(2);
      if (near.length === 1) point = near[0];
    }
    if (!point) return c.json({ success: false, error: '这个码无效或已更换，请找现场工作人员' }, 404);

    const [venue] = await db.select({ id: pmsBuiWenlvVenues.id, name: pmsBuiWenlvVenues.name })
      .from(pmsBuiWenlvVenues).where(eq(pmsBuiWenlvVenues.id, point.venueId)).limit(1);

    // 新模型：点位绑在 scenes.venuePointId，经 chapters→script_rooms.contentId 反查产品（唯一仓储）。
    const productIds = await findProductIdsByVenuePoint(point.id);

    const base = {
      venue: venue ? { id: venue.id, name: venue.name } : null,
      point: { id: point.id, name: point.name },
    };
    if (productIds.length === 0) return c.json({ success: true, data: { ...base, candidates: [] } });

    const products = await db.select({
      id: pmsBuiWenlvProducts.id,
      name: pmsBuiWenlvProducts.name,
      coverImage: pmsBuiWenlvProducts.coverImage,
      mode: pmsBuiWenlvProducts.mode,
      isFree: pmsBuiWenlvProducts.isFree,
    }).from(pmsBuiWenlvProducts).where(and(
      inArray(pmsBuiWenlvProducts.id, productIds),
      eq(pmsBuiWenlvProducts.status, 'published'),
    ));

    // 有票与否**只标注、不过滤** —— 过滤会让「码没挂剧本」与「有剧本但没票」
    // 塌成同一个空列表，入口页只能给一句通用文案，两者必错其一。
    const candidates = await Promise.all(products.map(async (p) => {
      // 🔴 免费剧本**没有票可查**：直接给 `hasTicket: true`。
      //    不这么做的话，入口页会对一个**服务端根本不需要票**的剧本渲染
      //    「你还没有这个剧本的门票」+「去购买」（nimi 侧 `decideEnter` 见
      //    `hasTicket === false` 就落 `kind:'purchase'`）—— 既误导游客，
      //    也为一个免票剧本**发一次跨服务请求**（与 `assertTicket` 免费分支同一条语义）。
      if (p.isFree) {
        return { contentProductId: p.id, name: p.name, coverImage: p.coverImage, mode: p.mode, hasTicket: true };
      }
      const ticket = await checkTicket(p.id, miniUser.miniUserId);
      return {
        contentProductId: p.id,
        name: p.name,
        coverImage: p.coverImage,
        mode: p.mode,
        // 三态：true 有票／false 确定没票／null **问不到**（上游故障）。
        // 绝不把 null 折成 false —— 那会让持票游客在 BFF 抖动时看到「你没买票」
        // 加一个「去购买」按钮，于是重复购票。入口页对 null 走「请稍后重试」。
        hasTicket: ticket.unknown ? null : ticket.valid,
      };
    }));

    return c.json({ success: true, data: { ...base, candidates } });
  } catch (e: any) {
    return serverError(c, e, '扫码入口查询失败');
  }
});

// GET /api/mini/wenlv/:id/beacon-uuids — 本剧本的在役信标**扫描计划** `{ uuids, frames }`
//   · 不带 `?nodeId=`（场地模式，仅供兼容与排查）：本剧本所属场地的在役帧
//   · 带 `?nodeId=`（节点模式，C 端永远这样调）：该节点所绑点位的在役帧，**不带场地过滤**
//     —— 与触发端 `beaconMatchesPoint` 的谓词同形，否则会造出「客户端扫不到、服务端能判过」的分叉
//   · 两种模式都**只下发三件套齐全的行**：缺 major/minor 的设备扫得到但服务端永远判不过
//   · `uuids` 是 `startBeaconDiscovery` 的入参（uuid 已小写去重）；`frames` 是判帧用的三件套
//     （保留原始大小写、不去重）
//
// 为什么必须存在：`wx.startBeaconDiscovery` 的 `uuids` 是**必填** ——
// 不预知 UUID 就扫不了 iBeacon（鸡生蛋）。而不预知参数的那条路（靠解
// advertisData 反推）在 iOS 上不存在：厂家《小程序抓包指导》明写 iOS 会
// 屏蔽标准 iBeacon 帧的 advertisData，只有安卓能拿到，且只有 25 字节。
// ⇒ 设备参数必须先录进系统，游客端才可能扫得到。
//
// 注册顺序：本路由是 2 段路径，与 `route.get('/:id')`（1 段）段数不同，
// Hono 不会误匹配（同 `/reports` vs `/reports/summary` 的实测结论）。
// 仍排在 `/:id` **之前**，与 `/enter` 同款，避免将来有人把 `/:id` 改成
// 通配时静默失效 —— 而「不存在的产品 → 404」的用例照样绿，光看测试发现不了。
//
// 安全性：UUID 是**广播参数**，任何人拿个 BLE 扫描器都能看到，不是凭证；
// 点位码才是凭证，绝不下发（同 GET /:id 的注释）。本端点仍要求登录态。
/** 把「在役且三件套齐全」的信标行整理成扫描计划。纯函数、无 I/O，两种模式共用。 */
function buildScanPlan(rows: { uuid: string | null; major: number | null; minor: number | null }[]) {
  // 三件套的**非空由 SQL 的 isNotNull 保证**（见调用处的 aliveComplete）；这里的 `as`
  // 纯粹是给 TS 收窄 —— 别把 SQL 那三个 isNotNull 删掉换成 JS 过滤，那样会变成
  // 「先取回再丢」，而本端点的契约是**不下发**（现场看不到的设备必须连计划里都没有）。
  const frames = rows.map((r) => ({
    uuid: r.uuid as string,
    major: r.major as number,
    minor: r.minor as number,
  }));
  // `uuids` = frames 的 uuid **先 lower() 再去重**：
  //   · lower —— 绕过 admin 直写的大写行确实存在（同文件 `★ 列侧 lower` 用例压的就是它）；
  //   · 去重 —— 顺带消灭「同一 uuid 大小写两行 ⇒ 下发两个元素」。
  return { uuids: [...new Set(frames.map((f) => f.uuid.toLowerCase()))], frames };
}

route.get('/:id/beacon-uuids', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const id = c.req.param('id');
    // 可选：带上就是**节点模式**，下发该节点所绑点位的帧。C 端永远带。
    const nodeId = c.req.query('nodeId') || '';
    const [product] = await db.select({ venueId: pmsBuiWenlvProducts.venueId })
      .from(pmsBuiWenlvProducts)
      .where(and(eq(pmsBuiWenlvProducts.id, id), eq(pmsBuiWenlvProducts.status, 'published'))).limit(1);
    if (!product) return c.json({ success: false, error: '产品不存在' }, 404);

    // 「在役」+「三件套齐全」是**两种模式共同**的前置。
    //   在役 —— 与 beaconMatchesPoint 同款谓词。
    //   齐全 —— beaconMatchesPoint 对 major/minor 是**严格相等**，缺一件的行扫得到、
    //     服务端**永远判不过** ⇒ 今天下发它 = 现场「一直提示靠近、点了就失败」。
    //     不下发它，现场看到的是「没有靠近提示 + 扫码按钮还在」，那才是可诊断的失败。
    const aliveComplete = and(
      notInArray(pmsBuiWenlvBeacons.status, ['faulty', 'retired']),
      isNotNull(pmsBuiWenlvBeacons.uuid),
      isNotNull(pmsBuiWenlvBeacons.major),
      isNotNull(pmsBuiWenlvBeacons.minor),
    );
    const frameCols = {
      uuid: pmsBuiWenlvBeacons.uuid,
      major: pmsBuiWenlvBeacons.major,
      minor: pmsBuiWenlvBeacons.minor,
    };

    if (nodeId) {
      // 🔴 节点模式**刻意不带场地过滤**：触发端 beaconMatchesPoint 的谓词只有
      //    `pointId + lower(uuid) + major + minor + status`，**没有场地条件**。
      //    这里若多加一层场地过滤，一条「节点绑了别场地点位」的脏数据就会造出
      //    「客户端扫不到、服务端其实能判过」的分叉。**下发谓词必须与判定谓词同形。**
      // 新模型（0079）：节点 = 非 ending 场景，nodeId 即 scene.id；经运行时规范图取其 venuePointId。
      const room = await loadRuntimeGraph(id);
      const node = room.nodes.find((n) => n.id === nodeId);
      // `nodeId` 是新的外部输入 ⇒ 不存在 / 不属于该产品都必须显式 404，不能静默当空处理。
      if (!node) return c.json({ success: false, error: '节点不存在' }, 404);
      // 未绑点位 = 纯手动节点（没有可触发的物理位置）⇒ 空计划，**不是错误**
      // （与下面「未归属场地」同款口径）。
      if (!node.venuePointId) return c.json({ success: true, data: { uuids: [], frames: [] } });
      const rows = await db.select(frameCols)
        .from(pmsBuiWenlvBeacons)
        .where(and(eq(pmsBuiWenlvBeacons.pointId, node.venuePointId), aliveComplete));
      return c.json({ success: true, data: buildScanPlan(rows) });
    }

    // 场地模式（不带 nodeId）：保留原样，仅供兼容与现场排查；C 端永远传 nodeId。
    // 未归属场地是正常状态（不是每个剧本都绑场地）⇒ 空计划，不是错误。
    if (!product.venueId) return c.json({ success: true, data: { uuids: [], frames: [] } });
    // `selectDistinct` 是 db 的**方法**（`pg-core/db.d.ts:171`），不是 drizzle-orm 的
    // 具名导出 —— 0.45.2 的根 barrel 连 `select` 都不导出。别按直觉去 import 它，
    // 那样 tsc 会报 TS2305（本 Task 已实测踩过一次）。
    const rows = await db.selectDistinct(frameCols)
      .from(pmsBuiWenlvBeacons)
      .where(and(eq(pmsBuiWenlvBeacons.venueId, product.venueId), aliveComplete));
    return c.json({ success: true, data: buildScanPlan(rows) });
  } catch (e: any) {
    return serverError(c, e, '加载信标列表失败');
  }
});

// POST /api/mini/wenlv/sessions — 建队（P2 §4.1）。鉴权 = **领队码**（请求头）+ 登录态。
//
// 领队码 = 本订单票池的取票权（S:248 另含看全场位置）；它不可撤销、无速率限制，靠 31^12 空间兜底
// （P2 §九.2）。因此这里**不校验「登录人 == order.miniUserId」**：spec §4.1 定的凭证就是领队码，
// 而建队本身**幂等且不消耗票**（真正的消耗在入队，Task 7）⇒ 多一条归属校验只会造出
// 「组织者把码给同伴代建队」的假失败，收益为零。
route.post('/sessions', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const leaderCode = (c.req.header('X-Wenlv-Leader-Code') ?? '').trim();
    if (!leaderCode) return c.json({ success: false, error: '缺少领队码' }, 400);
    const body = await c.req.json().catch(() => ({}));
    const { teamCount } = body as { teamCount?: unknown };
    if (typeof teamCount !== 'number' || !Number.isInteger(teamCount) || teamCount < 1) {
      return c.json({ success: false, error: '队数必须是正整数' }, 400);
    }

    const res = await getWenlvOrderByLeaderCode(leaderCode);
    if (res.status === 404) return c.json({ success: false, error: '领队码无效，请回订单页重新获取' }, 404);
    // 502 与 404 必须分开：上游抖动时回 404 会让领队以为码失效、去重新下单
    if (!res.ok) return c.json({ success: false, error: '平台服务暂不可用，请稍后重试' }, 502);
    const o = (res.data?.data ?? {}) as Record<string, any>;

    if (o.status !== 'paid') {
      const why = o.status === 'pending' ? '订单未支付，队员无法入队' : '订单已失效（已退款或已取消），无法建队';
      return c.json({ success: false, error: why }, 409);
    }
    // contentProductId = null ⇒ 拿交易侧 id 建队会造出永远打不开的队（spec §4.1③）
    if (!o.contentProductId) return c.json({ success: false, error: '该剧本未绑定内容产品，请联系运营' }, 409);
    // paid 也可能是空池：D1 补座失败的单停在「paid + 券全 expired」
    if (!(Number(o.availableTicketCount) > 0)) {
      return c.json({ success: false, error: '本订单已无可用票（已用完或已过期），请重新购买' }, 409);
    }
    const quantity = Number(o.quantity);
    if (teamCount > quantity) {
      return c.json({ success: false, error: `队数不能超过订单份数（${quantity} 份）` }, 400);
    }

    // 幂等：本订单已有 forming 的队 ⇒ 直接回既有（领队刷新/重入/双击都不会重复建队）。
    // **不看这次传的 teamCount** —— 本片不支持建队后调整队数（P2 §七）。
    const existing = await db.select().from(pmsBuiWenlvSessions).where(and(
      eq(pmsBuiWenlvSessions.orderId, o.orderId),
      eq(pmsBuiWenlvSessions.status, 'forming'),
    )).orderBy(pmsBuiWenlvSessions.seq);
    if (existing.length > 0) {
      // 既有 session 可能还没建 team 行（老数据）⇒ 补建（以 session.id 为 team.id）
      for (const s of existing) {
        await getOrCreateTeamForSession(s.id, s.productId, miniUser.miniUserId);
      }
      return c.json({ success: true, data: { sessions: existing.map(publicSession), created: false } });
    }

    const created = [];
    for (let seq = 1; seq <= teamCount; seq++) {
      const s = await insertTeamOnce({
        orderId: o.orderId,
        slotId: o.slotId ?? null,
        productId: o.contentProductId,
        seq,
        name: `第 ${seq} 队`,
      });
      // 同步建 team 行（id = session.id），使领队建队后可直接用 teamId 跳转 play-team.vue
      await getOrCreateTeamForSession(s.id, s.productId, miniUser.miniUserId);
      created.push(s);
    }
    return c.json({ success: true, data: { sessions: created.map(publicSession), created: true } });
  } catch (e: any) {
    return serverError(c, e, '建队失败');
  }
});

// GET /api/mini/wenlv/sessions — 本订单的队与成员（领队台读路径，P2 §五）。
// 鉴权同上（领队码 + 登录态）。**只读**：不改票、不建行。
route.get('/sessions', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const leaderCode = (c.req.header('X-Wenlv-Leader-Code') ?? '').trim();
    if (!leaderCode) return c.json({ success: false, error: '缺少领队码' }, 400);

    const res = await getWenlvOrderByLeaderCode(leaderCode);
    if (res.status === 404) return c.json({ success: false, error: '领队码无效，请回订单页重新获取' }, 404);
    if (!res.ok) return c.json({ success: false, error: '平台服务暂不可用，请稍后重试' }, 502);
    const o = (res.data?.data ?? {}) as Record<string, any>;

    // 🔴 必须按 order_id 过滤：不过滤就把**别人的**队也列出来了（跨订单泄露队名与队伍码）
    const sessions = await db.select().from(pmsBuiWenlvSessions)
      .where(eq(pmsBuiWenlvSessions.orderId, o.orderId))
      .orderBy(pmsBuiWenlvSessions.seq);
    const ids = sessions.map((s) => s.id);
    // 一次查齐再在内存里分组（逐队查是 N+1）
    const rows = ids.length
      ? await db.select({
          sessionId: pmsBuiWenlvProgress.sessionId,
          miniUserId: pmsBuiWenlvProgress.miniUserId,
          updatedAt: pmsBuiWenlvProgress.updatedAt,
        }).from(pmsBuiWenlvProgress).where(inArray(pmsBuiWenlvProgress.sessionId, ids))
      : [];
    const bySession = new Map<string, typeof rows>();
    for (const r of rows) {
      // sessionId 在 where 里已保证非空
      const k = r.sessionId!;
      if (!bySession.has(k)) bySession.set(k, []);
      bySession.get(k)!.push(r);
    }

    return c.json({ success: true, data: {
      order: {
        quantity: Number(o.quantity),
        availableTicketCount: Number(o.availableTicketCount ?? 0),
        miniUserId: o.miniUserId,
      },
      sessions: sessions.map((s) => {
        const members = (bySession.get(s.id) ?? []).map((m) => ({
          miniUserId: m.miniUserId,
          // 领队 = 下单人（由订单判定），**不是**「第一个入队的人」——
          // 下单人也要入队才拿得到票（I1），所以「第一个」可能是任何队员。
          isLeader: m.miniUserId === o.miniUserId,
          updatedAt: m.updatedAt,
        }));
        return { ...publicSession(s), memberCount: members.length, members };
      }),
    } });
  } catch (e: any) {
    return serverError(c, e, '加载队伍名单失败');
  }
});

// POST /api/mini/wenlv/sessions/join — 队员扫码入队（P2 §4.2）。鉴权 = 登录态（**不要**领队码）。
//
// 🔴 三条顺序/归属纪律，改任何一条都会造出静默缺陷：
//   ① **先 ensureMember、后 ensureTicket**（P2 §4.2）：反过来「票挂上了、行没建」的失败态是
//      「票已出池、他**不在名单里**」（领队看不见也移不出）—— 正确顺序下失败的中间态他仍在名单里。
//   ② transfer 里的 `orderId` 取 **session.orderId**（不是别处的订单 id）：拿错就是
//      从**别人的票池**取票，票少了而没有任何报错（Step 1 第 3 条用例钉这个）。
//   ③ **转票失败时只回滚本次新建的那行**：既有行是历史（例：他的券过期了），回滚它会删掉
//      别人（或他自己的有效）入队记录。
route.post('/sessions/join', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const code = typeof (body as any)?.code === 'string' ? (body as any).code.trim() : '';
    if (!code) return c.json({ success: false, error: '缺少队伍码' }, 400);

    // ① 码 → session。**只认精确码**：大小写兜底住在 /enter（唯一的解析点）——
    //    两处各写一份解析就是两个真相源（P2 §三 反对的正是这个）。
    const [session] = await db.select().from(pmsBuiWenlvSessions)
      .where(eq(pmsBuiWenlvSessions.code, code)).limit(1);
    if (!session) return c.json({ success: false, error: '队伍码无效' }, 404);
    // 出发即封口（S:452）。本片 forming 是唯一可达值，但这条判据必须**先在**：
    // 错峰片把 status 推进接上后，它就是「已出发的队还能扫码进人」的唯一拦截点。
    if (session.status !== 'forming') return c.json({ success: false, error: '本队已出发，不能再加入' }, 409);

    // ② 先建成员行
    const created = await ensureMember(session, miniUser.miniUserId);

    // ③ 后转票。**每次都调** —— 「他名下已有本订单可用票」只有平台侧知道（`alreadyHeld`）。
    const t = await transferWenlvTicket(session.orderId, miniUser.miniUserId);
    if (!t.ok) {
      // 回滚**本次新建**的行（见 ③ 纪律）。残留可达态：**既有**成员行 + 池空（例：券过期）
      //  ⇒ 那行不动（依据 = ③：删了会抹掉他有效的入队记录）。
      if (created) await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, created.id));
      if (t.status === 409) return c.json({ success: false, error: '本场名额已满，请联系领队' }, 409);
      // status === 0（网络/超时）与其它非 2xx：与「名额满」分开，否则队员会一直重试一个死掉的平台
      return c.json({ success: false, error: '平台服务暂不可用，请稍后重试' }, 502);
    }

    const [cntRow] = await db.select({ c: count() }).from(pmsBuiWenlvProgress)
      .where(eq(pmsBuiWenlvProgress.sessionId, session.id));
    return c.json({ success: true, data: {
      sessionId: session.id,
      seq: session.seq,
      name: session.name,
      code: session.code,
      memberCount: Number(cntRow?.c ?? 0),
    } });
  } catch (e: any) {
    return serverError(c, e, '入队失败');
  }
});

// POST /api/mini/wenlv/sessions/:id/members/:miniUserId/remove — 领队移出队员（P2 §4.3）。
// 鉴权 = 领队码 + 登录态；**并校验该队属于这张订单**（否则持 A 单的码能隔单踢人）。
route.post('/sessions/:id/members/:miniUserId/remove', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const leaderCode = (c.req.header('X-Wenlv-Leader-Code') ?? '').trim();
    if (!leaderCode) return c.json({ success: false, error: '缺少领队码' }, 400);
    const sessionId = c.req.param('id');
    const targetUid = c.req.param('miniUserId');

    const res = await getWenlvOrderByLeaderCode(leaderCode);
    if (res.status === 404) return c.json({ success: false, error: '领队码无效，请回订单页重新获取' }, 404);
    if (!res.ok) return c.json({ success: false, error: '平台服务暂不可用，请稍后重试' }, 502);
    const o = (res.data?.data ?? {}) as Record<string, any>;

    const [session] = await db.select().from(pmsBuiWenlvSessions)
      .where(eq(pmsBuiWenlvSessions.id, sessionId)).limit(1);
    if (!session) return c.json({ success: false, error: '队伍不存在' }, 404);
    // 越权 ⇒ 404（不 403）：别向持码者确认「这个 id 存在，只是不属于你」
    if (session.orderId !== o.orderId) return c.json({ success: false, error: '队伍不存在' }, 404);

    // ① 先删成员行（幂等；**绝不置 NULL** —— I4：NULL 化的行既进不了场，又占散客唯一索引的槽位）
    const del = await db.delete(pmsBuiWenlvProgress)
      .where(and(eq(pmsBuiWenlvProgress.sessionId, sessionId), eq(pmsBuiWenlvProgress.miniUserId, targetUid)))
      .returning({ id: pmsBuiWenlvProgress.id });

    // ② 后退票。失败时行**保持已删**，靠重试自愈（DELETE 幂等 + return 对无票幂等）。
    const r = await returnWenlvTicket(session.orderId, targetUid);
    const [cntRow] = await db.select({ c: count() }).from(pmsBuiWenlvProgress)
      .where(eq(pmsBuiWenlvProgress.sessionId, sessionId));
    const memberCount = Number(cntRow?.c ?? 0);
    const removed = del.length > 0;

    if (!r.ok) {
      if (r.status === 409) {
        // 票已核销 ⇒ 回不去池子，但**移出已经生效**。回 409「无法移出」是在说假话
        // （P2 §4.3② 的文案作废，见 §0.5·o）。200 + warning 让 UI 如实显示。
        return c.json({ success: true, data: {
          removed, memberCount, ticketReturned: false,
          warning: '该队员的票已核销，未能回池；他已从本队移出',
        } });
      }
      return c.json({ success: false, error: '平台服务暂不可用，请稍后重试' }, 502);
    }
    return c.json({ success: true, data: { removed, memberCount, ticketReturned: true } });
  } catch (e: any) {
    return serverError(c, e, '移出队员失败');
  }
});

// ── 团队剧本：队伍（组局模式）──────────────────────────────────────────────
// 与上面 sessions（P2 票随人走的场次分队）是两套独立机制：
//   sessions = 交易层驱动、按订单分队、票随人走；
//   teams    = 玩家自发建队、邀请码拉人、选角、开局（剧本杀组局）。
// 鉴权 = 登录态（parseMiniToken），不需要领队码 / 门票。

/** 邀请码字符集：6 位大写字母+数字，剔除歧义字符 0/O/1/I（与队伍码同口径，便于现场念码/手输）。 */
const INVITE_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const INVITE_CODE_LENGTH = 6;
function genInviteCode(): string {
  let out = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i++) {
    out += INVITE_CODE_ALPHABET[randomInt(INVITE_CODE_ALPHABET.length)];
  }
  return out;
}

/** 队伍人数配置：优先读剧本 config.teamSize，缺省 min=2 / max=6（Task 10 正式落库前的兜底）。 */
function teamSizeOf(config: { teamSize?: { min: number; max: number } } | undefined) {
  const ts = config?.teamSize;
  return {
    min: typeof ts?.min === 'number' && ts.min > 0 ? ts.min : 2,
    max: typeof ts?.max === 'number' && ts.max > 0 ? ts.max : 6,
  };
}

/** 建**一支**队（剧本杀组局）。撞邀请码唯一约束 ⇒ 换码重试；**只认这一个约束名**。
 *  与 sessions 的 insertTeamOnce 同名但服务两张表，故加 Row 后缀区分。 */
async function insertTeamRowOnce(v: { productId: string; leaderId: string }) {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const [row] = await db.insert(pmsBuiWenlvTeams).values({
        id: randomUUID(),
        ...v,
        inviteCode: genInviteCode(),
        members: [{ userId: v.leaderId, joinedAt: new Date().toISOString() }],
        status: 'forming',
      }).returning();
      return row;
    } catch (e: unknown) {
      const pgErr = ((e as any)?.cause ?? e) as { code?: string; constraint?: string } | undefined;
      // 🔴 必须穿透 drizzle 包装层（同 insertTeamOnce 的注释）：`e.code` 恒 undefined。
      if (pgErr?.code === '23505' && pgErr?.constraint === 'uq_wenlv_teams_invite_code') continue;
      throw e;
    }
  }
  throw new Error('邀请码连续冲突 5 次：请检查 genInviteCode 的字符集与随机源');
}

/**
 * 扫码入队时，以 `session.id` 作为 `team.id` 在 `pms_bui_wenlv_teams` 表中 get-or-create 一条队伍记录，
 * 打通「扫码队伍码（sessions 表）」与「微信分享拉人（teams 表）」两套体系，使 play-team.vue 能拿到 teamId。
 *
 * - 已存在 ⇒ 确保当前用户在 members 中（不在则追加）
 * - 不存在 ⇒ 以当前用户为 leader 创建
 * 两个用户扫同一支队伍码 ⇒ 命中同一 session.id ⇒ 同一 team.id ⇒ 同一支队伍。
 */
async function getOrCreateTeamForSession(
  sessionId: string, productId: string, miniUserId: string,
) {
  let [team] = await db.select().from(pmsBuiWenlvTeams)
    .where(eq(pmsBuiWenlvTeams.id, sessionId)).limit(1);

  if (!team) {
    // 用 session.id 作为 team.id，撞码（主键）即另一用户刚创建 ⇒ 重读。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        [team] = await db.insert(pmsBuiWenlvTeams).values({
          id: sessionId,
          productId,
          leaderId: miniUserId,
          inviteCode: genInviteCode(),
          members: [{ userId: miniUserId, joinedAt: new Date().toISOString() }],
          status: 'forming',
        }).returning();
        break;
      } catch (e: unknown) {
        const pgErr = ((e as any)?.cause ?? e) as { code?: string } | undefined;
        if (pgErr?.code === '23505') {
          // 主键或邀请码冲突 ⇒ 重读已有行
          [team] = await db.select().from(pmsBuiWenlvTeams)
            .where(eq(pmsBuiWenlvTeams.id, sessionId)).limit(1);
          if (team) break;
          continue;
        }
        throw e;
      }
    }
  }

  if (!team) throw new Error('getOrCreateTeamForSession: 未能获取或创建队伍');

  // 确保当前用户在 members 中
  const members = Array.isArray(team.members) ? team.members : [];
  if (!members.some((m: any) => m.userId === miniUserId)) {
    const [updated] = await db.update(pmsBuiWenlvTeams).set({
      members: [...members, { userId: miniUserId, joinedAt: new Date().toISOString() }],
    }).where(eq(pmsBuiWenlvTeams.id, sessionId)).returning();
    team = updated;
  }

  return team;
}

/** 队伍详情投影：只下发展示需要的字段，内部无敏感列可泄，但保持显式投影便于将来加列不意外出境。
 *  Task 12：下发 `progress`（队伍共享进度 + 协作题答题状态），供前端轮询展示全员进度。
 *  Task MTE：下发 `completedAt`（团队结算时间，供 TeamResult 展示总用时）。 */
function publicTeam(t: {
  id: string; productId: string; leaderId: string; inviteCode: string;
  members: any[]; squads: any[] | null; status: string; createdAt: string | Date;
  completedAt?: string | Date | null;
  progress?: any;
}) {
  return {
    id: t.id,
    productId: t.productId,
    leaderId: t.leaderId,
    inviteCode: t.inviteCode,
    members: Array.isArray(t.members) ? t.members : [],
    squads: Array.isArray(t.squads) ? t.squads : [],
    progress: t.progress ?? { visited: {}, collected: {}, completed: {} },
    status: t.status,
    createdAt: t.createdAt,
    completedAt: t.completedAt ?? null,
  };
}

/** 读取队伍并校验当前用户是队员、队伍已开局（Task 12 团队进度同步）。
 *  返回 team 行；校验失败时返回 null（调用方负责回 4xx）。
 *  - 队伍不存在 → 404
 *  - 非队员 → 403
 *  - 非 playing 状态 → 409（forming 阶段不推进度）
 */
async function getPlayingTeam(teamId: string, miniUserId: string) {
  const [team] = await db.select().from(pmsBuiWenlvTeams)
    .where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
  if (!team) return { error: '队伍不存在', status: 404 } as const;
  const members = Array.isArray(team.members) ? team.members : [];
  if (!members.some((m: any) => m.userId === miniUserId)) {
    return { error: '你不在这支队伍里', status: 403 } as const;
  }
  if (team.status !== 'playing') {
    return { error: '队伍未开局，不能推进进度', status: 409 } as const;
  }
  return { team, members } as const;
}

// POST /api/mini/wenlv/teams — 创建队伍（组局）。body: { productId }
route.post('/teams', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const productId = typeof (body as any)?.productId === 'string' ? (body as any).productId.trim() : '';
    if (!productId) return c.json({ success: false, error: '缺少剧本 ID' }, 400);

    // 剧本须存在且已发布（草稿不可组局）。
    const [product] = await db.select({
      id: pmsBuiWenlvProducts.id,
      status: pmsBuiWenlvProducts.status,
      config: pmsBuiWenlvProducts.config,
    }).from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
    if (!product || product.status !== 'published') {
      return c.json({ success: false, error: '剧本不存在或未发布' }, 404);
    }

    const team = await insertTeamRowOnce({ productId, leaderId: miniUser.miniUserId });
    return c.json({ success: true, data: publicTeam(team as any) });
  } catch (e: any) {
    return serverError(c, e, '创建队伍失败');
  }
});

// POST /api/mini/wenlv/teams/join — 加入队伍。body: { inviteCode } 或 { teamId }
//   · teamId：直接按主键查队（用于微信分享拉人，分享链接带 teamId）
//   · inviteCode：6 位邀请码查队（手动输入邀请码路径）
// 二选一：都没有 ⇒ 400。teamId 优先（如果两个都给，按 teamId 查）。
route.post('/teams/join', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const teamIdRaw = typeof (body as any)?.teamId === 'string' ? (body as any).teamId.trim() : '';
    const inviteCode = typeof (body as any)?.inviteCode === 'string' ? (body as any).inviteCode.trim().toUpperCase() : '';
    if (!teamIdRaw && !inviteCode) {
      return c.json({ success: false, error: '缺少 teamId 或 inviteCode' }, 400);
    }

    const [team] = teamIdRaw
      ? await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, teamIdRaw)).limit(1)
      : await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.inviteCode, inviteCode)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在或邀请码无效' }, 404);
    if (team.status !== 'forming') return c.json({ success: false, error: '队伍已开局，不能再加入' }, 409);

    const members = Array.isArray(team.members) ? team.members : [];
    // 已在队里 ⇒ 幂等返回，不重复加人。
    if (members.some((m: any) => m.userId === miniUser.miniUserId)) {
      return c.json({ success: true, data: publicTeam(team as any) });
    }

    // 人数上限从剧本 teamSize.max 读，缺省 6。
    const [product] = await db.select({ config: pmsBuiWenlvProducts.config })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, team.productId)).limit(1);
    const { max } = teamSizeOf(product?.config as any);
    if (members.length >= max) {
      return c.json({ success: false, error: '队伍人数已满' }, 409);
    }

    const updated = await db.update(pmsBuiWenlvTeams).set({
      members: [...members, { userId: miniUser.miniUserId, joinedAt: new Date().toISOString() }],
    }).where(eq(pmsBuiWenlvTeams.id, team.id)).returning();
    return c.json({ success: true, data: publicTeam(updated[0] as any) });
  } catch (e: any) {
    return serverError(c, e, '加入队伍失败');
  }
});

// POST /api/mini/wenlv/teams/:id/leave — 离开队伍
//   · 非队长：直接从 members 移除
//   · 队长：若仅剩自己一人 ⇒ 解散队伍（删行）；否则转让队长给最早入队的下一人
route.post('/teams/:id/leave', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const teamId = c.req.param('id');
    const [team] = await db.select().from(pmsBuiWenlvTeams)
      .where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);

    const members = Array.isArray(team.members) ? team.members : [];
    const myIdx = members.findIndex((m: any) => m.userId === miniUser.miniUserId);
    if (myIdx === -1) return c.json({ success: false, error: '你不在这支队伍里' }, 409);

    const isLeader = team.leaderId === miniUser.miniUserId;
    if (isLeader) {
      if (members.length <= 1) {
        // 队长独自离队 ⇒ 解散
        await db.delete(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, team.id));
        return c.json({ success: true, data: { disbanded: true } });
      }
      // 转让队长：按 joinedAt 升序取最早入队的下一人（members[0] 通常是队长，取 members[1]）。
      const rest = members.filter((m: any) => m.userId !== miniUser.miniUserId);
      const nextLeader = [...rest].sort((a: any, b: any) =>
        new Date(a.joinedAt).getTime() - new Date(b.joinedAt).getTime())[0];
      const updated = await db.update(pmsBuiWenlvTeams).set({
        leaderId: nextLeader.userId,
        members: rest,
      }).where(eq(pmsBuiWenlvTeams.id, team.id)).returning();
      return c.json({ success: true, data: publicTeam(updated[0] as any) });
    }

    // 非队长：直接移除
    const rest = members.filter((m: any) => m.userId !== miniUser.miniUserId);
    const updated = await db.update(pmsBuiWenlvTeams).set({ members: rest })
      .where(eq(pmsBuiWenlvTeams.id, team.id)).returning();
    return c.json({ success: true, data: publicTeam(updated[0] as any) });
  } catch (e: any) {
    return serverError(c, e, '离开队伍失败');
  }
});

// POST /api/mini/wenlv/teams/:id/select-character — 选角。body: { characterId }
// 互斥校验：同一 characterId 不能被两人选，除非剧本 allowDuplicateRoles=true。
route.post('/teams/:id/select-character', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const teamId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const characterId = typeof (body as any)?.characterId === 'string' ? (body as any).characterId.trim() : '';
    if (!characterId) return c.json({ success: false, error: '缺少角色 ID' }, 400);

    const [team] = await db.select().from(pmsBuiWenlvTeams)
      .where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);
    if (team.status !== 'forming') return c.json({ success: false, error: '已开局，不能更换角色' }, 409);

    const members = Array.isArray(team.members) ? team.members : [];
    const myIdx = members.findIndex((m: any) => m.userId === miniUser.miniUserId);
    if (myIdx === -1) return c.json({ success: false, error: '你不在这支队伍里' }, 409);

    // 角色须属于本剧本
    const [char] = await db.select({ id: pmsBuiWenlvCharacters.id })
      .from(pmsBuiWenlvCharacters)
      .where(and(eq(pmsBuiWenlvCharacters.productId, team.productId), eq(pmsBuiWenlvCharacters.id, characterId)))
      .limit(1);
    if (!char) return c.json({ success: false, error: '角色不存在' }, 404);

    // 互斥校验：除非 allowDuplicateRoles，否则同一角色不能被两人选
    const [product] = await db.select({ config: pmsBuiWenlvProducts.config })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, team.productId)).limit(1);
    const allowDup = Boolean((product?.config as any)?.allowDuplicateRoles);
    if (!allowDup && members.some((m: any) => m.userId !== miniUser.miniUserId && m.characterId === characterId)) {
      return c.json({ success: false, error: '该角色已被其他队员选择' }, 409);
    }

    const updatedMembers = members.map((m: any, i: number) =>
      i === myIdx ? { ...m, characterId } : m);
    const updated = await db.update(pmsBuiWenlvTeams).set({ members: updatedMembers })
      .where(eq(pmsBuiWenlvTeams.id, team.id)).returning();
    return c.json({ success: true, data: publicTeam(updated[0] as any) });
  } catch (e: any) {
    return serverError(c, e, '选角失败');
  }
});

// POST /api/mini/wenlv/teams/:id/start — 队长开局
// 仅队长可操作；校验人数 ≥ teamSize.min 且全员已选角；status → playing。
route.post('/teams/:id/start', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const teamId = c.req.param('id');
    const [team] = await db.select().from(pmsBuiWenlvTeams)
      .where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);
    if (team.leaderId !== miniUser.miniUserId) {
      return c.json({ success: false, error: '仅队长可开局' }, 403);
    }
    if (team.status !== 'forming') return c.json({ success: false, error: '队伍已开局' }, 409);

    const members = Array.isArray(team.members) ? team.members : [];
    const [product] = await db.select({ config: pmsBuiWenlvProducts.config })
      .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, team.productId)).limit(1);
    const { min } = teamSizeOf(product?.config as any);

    if (members.length < min) {
      return c.json({ success: false, error: `队伍人数不足（至少 ${min} 人）` }, 409);
    }
    if (members.some((m: any) => !m.characterId)) {
      return c.json({ success: false, error: '请先让所有队员选择角色' }, 409);
    }

    const updated = await db.update(pmsBuiWenlvTeams).set({ status: 'playing' })
      .where(eq(pmsBuiWenlvTeams.id, team.id)).returning();

    // 授予角色专属线索：遍历队员，按 characterId 从 product.config.exclusiveClues 取线索 id 列表，
    // 写入该队员 progress.state.collected。
    const exclusiveClues = ((product?.config as any)?.exclusiveClues ?? {}) as Record<string, string[]>;
    if (Object.keys(exclusiveClues).length > 0) {
      for (const member of members) {
        if (!member.characterId) continue;
        const clueIds = exclusiveClues[member.characterId] ?? [];
        if (clueIds.length === 0) continue;
        let [prog] = await db.select({ id: pmsBuiWenlvProgress.id, state: pmsBuiWenlvProgress.state })
          .from(pmsBuiWenlvProgress)
          .where(and(eq(pmsBuiWenlvProgress.productId, team.productId), eq(pmsBuiWenlvProgress.miniUserId, member.userId)))
          .limit(1);
        // progress 不存在时创建（团队模式下玩家可能未调用个人 /start）
        if (!prog) {
          const [created] = await db.insert(pmsBuiWenlvProgress).values({
            id: randomUUID(),
            productId: team.productId,
            miniUserId: member.userId,
            characterId: member.characterId,
            state: { visited: {}, collected: {}, completed: {} },
          }).returning({ id: pmsBuiWenlvProgress.id, state: pmsBuiWenlvProgress.state });
          prog = created;
        }
        if (prog) {
          const state = (prog.state ?? { visited: {}, collected: {}, completed: {} }) as WenlvState;
          const collected = { ...(state.collected ?? {}) };
          for (const cid of clueIds) collected[cid] = true;
          await db.update(pmsBuiWenlvProgress)
            .set({ state: { ...state, collected }, updatedAt: new Date() })
            .where(eq(pmsBuiWenlvProgress.id, prog.id));
        }
      }
    }

    return c.json({ success: true, data: publicTeam(updated[0] as any) });
  } catch (e: any) {
    return serverError(c, e, '开局失败');
  }
});

// POST /api/mini/wenlv/teams/:id/squads — 队长创建小队。body: { name }
route.post('/teams/:id/squads', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const teamId = c.req.param('id');
    const { name } = await c.req.json();
    if (!name || !name.trim()) return c.json({ success: false, error: '小队名称不能为空' }, 400);
    const [team] = await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);
    if (team.leaderId !== miniUser.miniUserId) return c.json({ success: false, error: '仅队长可创建小队' }, 403);
    const squadId = `SQD_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const squads = [...(team.squads ?? []), { id: squadId, name: name.trim(), memberIds: [] }];
    await db.update(pmsBuiWenlvTeams).set({ squads }).where(eq(pmsBuiWenlvTeams.id, teamId));
    return c.json({ success: true, data: { squadId, squads } });
  } catch (e: any) {
    return serverError(c, e, '创建小队失败');
  }
});

// POST /api/mini/wenlv/teams/:id/squads/:squadId/assign — 队长分配成员到小队。body: { userId }
// 将指定 userId 加入目标小队，同时从其他小队中移除（一人只能在一个小队）。
route.post('/teams/:id/squads/:squadId/assign', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const teamId = c.req.param('id');
    const squadId = c.req.param('squadId');
    const { userId } = await c.req.json();
    if (!userId) return c.json({ success: false, error: '缺少 userId' }, 400);
    const [team] = await db.select().from(pmsBuiWenlvTeams).where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);
    if (team.leaderId !== miniUser.miniUserId) return c.json({ success: false, error: '仅队长可分配小队' }, 403);
    const members = Array.isArray(team.members) ? team.members : [];
    if (!members.some((m: any) => m.userId === userId)) {
      return c.json({ success: false, error: '该用户不在队伍中' }, 400);
    }
    const squads = (team.squads ?? []).map((sq: any) => ({
      ...sq,
      memberIds: sq.id === squadId
        ? [...new Set([...(sq.memberIds ?? []), userId])]
        : (sq.memberIds ?? []).filter((mid: string) => mid !== userId)
    }));
    await db.update(pmsBuiWenlvTeams).set({ squads }).where(eq(pmsBuiWenlvTeams.id, teamId));
    return c.json({ success: true, data: { squads } });
  } catch (e: any) {
    return serverError(c, e, '分配小队失败');
  }
});

// GET /api/mini/wenlv/teams/:id — 获取队伍详情（含 memberStates：每人各自的角色/在线/收集/走访/协作答题状态）
route.get('/teams/:id', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const teamId = c.req.param('id');
    const [team] = await db.select().from(pmsBuiWenlvTeams)
      .where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);

    // memberStates：查队伍所有成员的 progress 行，统计各自 state。
    const members = Array.isArray(team.members) ? team.members : [];
    const memberUserIds = members.map((m: any) => m.userId);
    const memberProgresses = memberUserIds.length
      ? await db.select().from(pmsBuiWenlvProgress)
          .where(and(
            eq(pmsBuiWenlvProgress.sessionId, teamId),
            inArray(pmsBuiWenlvProgress.miniUserId, memberUserIds),
          ))
      : [];

    // 角色名映射：按 team.productId 查全组角色，id → name
    const characters = await db.select().from(pmsBuiWenlvCharacters)
      .where(eq(pmsBuiWenlvCharacters.productId, team.productId));
    const charMap = new Map(characters.map((ch) => [ch.id, ch.name]));

    // 节点名映射：visited 键集合 → 节点标题
    const allVisitedIds = new Set<string>();
    for (const p of memberProgresses) {
      const v = (p.state as any)?.visited ?? {};
      Object.keys(v).forEach((k) => allVisitedIds.add(k));
    }
    // 新模型：visited 键 = scene.id，标题取自 scenes（空集合仓储内部不查库）。
    const nodes = await findSceneTitlesByIds([...allVisitedIds]);
    const nodeMap = new Map(nodes.map((n) => [n.id, n.title]));

    // 协作题答题状态：team.progress.collaborativeAnswers，key = nodeId（单题节点）
    const collabAnswers = (team.progress as any)?.collaborativeAnswers ?? {};

    const memberStates = members.map((m: any) => {
      const p = memberProgresses.find((mp) => mp.miniUserId === m.userId);
      const state = (p?.state as any) ?? { visited: {}, collected: {}, completed: {} };
      const visited = state.visited ?? {};
      const collected = state.collected ?? {};
      // 最新触发节点：state 只有 boolean、无时间戳，兜底取 visited 键列表的最后一个
      // （JS 字符串键保留插入序，最后写入者即末位 —— 真要严格时序要走 events 流水，不在本端点）
      const visitedKeys = Object.keys(visited);
      const latestNodeId = visitedKeys.length ? visitedKeys[visitedKeys.length - 1] : null;
      return {
        userId: m.userId,
        characterId: m.characterId ?? null,
        characterName: m.characterId ? (charMap.get(m.characterId) ?? null) : null,
        // online：60s 内有 progress.updatedAt 即为 true
        online: p ? (Date.now() - new Date(p.updatedAt).getTime()) < 60000 : false,
        lastActiveAt: p?.updatedAt ?? null,
        collectedCount: Object.keys(collected).length,
        visitedCount: Object.keys(visited).length,
        latestNodeId,
        latestNodeName: latestNodeId ? (nodeMap.get(latestNodeId) ?? null) : null,
        // 协作题答题状态：粗粒度返回该用户是否在 collaborativeAnswers 任意 key 下有记录
        collabAnswered: Object.keys(collabAnswers).some((k) => {
          const a = collabAnswers[k];
          return a && typeof a === 'object' && (a as any)[m.userId] !== undefined;
        }),
      };
    });

    return c.json({ success: true, data: { ...publicTeam(team as any), memberStates } });
  } catch (e: any) {
    return serverError(c, e, '加载队伍失败');
  }
});

// POST /api/mini/wenlv/teams/:id/complete — 队长结算队伍。
//   · 仅队长可调用（403 否则）
//   · status 须为 playing（409 否则）
//   · 幂等：已 completed 直接返回当前行
route.post('/teams/:id/complete', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const teamId = c.req.param('id');
    const [team] = await db.select().from(pmsBuiWenlvTeams)
      .where(eq(pmsBuiWenlvTeams.id, teamId)).limit(1);
    if (!team) return c.json({ success: false, error: '队伍不存在' }, 404);
    if (team.leaderId !== miniUser.miniUserId) {
      return c.json({ success: false, error: '只有队长可以结算队伍' }, 403);
    }
    // 幂等：已 completed 直接返回。
    if (team.status === 'completed') {
      return c.json({ success: true, data: publicTeam(team as any) });
    }
    if (team.status !== 'playing') {
      return c.json({ success: false, error: '队伍未开局，不能结算' }, 409);
    }
    const updated = await db.update(pmsBuiWenlvTeams).set({
      status: 'completed',
      completedAt: new Date(),
    }).where(eq(pmsBuiWenlvTeams.id, team.id)).returning();
    return c.json({ success: true, data: publicTeam(updated[0] as any) });
  } catch (e: any) {
    return serverError(c, e, '结算队伍失败');
  }
});

// GET /api/mini/wenlv/:id — 产品详情（节点/线索/结局，谜题答案已脱敏）
route.get('/:id', async (c) => {
  try {
    const id = c.req.param('id');
    // 详情仅服务已发布产品：草稿/下架与不存在同语义（游客不可直达草稿）
    const [product] = await db.select().from(pmsBuiWenlvProducts)
      .where(and(eq(pmsBuiWenlvProducts.id, id), eq(pmsBuiWenlvProducts.status, 'published'))).limit(1);
    if (!product) return c.json({ success: false, error: '产品不存在' }, 404);
    // 独立实体表仍按 productId 直查（收集品/档位/奖励/角色不挂章节结构，新模型继续使用）。
    const [collectibles, tiers, rewards, characters] = await Promise.all([
      db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, id)),
      db.select().from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, id)).orderBy(pmsBuiWenlvRewardTiers.order),
      db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, id)),
      db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, id))
        .orderBy(pmsBuiWenlvCharacters.order, pmsBuiWenlvCharacters.createdAt),
    ]);
    // 统一模型：nodes/edges/endings/npcs 全部来自规范图（room→chapters→scenes→flows→npcs），
    // 不再读旧 nodes/node_edges/endings 表。无剧本房（未搭建内容的已发布门票）时 graph=null，
    // 各投影数组为空，等价于“空剧本”（旧表在 0079 清空后本就无数据）。
    const graph = await loadRoomGraphByContentId(id);
    const graphScenes = graph?.scenes ?? [];
    // scenes → 旧 node 行契约（含全玩法字段），供下方 safeNodes 脱敏 map 零改动复用。
    const nodes = projectScenesToNodes(graphScenes, id);
    const edges = projectFlowsToEdges(graph?.flows ?? []).edges;
    // 结局由 type='ending' 场景承载（内部形态含 triggerCondition 供引擎；下发前再剥除，见 safeEndings）。
    const endingRows = projectScenesToEndings(graphScenes);
    const npcs = graph?.npcs ?? [];
    // 点位名投影：新节点把点位名写进 DTO 的 location（覆盖旧的文本 location）。
    // 只投影 name —— code 是到场凭证，绝不能随公开详情下发。
    const pointIds = [...new Set(nodes.map((n) => n.venuePointId).filter((v): v is string => !!v))];
    const pointRows = pointIds.length
      ? await db.select({ id: pmsBuiWenlvVenuePoints.id, name: pmsBuiWenlvVenuePoints.name })
          .from(pmsBuiWenlvVenuePoints).where(inArray(pmsBuiWenlvVenuePoints.id, pointIds))
      : [];
    const pointNameMap = new Map(pointRows.map((p) => [p.id, p.name]));
    // 剔除触发凭证（beacon 信标 ID / qrcode 到场秘密）与点位 id，
    // 公开详情绝不下发，防游客免凭证远程打卡（点位码由 /trigger 单独校验，不在详情里给）。
    // 客户端契约版本门（x-client-version 头）：1.1.0 起走二元新契约（nodeType 仅 scene/npc、
    // 无 driverType）；1.0.x 旧版仍按历史线格式（scene/puzzle/npc/...）渲染。线上 1.0.x 的
    // driverType 自 0065 起从未真正收到过（列已脱离 ORM），driverType 仅作占位补 'traditional'，
    // 绝不报 'npc' —— NpcChatStage 在旧版从未点亮过，占位报 npc 反而会凭空激活对话模式。
    const useBinary = clientSupportsBinaryNodes(c.req.header('x-client-version'));
    const safeNodes = nodes.map((n) => {
      // legacyNodeType 仅供下面旧版投影派生，任何版本都不进 DTO（新版无此键，旧版只收投影后的 nodeType）。
      const { venuePointId, legacyNodeType, ...safe } = n;
      void venuePointId;
      const safeChapterGoal = safe.chapterGoal ? (() => {
        const { answerCriteria, ...rest } = safe.chapterGoal;
        return { ...rest, criteriaHints: desensitizeCriteria(normalizeCriteria(answerCriteria)) };
      })() : null;
      // 基础 dto：chapterGoal 脱敏 / location / requiresCredential / stripAnswers 与原投影一字不差。
      // 用 Record<string, unknown> 承接两版差异字段（旧版覆写 nodeType + 补 driverType）。
      const dto: Record<string, unknown> = {
        ...safe,
        chapterGoal: safeChapterGoal,
        // 点位存在时以点位的名称为准；否则回退存量节点的文本 location。
        // 与创作台 `/products/:id/full` 共用 nodeDisplayLocation —— 各写一份正是
        // 2026-09-19「同一节点两端显示不同地名」的成因。
        // 用上面解构出的 venuePointId（局部变量）：绝不能再把它放回 safe 下发给公开详情。
        location: nodeDisplayLocation({ venuePointId }, pointNameMap),
        // 「这个节点要不要到现场凭证」—— 派生自 nodeRequiresCredential()，
        // 与 /trigger 的凭证门、/answer 的到场门**同一份谓词**，不会各自漂移。
        // 只下发布尔，不下发 venuePointId / 凭证本身。
        requiresCredential: nodeRequiresCredential(n),
        puzzle: stripAnswers(safe.puzzle),
        // 实景解密原子（spec §8）：节点自带 atoms 时优先下发；老剧本无 atoms 则把 puzzle
        // 投影为兼容 quiz 原子（id 固定 quiz_main），新渲染链路一份数据吃两种剧本；皆空 ⇒ null。
        // 显式覆盖上方 ...safe 带出的裸 atoms 列（裸值没有 puzzle 回落）。只新增此一键，
        // 既有字段（含 puzzle 脱敏）一字未动；旧客户端忽略未知键。
        // 安全铁律：atoms 通道与 puzzle 同等待遇——逐原子过 toClientAtom，剥离服务端
        // /answer 核验专用的剧透键（answer/expectedCode/criteria/revealText），防答案经新
        // 通道绕过 stripAnswers 回流；核验在服务端读 DB 真值，不依赖本 DTO。
        atoms: (() => {
          const fallback = puzzleToAtom(n.puzzle ?? null);
          const src = (n.atoms && n.atoms.length > 0) ? n.atoms : (fallback ? [fallback] : null);
          return src ? src.map(toClientAtom) : null;
        })(),
      };
      if (!useBinary) {
        // 旧版投影：nodeType 按 legacy_node_type 影子列逐字回吐历史线格式（0074 封存的
        // v1:npc/v1:puzzle/v1:scene…），二元时代新生行才按真实类型 + puzzle 派生；
        // driverType 恒补 'traditional' 占位（线上旧版从未收到过该键，见上方块注释）。
        // 谜题判定用**脱敏前**的 n.puzzle 真值，不看 stripAnswers 的结果（最稳）。
        dto.nodeType = legacyWireNodeType({ nodeType: safe.nodeType, legacyNodeType, puzzle: n.puzzle });
        dto.driverType = 'traditional';
      }
      // useBinary=true：dto.nodeType 仍是 ...safe 带进来的真实二元值（scene/npc），
      // legacyNodeType 已在上方解构剔除，driver_type 列已被 0074 DROP ⇒ dto 绝无这两个键。
      return dto;
    });
    const rewardMap = new Map(rewards.map((r) => [r.id, r]));
    // tiers 只下发展示字段（含奖励名/类型供端面展示），不下发 condition 防游客预知阈值/作弊
    const safeTiers = tiers.map((t) => {
      const r = t.rewardId ? rewardMap.get(t.rewardId) : null;
      return { id: t.id, name: t.name, description: t.description, order: t.order, icon: t.icon,
               rewardId: t.rewardId, rewardName: r?.name ?? null, rewardType: r?.type ?? null, rewardValue: r?.value ?? null };
    });
    // NPC 端面投影（spec §8.6）：只下发展示字段 { id, name, portraitUrl, voiceId, characterId, lines }。
    // **剥除** description / role / portraitPrompt / order —— 创作台字段，端面不读、不该泄给游客。
    // 与 safeNodes / safeTiers 同构：显式白名单 + 空数组兜底（lines 默认 []，缺字段降级不抛）。
    const safeNpcs = npcs.map((n) => {
      const rawLines = Array.isArray(n.lines) ? n.lines : [];
      const lines = rawLines.map((l: any) => ({
        id: typeof l?.id === 'string' ? l.id : '',
        text: typeof l?.text === 'string' ? l.text : '',
        voiceUrl: typeof l?.voiceUrl === 'string' ? l.voiceUrl : null,
        duration: typeof l?.duration === 'number' ? l.duration : undefined,
      })).filter((l: any) => l.id !== '');
      const persona = toClientNpcPersona(n.persona);
      return {
        id: n.id,
        name: n.name,
        portraitUrl: n.portraitUrl ?? null,
        voiceId: n.voiceId ?? '',
        characterId: n.characterId ?? null,
        lines,
        // 人格卡（创作侧静态人设六键，对齐 pms-nimi WenlvNpcPersona）；为空不下发该键。
        // memory（跨章运行时印象）/relationships/pendingMentions/portraitPrompt 等绝不下发。
        ...(persona ? { persona } : {}),
      };
    });
    // 角色端面投影（spec §7 的最小投影）：只下发展示所需，与 safeNodes / safeTiers / safeNpcs 同款。
    // **剥除** ipPrompt（文生图 prompt，生成侧字段）与 role / productId / order / 时间戳 ——
    // 创作台字段，端面不读、也不该泄给游客。`collectibles` / `endings` 那两个整行下发是历史遗留，
    // **不是**可以照抄的先例。
    // ⚠️ 恒返回数组（不是 undefined）：端面 v-for 拿到 undefined 不报错，只会**整块不渲染**
    //    —— 表现为「选角页空白但页面正常」，最难查。见 spec §7 的代码层兜底要求。
    const safeCharacters = characters.map((c) => ({
      id: c.id,
      name: c.name,
      faction: c.faction,
      factionColor: c.factionColor,
      identity: c.identity,
      identityDesc: c.identityDesc,
      avatarUrl: c.avatarUrl,
      vitality: c.vitality,
      wisdom: c.wisdom,
      insight: c.insight,
      skills: c.skills,
      // hiddenQuest 原样（只含 title/description/collectible_ids，本就无生成侧字段）。
      // ⚠️ **不含 progress** —— 进度由端面从 state.collected 实时算（spec §4.3）。
      //    `collectible_ids` 随之下发是**有意**的：端面要靠它算 total（登记见**外层仓** docs/superpowers/plans/2026-09-29-wenlv-script-characters.md §7.5）。
      hiddenQuest: c.hiddenQuest,
    }));
    // 结局端面投影（type='ending' 场景承载，对齐 pms-nimi WenlvEnding）：白名单六字段。
    // 🔴 triggerCondition 绝不下发 —— 它供服务端 selectEnding/findTriggeredEndings 裁决，
    //    下发等于让游客预知结局触发条件/作弊；旧 endings 整行下发是历史遗留，此处不照抄。
    const safeEndings = endingRows.map(projectEndingToClient);
    // 设计 token：模板 tokens 经产品 theme 覆盖后的最终值；未引用模板时为 {}
    const designTokens = await loadDesignTokensForProduct(product);

    // 场地名：products 行上只有 venue_id，名字在 venues 表。
    // 与上面 pointRows 同款 —— 有 id 才查、只投影需要的列、查不到给 null（不抛、不影响详情）。
    // venue_id 为 NULL 是正常状态（不是所有剧本都绑场地），此时 venueName 为 null。
    let venueName: string | null = null;
    if (product.venueId) {
      const [v] = await db.select({ name: pmsBuiWenlvVenues.name })
        .from(pmsBuiWenlvVenues)
        .where(eq(pmsBuiWenlvVenues.id, product.venueId))
        .limit(1);
      venueName = v?.name ?? null;
    }

    // 环境音：创作台的 soundStyle → OSS 曲库地址。
    // resolveBgmUrl 永不返回 undefined（未匹配落默认风格），前端无需判空。
    const bgmUrl = resolveBgmUrl(designTokens.soundStyle);

    return c.json({ success: true, data: { ...pickPublicProduct(product), designTokens, nodes: safeNodes, collectibles, endings: safeEndings, tiers: safeTiers, npcs: safeNpcs, characters: safeCharacters, bgmUrl, venueName, edges } });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// GET /api/mini/wenlv/:id/progress — 我的进度
route.get('/:id/progress', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const productId = c.req.param('id');
    const row = await getProgress(productId, miniUser.miniUserId);
    if (!row) return c.json({ success: true, data: null });
    const mine = row.state as WenlvState;
    // S §6.3：团队场次下「我的进度」= 队伍并集（主）+ 我的（次）。散客场次两者相同 —— 仍然都下发，
    // 让客户端**不必分叉**（少一个 branch 就少一处「团队场次忘了走并集」的静默洞）。
    //
    // 团队模式（组局）：union 取 team.progress（队伍并集）。
    // team.progress 由协作题判定等流程写入，是队伍共享的进度；再 merge 本人 mine 兜底最新改动。
    let union: WenlvState = mine;
    const teamRows = await db.select({ progress: pmsBuiWenlvTeams.progress, members: pmsBuiWenlvTeams.members })
      .from(pmsBuiWenlvTeams)
      .where(and(eq(pmsBuiWenlvTeams.productId, productId), eq(pmsBuiWenlvTeams.status, 'playing')));
    const teamRow = teamRows.find((t: any) =>
      Array.isArray(t.members) && t.members.some((m: any) => m.userId === miniUser.miniUserId));
    if (teamRow?.progress) {
      const teamState = (teamRow.progress as any) ?? {};
      union = mergeStates([teamState, mine]);
    } else if (row.sessionId) {
      union = await sessionUnionState(row.sessionId, productId);
    }
    return c.json({ success: true, data: { ...row, union, mine } });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// GET /api/mini/wenlv/:id/claim-state — 我的集章档位动态状态（met/claimed/need）
// tier condition 不下发（防作弊），由后端按本人 state 求值；登录即可，不需门票（同 /:id/claims 语义）
route.get('/:id/claim-state', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const productId = c.req.param('id');
    const [tiers, progress, claims] = await Promise.all([
      db.select().from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, productId)),
      getProgress(productId, miniUser.miniUserId),
      db.select().from(pmsBuiWenlvClaims)
        .where(and(eq(pmsBuiWenlvClaims.productId, productId), eq(pmsBuiWenlvClaims.miniUserId, miniUser.miniUserId))),
    ]);
    // 团队场次不发个人档位（§八 U1(b)）⇒ 空档位。拿并集算会造出「并集满足 ⇒ 人人可领」；
    // 拿自己算又与「队伍为主」的口径打架。整条通道关闭，客户端据 `tiers.length === 0` 显示空态。
    if (progress?.sessionId) return c.json({ success: true, data: buildClaimState([], new Set(), null) });
    const data = buildClaimState(tiers, new Set(claims.map((x) => x.tierId)), (progress?.state ?? null) as WenlvState | null);
    return c.json({ success: true, data });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// POST /api/mini/wenlv/:id/start — 开始体验（创建/返回进度）
route.post('/:id/start', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const productId = c.req.param('id');
    // 角色选定：仅在首次建行时写入 characterId；已有进度不更新（角色选定后不可中途更换）。
    const body = await c.req.json().catch(() => ({}));
    const characterId = typeof body.characterId === 'string' ? body.characterId : undefined;
    // 引擎加固：start 仅服务已发布产品，草稿不可被已持票游客提前体验
    const [published] = await db.select().from(pmsBuiWenlvProducts)
      .where(and(eq(pmsBuiWenlvProducts.id, productId), eq(pmsBuiWenlvProducts.status, 'published'))).limit(1);
    if (!published) return c.json({ success: false, error: '产品不存在或未发布' }, 404);
    // M5 可回看：先取既有进度——已通关（status=completed，含 endingId/completedAt）放行回看，不再要求门票券。
    // completed 只能由曾通过 trigger/answer（均强门票断言）达成的行产出；放行仅只读返回，不能写任何新状态。
    // 🔴 与 `/:id/progress` **同一条通道判定**（P2 §4.4 把这两处并列）：有团队行 ⇒ 团队行优先。
    //    旧实现内联了一条无排序 `.limit(1)` ⇒ 同一人有散客行+团队行时，取到哪行由 PG 行序决定
    //    （最坏：取到**已通关的散客行** ⇒ 队员被放行去看散客回看视图，而不是本队进度）。
    const existing = await getProgress(productId, miniUser.miniUserId);
    if (existing && existing.status === 'completed') return c.json({ success: true, data: existing });
    const denied = await assertTicket(c, productId, miniUser.miniUserId);
    if (denied) return denied;
    // 有 existing（active）则返回快照：读后即决不重读，之后状态推进由 trigger/answer 各自结算。
    // 本处读取快照与 settleEndings 把行翻成 completed 的窗口重叠仅致瞬时 403（恰逢该用户无票重进），
    // 可重试自愈。
    //
    // 🔴 本分支**不是**只读的（2026-09-27 起）：它要把 `visit_count` +1（免费剧本引流要「玩了几次」）。
    //    原先那句「只读不写、无写竞态」说的是**progress 状态字段**（status/state/endingId），
    //    那些仍然只读；本次新增的是一个**单调计数器**，且在 SQL 里自增（`visit_count + 1`）
    //    而不是「读出来 +1 再写回」⇒ 并发两次 start **都走到本分支**时各记一次，无丢失更新。
    //    ⚠️ 这个结论**只管本分支的计数器**。并发「首次」start（那时还没有行）不在此列 ——
    //       两条都会走下面的裸 INSERT，撞 `uq_wenlv_progress_solo`，后到者 500。
    //       那是**先于本次改动**就存在的既有竞态，已登记在 Task 11「已知暴露面」，本片不修。
    if (existing) {
      const updateData: any = { visitCount: sql`${pmsBuiWenlvProgress.visitCount} + 1`, updatedAt: new Date() };
      // 首次选角回传：progress.characterId 为 null 时才写入，已有值不覆盖（不可中途更换）
      if (!existing.characterId && characterId) {
        updateData.characterId = characterId;
      }
      const [bumped] = await db.update(pmsBuiWenlvProgress)
        .set(updateData)
        .where(eq(pmsBuiWenlvProgress.id, existing.id))
        .returning();
      // 行可能在 `getProgress` 与本次 UPDATE 之间被删（如领队移出队员）⇒ `returning()` 得 `[]`。
      // 退回刚读到的快照 —— 本分支的响应**恒有 `data`** 是改动前就有的形状，别让它丢。
      // 此分支无独立用例：触发条件是跨窗口竞态，夹具造不出；主路径由上面 4 条计数用例 + m5 回归护住。
      if (!bumped) return c.json({ success: true, data: existing });
      return c.json({ success: true, data: bumped });
    }

    const [row] = await db.insert(pmsBuiWenlvProgress).values({
      id: randomUUID(), productId, miniUserId: miniUser.miniUserId, visitCount: 1,
      characterId: characterId ?? null,
    }).returning();
    await db.insert(pmsBuiWenlvEvents).values({
      id: randomUUID(), productId, miniUserId: miniUser.miniUserId, eventType: 'start',
    });
    return c.json({ success: true, data: row });
  } catch (e: any) {
    return serverError(c, e, '启动失败');
  }
});

// 读取玩家进度（**已含通道判定**，P2 §4.4）
//
// 同一人可能同时有散客行与团队行（先自己玩过，后来又被拉进队）。旧实现只有 `.limit(1)`、
// 无排序 ⇒ 取到哪行**由 PG 行序决定**（本文件 settleEndings 上方记着同一条教训的原文）
// ⇒ 团队场次下他会随机落到散客行、以为进度丢了。
// 正解：**团队行优先**（有 team 行 ⇒ 团队通道），靠显式 ORDER BY 表达，不靠行序。
//
// ⚠️ 必须保持**只有一条 select**：`__tests__/wenlv.test.ts` 的 redeem 用例按 select **次数**
//    注入（`:654` 把第 3 条读成空、`:663` 断言 `calls === 4`）—— 这里多加一条查询会把那条
//    既有判据的注入点挪到别的读上（假红，或空转后照样绿）。
async function getProgress(productId: string, miniUserId: string) {
  const [row] = await db.select().from(pmsBuiWenlvProgress)
    .where(and(eq(pmsBuiWenlvProgress.productId, productId), eq(pmsBuiWenlvProgress.miniUserId, miniUserId)))
    .orderBy(
      // 团队行排前面：用 `is not null` 的布尔降序（团队 true 在前）。
      // ⚠️ **不能**写 `desc(sessionId)` —— PG 的 DESC 默认 NULLS FIRST，那会把**散客行**排到最前。
      sql`(${pmsBuiWenlvProgress.sessionId} is not null) desc`,
      desc(pmsBuiWenlvProgress.updatedAt),
    )
    .limit(1);
  return row ?? null;
}

/** 队伍并集：同 session 全部成员 state 的逐键 OR（P2 §4.4「读用并集」）。
 *  OR 的合法性见 `mergeStates` 的文档（引擎条件语言单调）。
 *  🔴 读专用：返回值绝不可写进 `progress.state`（I3）。
 *  `productId` 是交叉校验：`progress.session_id ⇒ product_id 一致`只靠应用层保证（无复合外键），
 *  带上它可避免万一违反时把**别的产品**的进度并进来。 */
async function sessionUnionState(sessionId: string, productId: string): Promise<WenlvState> {
  const rows = await db.select({ state: pmsBuiWenlvProgress.state }).from(pmsBuiWenlvProgress)
    .where(and(
      eq(pmsBuiWenlvProgress.sessionId, sessionId),
      eq(pmsBuiWenlvProgress.productId, productId),
    ));
  return mergeStates(rows.map((r) => r.state as WenlvState));
}

/** 信标广播帧是否命中该点位绑定的在役设备。
 *
 *  四条硬约束，每条都有前科：
 *   ① **归一化大小写** —— 触发端是精确比对，而 UUID 的大小写未必在整条链路上保持不变
 *      （「安卓回小写、iOS 回大写」**未实测**，spec §7 第 2 项待确认）。无论实测如何，
 *      比对前归一化一次都是对的，本实现不依赖该结论。⚠️ 「不归一化的失败是静默的」已过时：
 *      帧已送、仅因大小写不归一化而没命中时，会回一条可区分的 403（FRAME_MISS），不是「走到
 *      那儿没反应」；只有**没带帧**的旧路径才仍是那类「没反应」。
 *      输入用 normalizeUuid 归一到小写，列侧再 lower() 一次，容忍绕过 admin 路由直写的大写行。
 *   ② **三件套必须齐全** —— 半帧（只有 uuid）界定不了是哪一台。
 *   ③ **排除 faulty / retired** —— 故障或报废的设备不该再给游客记账。
 *      用拒绝清单而不是「必须 = 'active'」：后者会让刚登记完就装好的设备静默不触发。
 *   ④ **绑定的唯一真相是 beacons.point_id** —— 不与 point.code 共用（那张表的 code
 *      有全局唯一索引，10 台共用 1 个 UUID 时第 2 台就撞索引）。
 */
async function beaconMatchesPoint(
  pointId: string,
  frame?: { uuid?: unknown; major?: unknown; minor?: unknown },
): Promise<boolean> {
  const uuid = normalizeUuid(frame?.uuid);
  if (!uuid) return false;
  // ⚠️ 这里严判 JS number。若真机回去的是数字字符串 `"10001"`，**每个真帧都会在这一行被判 false**
  //    —— 线格式的来源冲突与已定结论见本 Task 开头的「⚠️ 开工前必读」。
  if (!isValidBeaconNumber(frame?.major) || !isValidBeaconNumber(frame?.minor)) return false;
  const [hit] = await db.select({ id: pmsBuiWenlvBeacons.id }).from(pmsBuiWenlvBeacons)
    .where(and(
      eq(pmsBuiWenlvBeacons.pointId, pointId),
      sql`lower(${pmsBuiWenlvBeacons.uuid}) = ${uuid}`,
      eq(pmsBuiWenlvBeacons.major, frame.major),
      eq(pmsBuiWenlvBeacons.minor, frame.minor),
      notInArray(pmsBuiWenlvBeacons.status, ['faulty', 'retired']),
    )).limit(1);
  return !!hit;
}

// POST /api/mini/wenlv/trigger — 触发/打卡节点
route.post('/trigger', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const { productId, nodeId, credential, beacon, teamId } = body as {
      productId?: string; nodeId?: string; credential?: string;
      beacon?: { uuid?: unknown; major?: unknown; minor?: unknown };
      teamId?: string;
    };
    if (!productId || !nodeId) return c.json({ success: false, error: '参数错误' }, 400);

    // 团队模式（组局）：校验队伍存在、本人是队员、已开局。失败直接回对应 4xx。
    let teamCtx: { team: any; members: any[] } | null = null;
    if (teamId) {
      const r = await getPlayingTeam(teamId, miniUser.miniUserId);
      if ('error' in r) return c.json({ success: false, error: r.error }, r.status);
      teamCtx = r;
      // 交叉校验：队伍的 productId 必须与本次触发的 productId 一致（防跨队刷进度）
      if (r.team.productId !== productId) return c.json({ success: false, error: '队伍与剧本不匹配' }, 400);
    }

    const denied = await assertTicket(c, productId, miniUser.miniUserId);
    if (denied) return denied;

    // 新模型（0079）：nodeId = scene.id；一次装配规范图，nodes/edges/endings 全由投影来（不再查旧 nodes/edges/endings）。
    const room = await loadRuntimeGraph(productId);
    const node = room.nodes.find((n) => n.id === nodeId);
    if (!node) return c.json({ success: false, error: '节点不存在' }, 404);

    // 触发凭证判定。
    // 外层门由 nodeRequiresCredential() 统一给出（与 /answer 到场门、DTO requiresCredential 同一份谓词）。
    // 内层：节点挂了点位 → 以「点位的 code」为唯一凭证（同一个码天然服务所有引用它的剧本）；
    //   点位存在但 code 为空 = 物料没铺好 → fail-closed 拒绝（发布前校验已拦截，这里是兜底）。
    // 节点没挂点位 → 回退旧字段（存量节点 + 无需到场的开场/结局）。
    // 注意：挂了点位的节点不再看 triggerType —— 旧字段 schema 默认 'manual'，
    //   若仍按它短路，就会把「有码但默认 manual」的节点放行成免凭证远程可触发。
    // 记账来源标志。必须是**函数级**的：`byBeacon` 是内层 `if (!byCode) {` 的块作用域变量，
    // 到下面 insert 那行已经出作用域了。
    // 口径（已与用户确认）：'beacon' = 本次由信标帧放行；其余一律 'qrcode'，含走
    // `node.triggerCredential` 旧文本字段的那条路径与 H5 手输短码 ⇒ 这个标记的准确含义是
    // 「凭证来自信标帧」vs「不是」，**不是**「扫了二维码」。
    let viaBeacon = false;
    if (nodeRequiresCredential(node)) {
      if (node.venuePointId) {
        const [pt] = await db.select({ code: pmsBuiWenlvVenuePoints.code })
          .from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, node.venuePointId)).limit(1);
        if (!pt) return c.json({ success: false, error: '点位不存在或已删除' }, 403);
        // 两条路都能过，互不排斥（一个点位可以同时有二维码和信标）：
        //   ① 点位码精确相等 —— 扫码/手输，既有通路，行为一行未变。
        //   ② 信标广播帧命中该点位绑定的在役设备 —— 新增通路。
        // 先试码：它是零成本的一次字符串比较，且是绝大多数点位的形态。
        const byCode = !!pt.code && pt.code === credential;
        if (!byCode) {
          const byBeacon = await beaconMatchesPoint(node.venuePointId, beacon);
          if (!byBeacon) {
            // 🔴 两条 403 **必须可区分**（状态码相同、消息不同），两个理由：
            //   ① 诊断 —— 「帧没命中」与「凭证本来就错」若回同一条消息，一个类型不符的
            //      真帧会表现成与「凭证错」一模一样的 403，现场只能看到「走到那儿没反应」。
            //      那正是本 Task 开头声明要消灭的那类静默失效。
            //   ② 判别力 —— 本文件那 5 条「帧不匹配被拒 403」若只断言状态码，在**本 Task
            //      实现之前就是绿的**（没有信标通路时它们照样 403），TDD 的「先红」对该组
            //      完全失效。断言消息才让它们真的红。
            //   区分依据是「调用方有没有把帧送上来」，不是「哪条路失败」—— 没送帧就仍是
            //   老消息，既有码通路的对外行为一行未变。
            return c.json({
              success: false,
              error: beacon ? '信标帧未命中该点位绑定的在役设备' : '触发凭证不匹配',
            }, 403);
          }
          // 走到这里 = 帧放行了。命中的是**帧路**：`byCode` 命中的话根本不会进这个 `if`。
          viaBeacon = true;
        }
      }
    }

    const progress = await getProgress(productId, miniUser.miniUserId);
    if (!progress) return c.json({ success: false, error: '尚未开始体验' }, 400);

    // 角色上下文：characterId 来自 progress（不从 body 传，防篡改），skills 来自 characters 表。
    // characterId 为 null 时 charSkillIds = []，role/skill 条件保守返回 false。
    let charSkillIds: string[] = [];
    if (progress.characterId) {
      const [ch] = await db.select({ skills: pmsBuiWenlvCharacters.skills })
        .from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, progress.characterId)).limit(1);
      charSkillIds = ch?.skills ? ch.skills.map((s) => s.id).filter(Boolean) : [];
    }
    const charOpts = { characterId: progress.characterId, characterSkillIds: charSkillIds };

    const state = progress.state as WenlvState;
    // 判定用的进度 ≠ 写回的进度（P2 §4.4）：团队场次下前者是**队伍并集**，后者**永远**是我自己那行。
    // 两个变量必须**显式异名** —— 用同一个名字时，任何一次「顺手改成 evalState」都是静默污染。
    // Task 12：组局模式（teamId）下，evalState 取队伍共享进度（team.progress 的并集）。
    const evalState = teamCtx
      ? ((teamCtx.team.progress ?? { visited: {}, collected: {}, completed: {} }) as WenlvState)
      : progress.sessionId ? await sessionUnionState(progress.sessionId, productId) : state;
    // 前置条件校验（requires），防绕过 —— 用**并集**：队友到过 = 大门已开
    if (!evalCondition(node.requires, evalState, charOpts)) {
      return c.json({ success: false, error: '前置条件未满足' }, 403);
    }
    // 二元模型下「是否答题节点」只看节点是否挂了 puzzle 对象（puzzle 是 scene 节点内的可选 JSON）：
    // 场景节点打卡即应用效果；谜题节点仅标记到访，效果在答对时应用。
    const isPuzzle = !!node.puzzle;
    // 到场证明（运行时）：场景节点在此处真发章，故在 applyGrants 前拦一道。
    // 谜题节点此处不发章（只标 visited），其发章在 /answer，守在那里。
    if (!isPuzzle) {
      const stampErr = await rallyStampOnSiteErr(productId, node);
      if (stampErr) return c.json({ success: false, error: stampErr }, 403);
    }
    // 🔴 下面两行必须用 `state`（我的），**不是** `evalState`：并集写回 = 我的进度被队友的进度污染，
    //    不报任何错，只有用例 1 的库内断言抓得住。
    const visited = markVisited(state, nodeId);
    const next = isPuzzle ? visited : applyGrants(node.grants, visited);

    // 同步节点发放的证物到 pmsBuiWenlvPlayerProgress.collectedCollectibles（供 NPC 对话 clueIds 判定使用）
    const prevCollected = new Set(Object.keys(state.collected || {}));
    const newlyGranted = Object.keys(next.collected || {}).filter((id) => !prevCollected.has(id));
    if (newlyGranted.length) {
      await syncPlayerCollectibles(productId, miniUser.miniUserId, newlyGranted);
    }

    // 剧情图遍历：场景节点完成后沿 auto 边流转（边由规范图投影传入；空集 = 无边剧本）
    let finalNext = next;
    let edgeSanDelta = 0;
    if (!isPuzzle && room.edges.length) {
      const trav = traverseEdges(room.edges, nodeId, next, 'auto', charOpts);
      const applied = applyTraversalResult(trav, next);
      finalNext = applied.state;
      edgeSanDelta = applied.sanDelta;
      // 边发放的证物同步
      const edgeGrants = trav.grants.filter((id) => !prevCollected.has(id));
      if (edgeGrants.length) {
        await syncPlayerCollectibles(productId, miniUser.miniUserId, edgeGrants);
      }
    }

    await db.update(pmsBuiWenlvProgress).set({ state: finalNext, updatedAt: new Date() })
      .where(eq(pmsBuiWenlvProgress.id, progress.id));
    await db.insert(pmsBuiWenlvEvents).values({
      id: randomUUID(), productId, miniUserId: miniUser.miniUserId, eventType: 'checkin', nodeId,
      // 来源标记：现场验收要能证明「信标那一路真被用过」。`payload` 是既有 jsonb 列、
      // 全仓零读取方 ⇒ 零迁移。免凭证节点记 'none'（既非帧也非码）。
      payload: { source: viaBeacon ? 'beacon' : (credential ? 'qrcode' : 'none') },
    });
    // 结局拆两半（P2 §4.4 同句后半 + S §6.3「队伍结局为主」/ S:585）：
    //   个人结局 = 我自己那行 ⇒ 仍由 `settleEndings` 求值**并落库**（本体一行不改）
    //   队伍结局 = 并集 ⇒ 只走 `teamEndings` **只读**求值，只进响应主位，**绝不落库**
    // 用自己算队伍结局会变成「谁最后触发谁得结局」；把并集喂给 `settleEndings` 则会污染我自己那行。
    // Task 12：组局模式下同样用并集（team.progress ∪ 我的 finalNext）算队伍结局。
    const isTeam = !!teamCtx || !!progress.sessionId;
    const settleState = isTeam ? mergeStates([evalState, finalNext]) : finalNext;
    const mine = await settleEndings(room.endings, finalNext, progress.id, progress, charOpts);
    const endings = isTeam ? teamEndings(room.endings, settleState) : mine;

    // Task 12：组局模式下，把我的新进度并回队伍共享进度（单调并集，不污染个人行）。
    // merged 是完整的 WenlvState（visited/collected/completed 并集）；collaborativeAnswers
    // 从既有 team.progress 保留（协作题状态由 /answer 维护，trigger 不动它）。
    let teamProgress: WenlvState | null = null;
    if (teamCtx) {
      const merged = mergeStates([evalState, finalNext]);
      const existing = teamCtx.team.progress ?? {};
      const nextTeamProgress = {
        visited: merged.visited,
        collected: merged.collected,
        completed: merged.completed,
        ...(existing.collaborativeAnswers ? { collaborativeAnswers: existing.collaborativeAnswers } : {}),
      };
      const updated = await db.update(pmsBuiWenlvTeams).set({ progress: nextTeamProgress })
        .where(eq(pmsBuiWenlvTeams.id, teamCtx.team.id)).returning();
      teamProgress = (updated[0]?.progress ?? nextTeamProgress) as WenlvState;
    }
    // 导演 v1：触发成功后惰性 tick（fire-and-forget，不阻塞响应）。
    void tickDirector(productId, progress.id, `${nodeId}:trigger`).catch(console.error);
    // 散客：响应形状与今天**逐字相同**（`wenlv.test.ts` 可能断言形状）⇒ 不加字段
    // 组局：额外带回 teamProgress，前端据此展示全员进度（也可轮询 GET /teams/:id）。
    if (teamCtx) return c.json({ success: true, data: { state: finalNext, endings, mine, teamProgress } });
    return c.json({ success: true, data: progress.sessionId ? { state: finalNext, endings, mine } : { state: finalNext, endings } });
  } catch (e: any) {
    return serverError(c, e, '触发失败');
  }
});

// POST /api/mini/wenlv/answer — 答题判定
route.post('/answer', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const { productId, nodeId, answer, usedSkill, teamId, confirmCollaborative } = body as {
      productId?: string; nodeId?: string; answer?: unknown;
      usedSkill?: string; teamId?: string; confirmCollaborative?: boolean;
    };
    if (!productId || !nodeId) return c.json({ success: false, error: '参数错误' }, 400);

    // 团队模式（组局）：校验队伍存在、本人是队员、已开局。
    let teamCtx: { team: any; members: any[] } | null = null;
    if (teamId) {
      const r = await getPlayingTeam(teamId, miniUser.miniUserId);
      if ('error' in r) return c.json({ success: false, error: r.error }, r.status);
      teamCtx = r;
      if (r.team.productId !== productId) return c.json({ success: false, error: '队伍与剧本不匹配' }, 400);
    }

    const denied = await assertTicket(c, productId, miniUser.miniUserId);
    if (denied) return denied;

    // 新模型（0079）：nodeId = scene.id；一次装配规范图，nodes/edges/endings 全由投影来（不再查旧 nodes/edges/endings）。
    const room = await loadRuntimeGraph(productId);
    const node = room.nodes.find((n) => n.id === nodeId);
    if (!node) return c.json({ success: false, error: '节点不存在' }, 404);

    const progress = await getProgress(productId, miniUser.miniUserId);
    if (!progress) return c.json({ success: false, error: '尚未开始体验' }, 400);

    // 角色上下文：characterId 来自 progress（不从 body 传，防篡改），skills 来自 characters 表。
    // characterId 为 null 时 charSkillIds = []，role/skill 条件保守返回 false。
    let charSkillIds: string[] = [];
    if (progress.characterId) {
      const [ch] = await db.select({ skills: pmsBuiWenlvCharacters.skills })
        .from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, progress.characterId)).limit(1);
      charSkillIds = ch?.skills ? ch.skills.map((s) => s.id).filter(Boolean) : [];
    }
    const charOpts = { characterId: progress.characterId, characterSkillIds: charSkillIds };

    const state = progress.state as WenlvState;
    // 判定用的进度 ≠ 写回的进度（P2 §4.4）：团队场次下前者是**队伍并集**，后者**永远**是我自己那行。
    // 两个变量必须**显式异名** —— 用同一个名字时，任何一次「顺手改成 evalState」都是静默污染。
    // Task 12：组局模式（teamId）下，evalState 取队伍共享进度（team.progress 的并集）。
    const evalState = teamCtx
      ? ((teamCtx.team.progress ?? { visited: {}, collected: {}, completed: {} }) as WenlvState)
      : progress.sessionId ? await sessionUnionState(progress.sessionId, productId) : state;
    // 前置条件校验（requires），防绕过 —— 用**并集**：队友到过 = 大门已开
    if (!evalCondition(node.requires, evalState, charOpts)) {
      return c.json({ success: false, error: '前置条件未满足' }, 403);
    }
    // 到场证明：节点挂了点位时，必须先被 /trigger 标记 visited。
    // 谓词与 /trigger 的凭证门、DTO requiresCredential **同一份实现**（nodeRequiresCredential）。
    // 🔴 到场门用**我的** state，**绝不用 `evalState`**：「请先到场触发该节点」是物理到场证明，
    //    用并集 = 队友到了就算我到了 ⇒ 远程刷章。这条与上面的「前置条件用并集」**方向相反**，
    //    别为了「统一」把它们改成同一个变量（用例 2 钉这个洞）。
    if (nodeRequiresCredential(node) && !state.visited?.[nodeId]) {
      return c.json({ success: false, error: '请先到场触发该节点' }, 403);
    }

    // S4④：scene 节点也可答题（语义是「剧情回味」—— 答对只给正反馈，不改变进度状态，
    // 因为 scene 的 grants 已在 /trigger 到场时发放，此处再 applyGrants 只是对同一批 key
    // 幂等置位，刷不出新东西）。
    // 用共享的 isQuizInteraction 而不是各写一份类型列表：它必须与校验器的题型白名单同源。
    // photo / meditate 是「现场动作」，没有答案，不接受提交。
    const puzzle = node.puzzle;
    if (!puzzle || !isQuizInteraction(puzzle)) {
      return c.json({ success: false, error: '无此谜题' }, 400);
    }

    // Task 12 / Task 13：协作题判定。
    // 协作题标识（二选一）：① puzzle.collaborative === true；② 剧本 config.collaborativePuzzles
    // 为 true 且本节点挂了 puzzle（二元模型下谜题是 scene 节点内的 puzzle JSON，不再看 nodeType）。
    // 仅**组局模式**（teamCtx）下走协作判定；散客/场次模式
    // 即便标了 collaborative 也按单人直判（协作题需要多人上下文）。
    //
    // 判定时机（Task 13 大团队适配）：
    //  - 小团队（<8 人）：全员提交后判定（Task 12 现有逻辑）
    //  - 大团队（≥8 人）：队员提交只记录不判定；队长带 confirmCollaborative=true 时触发判定，
    //    避免 20 人全员等待。判定一律以队长答案为准。
    const collabKey = `${nodeId}`;
    let isCollaborative = (puzzle as any).collaborative === true;
    if (!isCollaborative && teamCtx && !!node.puzzle) {
      const [prod] = await db.select({ config: pmsBuiWenlvProducts.config })
        .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
      isCollaborative = Boolean((prod?.config as any)?.collaborativePuzzles);
    }

    if (isCollaborative && teamCtx) {
      // 记录本人答案到 team.progress.collaborativeAnswers（幂等：重复提交覆盖）。
      const existing = teamCtx.team.progress ?? {};
      const collabAnswers: Record<string, Record<string, unknown>> = existing.collaborativeAnswers ?? {};

      // ① 角色归属校验：如果 puzzle 有 requires.role，则只有对应角色能回答这道题。
      const requiresRole = (puzzle as any).requires;
      let ownerCharacterId: string | null = null;
      if (requiresRole && requiresRole.type === 'role') {
        ownerCharacterId = requiresRole.characterId;
      }
      if (ownerCharacterId) {
        const myMember = teamCtx.members.find((m: any) => m.userId === miniUser.miniUserId);
        if (!myMember || myMember.characterId !== ownerCharacterId) {
          return c.json({ success: false, error: '这道题需要由对应角色回答' }, 403);
        }
      }

      const thisAnswer = { ...(collabAnswers[collabKey] ?? {}), [miniUser.miniUserId]: answer };
      collabAnswers[collabKey] = thisAnswer;

      const memberIds = teamCtx.members.map((m: any) => m.userId);
      const teamSize = memberIds.length;
      const isLeader = teamCtx.team.leaderId === miniUser.miniUserId;

      // ② 判定时机：所有归属角色都提交了（无 requires.role 时回退到全员提交，兼容旧剧本）。
      const allOwnersSubmitted = memberIds.every((uid) => thisAnswer[uid] !== undefined);
      const leaderConfirm = isLeader && confirmCollaborative === true;
      const shouldJudge = allOwnersSubmitted || (teamSize >= 8 && leaderConfirm);

      const submittedCount = memberIds.filter((uid) => thisAnswer[uid] !== undefined).length;
      const total = teamSize;

      if (!shouldJudge) {
        // 未到判定时机：落库答案，回 pending（不判定、不发效果）。
        const nextTeamProgress = {
          visited: existing.visited ?? {},
          collected: existing.collected ?? {},
          completed: existing.completed ?? {},
          collaborativeAnswers: collabAnswers,
        };
        await db.update(pmsBuiWenlvTeams).set({ progress: nextTeamProgress })
          .where(eq(pmsBuiWenlvTeams.id, teamCtx.team.id));
        return c.json({
          success: true,
          data: { correct: null as null, pending: true, submittedCount, total, teamProgress: nextTeamProgress },
        });
      }

      // ③ 判定：单题节点，所有提交者答案都正确才算通过（大团队以队长答案为准）。
      let allCorrect = true;
      const wrongUserIds: string[] = [];
      if (teamSize >= 8 && leaderConfirm) {
        // 大团队：以队长答案为准。
        const leaderAnswer = thisAnswer[teamCtx.team.leaderId];
        allCorrect = isAnswerCorrect(puzzle, leaderAnswer);
        if (!allCorrect) wrongUserIds.push(teamCtx.team.leaderId);
      } else {
        // 小团队：逐个判定每个成员答案。
        for (const uid of memberIds) {
          const ans = thisAnswer[uid];
          if (ans === undefined || !isAnswerCorrect(puzzle, ans)) {
            allCorrect = false;
            if (uid !== miniUser.miniUserId || ans !== undefined) wrongUserIds.push(uid);
          }
        }
      }

      if (!allCorrect) {
        // ④ 只清答错者的答案，已答对者保留（可重答）。
        const remainingAnswers = { ...thisAnswer };
        for (const uid of wrongUserIds) {
          delete remainingAnswers[uid];
        }
        const remaining = { ...collabAnswers, [collabKey]: remainingAnswers };
        const nextTeamProgress = {
          visited: existing.visited ?? {},
          collected: existing.collected ?? {},
          completed: existing.completed ?? {},
          collaborativeAnswers: remaining,
        };
        await db.update(pmsBuiWenlvTeams).set({ progress: nextTeamProgress })
          .where(eq(pmsBuiWenlvTeams.id, teamCtx.team.id));

        // 剧情图遍历：谜题答错沿 puzzle_fail 边流转（边由规范图投影传入；空集 = 无边剧本）
        let failState = state;
        if (room.edges.length) {
          const trav = traverseEdges(room.edges, nodeId, state, 'puzzle_fail', charOpts);
          const applied = applyTraversalResult(trav, state);
          failState = applied.state;
          const edgeGrants = trav.grants.filter((id) => !state.collected?.[id]);
          if (edgeGrants.length) {
            await syncPlayerCollectibles(productId, miniUser.miniUserId, edgeGrants);
          }
          await db.update(pmsBuiWenlvProgress).set({ state: failState, updatedAt: new Date() })
            .where(eq(pmsBuiWenlvProgress.id, progress.id));
        }
        return c.json({ success: true, data: { correct: false, wrongUserIds, state: failState, endings: [] } });
      }

      // ⑤ 答对：发章 + 应用产出 + 结算结局（后置链路已抽取为 applyNodeCompletion，与单人题/原子端点共用）。
      const collabCompletion = await applyNodeCompletion({
        productId,
        progressId: progress.id,
        nodeId,
        state,
        miniUserId: miniUser.miniUserId,
        sessionId: progress.sessionId,
        node,
        edges: room.edges,
        endings: room.endings,
        progress,
        charOpts,
        evalState,
        team: { id: teamCtx.team.id },
        teamProgress: { collaborativeAnswers: collabAnswers },
        clearCollabKey: collabKey,
        eventPayload: { collaborative: true, leaderConfirm: teamSize >= 8 },
      });
      if (collabCompletion.stampError) return c.json({ success: false, error: collabCompletion.stampError }, 403);
      // 导演 v1：协作题判定通过后惰性 tick（fire-and-forget）。
      void tickDirector(productId, progress.id, `${nodeId}:answer`).catch(console.error);
      return c.json({
        success: true,
        data: {
          correct: true, state: collabCompletion.state, endings: collabCompletion.endings,
          mine: collabCompletion.mine, teamProgress: collabCompletion.teamProgress,
        },
      });
    }

    // ── 非协作题（或散客/场次模式）：单人直判 ──────────────────────────
    // 按题型判定：single/input/judge trim 相等；multiple 集合等值（乱序可判对）。
    // 技能触发通关（Task 7）：若传了 usedSkill，且角色拥有该技能，且该技能被 puzzle.requires
    // 引用，则直接判定通过（跳过答案校验）。三个条件缺一即当作答错（不泄漏原因，避免提示可刷技能）。
    let correct: boolean;
    if (usedSkill) {
      correct = charSkillIds.includes(usedSkill) && conditionReferencesSkill(puzzle.requires, usedSkill);
    } else {
      correct = isAnswerCorrect(puzzle, answer);
    }
    if (!correct) {
      // 剧情图遍历：谜题答错沿 puzzle_fail 边流转（边由规范图投影传入；空集 = 无边剧本）
      if (room.edges.length) {
        const trav = traverseEdges(room.edges, nodeId, state, 'puzzle_fail', charOpts);
        const applied = applyTraversalResult(trav, state);
        const failNext = applied.state;
        const edgeGrants = trav.grants.filter((id) => !state.collected?.[id]);
        if (edgeGrants.length) {
          await syncPlayerCollectibles(productId, miniUser.miniUserId, edgeGrants);
        }
        await db.update(pmsBuiWenlvProgress).set({ state: failNext, updatedAt: new Date() })
          .where(eq(pmsBuiWenlvProgress.id, progress.id));
        return c.json({ success: true, data: { correct: false, state: failNext, endings: [] } });
      }
      return c.json({ success: true, data: { correct: false, state, endings: [] } });
    }

    // 单题节点：答对即通关 —— 后置链路（grants + 发章 + 事件 + 结局结算 + 队伍同步）
    // 已抽取为 applyNodeCompletion，与协作题⑤/原子完成端点共用同一份。
    const completion = await applyNodeCompletion({
      productId,
      progressId: progress.id,
      nodeId,
      state,
      miniUserId: miniUser.miniUserId,
      sessionId: progress.sessionId,
      node,
      edges: room.edges,
      endings: room.endings,
      progress,
      charOpts,
      evalState,
      team: teamCtx ? { id: teamCtx.team.id } : null,
      teamProgress: teamCtx ? (teamCtx.team.progress ?? {}) : null,
    });
    if (completion.stampError) return c.json({ success: false, error: completion.stampError }, 403);
    // 导演 v1：单人题答对后惰性 tick（fire-and-forget）。
    void tickDirector(productId, progress.id, `${nodeId}:answer`).catch(console.error);
    return c.json({ success: true, data: { correct: true, state: completion.state, endings: completion.endings, mine: completion.mine, teamProgress: completion.teamProgress } });
  } catch (e: any) {
    return serverError(c, e, '答题失败');
  }
});

// POST /products/:id/atoms/:atomId/complete — 实景原子完成（spec §8.1）。
// 安全顺序（评审 C1/F1 钉死，任何写入/埋点/verify 之前）：
//   requires 前置闸（evalState 并集）→ 到场凭证闸（个人 state，持码不替代到场）
//   → rally 发章闸（与 applyNodeCompletion 同一谓词，零写入 403）
// 幂等语义：state.atoms[`${nodeId}:${atomId}`].done 已真 ⇒ 直返，不重复埋点、不重复走完成链路；
// 原子落库为单条条件 UPDATE（I1，防并发丢更新），0 行 ⇒ 重读 state 走幂等返回；
// 节点完成链路（grants/发章/结局/队伍同步）只在「本节点全部 required 原子 done 且
// completed[nodeId] 尚未标记」时触发一次（F2），与 /answer 共用 applyNodeCompletion。
// 🔴 F2 闸信号是 completed，**不是 visited**：/trigger 到场即 markVisited，绑点位节点在
//    答题/做原子之前 visited 已为 true（/answer 的到场凭证闸正依赖此时序）；用 visited 当闸
//    会把所有绑点位原子节点的完成链路整体跳过（puzzle_pass 边不流转、grants/结局不结算）。
// 老剧本（node.atoms 为空）无此调用路径；/answer 链路也不写 completed，零老剧本影响。
route.post('/products/:id/atoms/:atomId/complete', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const productId = c.req.param('id');
    const atomId = c.req.param('atomId');
    const body = await c.req.json().catch(() => ({}));
    const { nodeId, code, text, answer, teamId } = body as {
      nodeId?: string; code?: string; text?: string; answer?: unknown; teamId?: string;
    };
    if (!nodeId) return c.json({ success: false, error: '参数错误' }, 400);

    // 组局模式取法与 /answer 同款（校验队伍/队员/开局 + 产品交叉校验）。
    let teamCtx: { team: any; members: any[] } | null = null;
    if (teamId) {
      const r = await getPlayingTeam(teamId, miniUser.miniUserId);
      if ('error' in r) return c.json({ success: false, error: r.error }, r.status);
      teamCtx = r;
      if (r.team.productId !== productId) return c.json({ success: false, error: '队伍与剧本不匹配' }, 400);
    }

    const denied = await assertTicket(c, productId, miniUser.miniUserId);
    if (denied) return denied;

    // 新模型（0079）：nodeId = scene.id；一次装配规范图，nodes/edges/endings 全由投影来（不再查旧 nodes/edges/endings）。
    const room = await loadRuntimeGraph(productId);
    const node = room.nodes.find((n) => n.id === nodeId);
    if (!node) return c.json({ success: false, error: '节点不存在' }, 404);

    const progress = await getProgress(productId, miniUser.miniUserId);
    if (!progress) return c.json({ success: false, error: '尚未开始体验' }, 400);

    // 角色上下文取法与 /answer 同款：characterId 只从 progress 读，skills 查 characters。
    let charSkillIds: string[] = [];
    if (progress.characterId) {
      const [ch] = await db.select({ skills: pmsBuiWenlvCharacters.skills })
        .from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, progress.characterId)).limit(1);
      charSkillIds = ch?.skills ? ch.skills.map((s) => s.id).filter(Boolean) : [];
    }
    const charOpts = { characterId: progress.characterId, characterSkillIds: charSkillIds };

    const nodeAtoms: WenlvAtom[] = Array.isArray(node.atoms) ? node.atoms : [];
    const targetAtom = nodeAtoms.find((a) => a.id === atomId);
    if (!targetAtom) return c.json({ success: false, error: '节点无此原子' }, 404);

    const state = progress.state as WenlvState;
    const evalState = teamCtx
      ? ((teamCtx.team.progress ?? { visited: {}, collected: {}, completed: {} }) as WenlvState)
      : progress.sessionId ? await sessionUnionState(progress.sessionId, productId) : state;

    // 🔴 C1 门禁一：前置条件（requires）——与 /answer:1788 **逐字同款**拒绝，用 evalState 并集。
    //    原子端点原本取到 node/state 就直接 verify，等于可以远程跳过 requires 跳关。
    if (!evalCondition(node.requires, evalState, charOpts)) {
      return c.json({ success: false, error: '前置条件未满足' }, 403);
    }
    // 🔴 C1 门禁二：到场凭证——与 /answer:1796 同款。这里**必须用个人 state**（不用 evalState）：
    //    绑点位节点没人替你到场，队友到过/持码正确都不替代扫码（远程集章/跳关红线）。
    //    时序无循环：/trigger 对 puzzle/scene 节点都先 markVisited（wenlv.ts:1670），
    //    /answer 同样依赖此时序；无点位节点 nodeRequiresCredential 为假，走完成链路自标 visited。
    if (nodeRequiresCredential(node) && !state.visited?.[nodeId]) {
      return c.json({ success: false, error: '请先到场触发该节点' }, 403);
    }
    // F1：rally 到场发章闸**前置**——复用 applyNodeCompletion 内同一个谓词 rallyStampOnSiteErr
    //    （禁止复制第二份）。原实现先写 state.atoms + 埋点，再由完成链路 403 中止 ⇒ 客户端重试
    //    产生重复埋点/重复写。闸不过时此处零写入、零埋点直接回与 /answer 一致的 403。
    const stampErr = await rallyStampOnSiteErr(productId, node);
    if (stampErr) return c.json({ success: false, error: stampErr }, 403);

    const key = `${nodeId}:${atomId}`;
    const requiredIds = requiredAtomIds(nodeAtoms);
    const isNodeDoneBy = (s: WenlvState) =>
      requiredIds.every((rid) => s.atoms?.[`${nodeId}:${rid}`]?.done === true);
    // 响应里 nodeCompleted 的**唯一口径**：全部 required 原子 done **且**完成链路已落
    // completed[nodeId] 标记。已 done 直返 / 条件 UPDATE 0 行重读 / F2 跳过 / 正常触发
    // 四个返回点共用，保证同一节点在任何分支读到的 nodeCompleted 一致。
    const isNodeCompleted = (s: WenlvState) => isNodeDoneBy(s) && s.completed?.[nodeId] === true;

    // 幂等：已 done 直接回当前态，不写库、不埋点、不重复触发节点完成。
    if (state.atoms?.[key]?.done === true) {
      return c.json({ success: true, data: { done: true, nodeCompleted: isNodeCompleted(state), grants: node.grants ?? [] } });
    }

    // code 原子 expectedCode 缺省时回退绑定点位码（查询写法与 /trigger 内同款）。
    let boundPointCode: string | null = null;
    if (node.venuePointId) {
      const [pt] = await db.select({ code: pmsBuiWenlvVenuePoints.code })
        .from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.id, node.venuePointId)).limit(1);
      boundPointCode = pt?.code ?? null;
    }

    let verdict;
    try {
      verdict = await verifyAtom(targetAtom, { code, text, answer }, {
        productId, state, boundPointCode,
      });
    } catch (e) {
      if (e instanceof AtomVerifyUnsupportedError) return c.json({ success: false, error: e.message }, e.status);
      throw e;
    }
    if (!verdict.pass) {
      // 核验不过：200 + done:false + 可重试文案，不写状态（与 /answer 答错返 200 同形态）。
      return c.json({ success: true, data: { done: false, message: verdict.message } });
    }

    // I1：原子 done 落库用**单条条件 UPDATE**（jsonb_set + WHERE 未 done），消除
    // 「读 state → 改 → 整行写回」的并发丢更新（两个原子同时完成会互相覆盖 atoms 字典）。
    // 位于 C1/F1 两道闸与 stamp 谓词**之后**；只针对个人 progress 行（组队 state.atoms 语义
    // 维持现状，F4 spec 留白）。
    const doneEntry = { done: true, at: new Date().toISOString() };
    const updated = await db.update(pmsBuiWenlvProgress).set({
      state: sql`jsonb_set(COALESCE(state, '{}'::jsonb), ARRAY['atoms', ${key}]::text[], ${JSON.stringify(doneEntry)}::jsonb, true)`,
      updatedAt: new Date(),
    }).where(sql`id = ${progress.id} AND COALESCE(state->'atoms'->${key}->>'done', '') <> 'true'`)
      .returning({ state: pmsBuiWenlvProgress.state });

    if (updated.length === 0) {
      // 并发请求已先写：重流行——重读 state 按幂等返回，**不写事件、不二次触发完成链路**。
      // nodeCompleted 与正常分支同口径：赢家只写了原子字典（required 全 done）但完成链路
      // 尚未落 completed 标记时，这里如实返 false，不得仅凭 required 全 done 报 true。
      const [freshRow] = await db.select({ state: pmsBuiWenlvProgress.state })
        .from(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.id, progress.id)).limit(1);
      const freshState = (freshRow?.state ?? state) as WenlvState;
      return c.json({
        success: true,
        data: { done: true, nodeCompleted: isNodeCompleted(freshState), grants: node.grants ?? [] },
      });
    }

    // 导演 v1：原子首次写 done 成功后惰性 tick（fire-and-forget）。
    // 放在条件 UPDATE 1 行 affected 之后 ⇒ 核验不过 / 幂等重放不产生事件；
    // 无论本原子是否凑齐节点完成，下游两条成功返回都由这一处覆盖。
    void tickDirector(productId, progress.id, key).catch(console.error);

    // 1 行 affected：用 RETURNING 的最新 state 重算必填原子是否全 done（完成链路的触发条件，
    // 区别于响应口径 isNodeCompleted——后者还要求 completed 标记已落）。
    const latestState = updated[0].state as WenlvState;
    const requiredAllDone = isNodeDoneBy(latestState);

    // 原子自身玩法事件仅在「本次首写成功」时埋（0 行重流行不埋，避免重试重复埋点）。
    if (verdict.trackType) {
      await trackEvent(productId, miniUser.miniUserId, verdict.trackType, { atomId }, nodeId);
    }

    const revealPart = verdict.revealText ? { revealText: verdict.revealText } : {};
    if (!requiredAllDone) {
      // 节点未完成：条件 UPDATE 已持久化原子字典（applyNodeCompletion 尚未触发）。
      return c.json({ success: true, data: { done: true, nodeCompleted: false, grants: node.grants ?? [], ...revealPart } });
    }

    // F2：节点完成幂等闸——信号是 completed[nodeId]，**不能用 visited**。
    // /trigger 到场即 markVisited：绑点位节点（physical-search/cipher-contact 等主场景，
    // 恰恰是最需要到场的节点）在玩家做第一个原子之前 visited 已为 true（/answer 的到场凭证
    // 闸也依赖此时序，见本文件 /trigger markVisited 与本端点到场凭证闸）。若用 visited 当闸，
    // 这些节点做完最后一个 required 原子时完成链路被整体跳过：/trigger 只跑 auto 边，
    // puzzle_pass 边必须由完成链路驱动，grants/结局结算也不跑，玩家卡在已到场节点无法推进。
    // completed 键全仓运行时无其他生产者（effects.complete 已删，evalCondition 的
    // {type:'completed'} 条件因此恒假），原子链路是它的唯一合法生产者；老 /answer 链路不写
    // 该键，对老剧本零影响。
    if (latestState.completed?.[nodeId] === true) {
      return c.json({
        success: true,
        data: { done: true, nodeCompleted: true, state: latestState, endings: [], grants: node.grants ?? [], ...revealPart },
      });
    }

    // 全部 required 原子 done 且本节点未完成过 ⇒ 触发前置完成标记，再走节点完成链路
    // （与 /answer 同一份）。标记挂在 latestState 上随链路整体写回，无需改 complete-node.ts：
    // markVisited 整体展开 state 透传；applyGrants 无 grants 原样返回、有 grants 重建三键时
    // 展开既有 completed；traverseEdges/applyTraversalResult 逐层展开；atoms 由链路尾部
    // 显式挂回；队伍进度经 mergeStates 并集三键（含 completed）同样不丢标记。
    latestState.completed = { ...(latestState.completed ?? {}), [nodeId]: true };
    // 原子触发的事件名用 'node_complete'（varchar(20) 内），区别于谜题链路的 'answer'。
    const completion = await applyNodeCompletion({
      productId,
      progressId: progress.id,
      nodeId,
      state: latestState,
      miniUserId: miniUser.miniUserId,
      sessionId: progress.sessionId,
      node,
      edges: room.edges,
      endings: room.endings,
      progress,
      charOpts,
      evalState,
      team: teamCtx ? { id: teamCtx.team.id } : null,
      teamProgress: teamCtx ? (teamCtx.team.progress ?? {}) : null,
      eventPayload: { atomId },
      eventType: 'node_complete',
    });
    if (completion.stampError) return c.json({ success: false, error: completion.stampError }, 403);
    return c.json({
      success: true,
      data: {
        done: true, nodeCompleted: true, state: completion.state,
        endings: completion.endings, grants: node.grants ?? [], ...revealPart,
      },
    });
  } catch (e: any) {
    return serverError(c, e, '原子完成失败');
  }
});

// POST /track — 商业/行为埋点（spec §8.2）：白名单事件落 pms_bui_wenlv_events，非法/缺参 400。
// 必须自己 parseMiniToken（本整段在公开前缀白名单内，全局鉴权中间件不挡）。
route.post('/track', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const body = await c.req.json().catch(() => ({}));
    const { productId, eventType, payload, nodeId } = body as {
      productId?: string; eventType?: string; payload?: unknown; nodeId?: string;
    };
    if (!productId || typeof productId !== 'string') {
      return c.json({ success: false, error: '参数错误：缺少 productId' }, 400);
    }
    if (!eventType || !TRACK_EVENT_TYPES.includes(eventType)) {
      return c.json({ success: false, error: '不支持的事件类型' }, 400);
    }
    // F3：三列均为 varchar（productId/nodeId=50、eventType=20），超长会在 INSERT 时抛 22001
    // 走成 500；埋点端点必须自闸，风格与 /report 一致（路由键/类型键不截断，明确 400）。
    if (productId.length > 50) return c.json({ success: false, error: 'productId 过长' }, 400);
    if (eventType.length > 20) return c.json({ success: false, error: 'eventType 过长' }, 400);
    if (typeof nodeId === 'string' && nodeId.length > 50) {
      return c.json({ success: false, error: 'nodeId 过长' }, 400);
    }
    const safePayload = payload && typeof payload === 'object' && !Array.isArray(payload)
      ? payload as Record<string, unknown>
      : {};
    // 对象 payload 限 4000 字符（非对象上面已落 {}）：防超大 body 撑爆 jsonb 列/内存。
    if (JSON.stringify(safePayload).length > 4000) {
      return c.json({ success: false, error: 'payload 过大' }, 400);
    }
    await trackEvent(productId, miniUser.miniUserId, eventType, safePayload, nodeId ?? null);
    return c.json({ success: true });
  } catch (e: any) {
    return serverError(c, e, '埋点失败');
  }
});

// POST /report — 游客端现场问题上报。
//
// ⚠️ **不挂 assertTicket**（有意）：付费墙拦的是「未买票白嫖」，而上报是**降门槛**动作 ——
//    游客恰恰在「买了票但玩不通」时才要上报。挂了它 = 最需要上报的人报不上来。
//    同文件 /:id/claims、/:id/claim-state 是「登录即可、不需门票」的既有先例。
// ⚠️ **必须自己 parseMiniToken**：/api/mini/wenlv 整段在 mini-auth.ts 的公开前缀白名单里，
//    全局 miniAuthMiddleware 不会替这条路由挡。
// ⚠️ **不要求产品存在**：剧本被删后上报仍要能落 —— 那正是「为什么删」的证据。
route.post('/report', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);

  const body = await c.req.json().catch(() => ({}));
  const productId = typeof body?.productId === 'string' ? body.productId.trim() : '';
  if (!productId) return c.json({ success: false, error: '缺少 productId' }, 400);

  // ⚠️ **长度闸不是洁癖**：三列都是 `varchar(50)`（见 Task 1 建表），超长会在 INSERT 时抛
  //    22001 ⇒ 走到全局错误处理 ⇒ **500**。而这条路正是「出了问题才走」的路 ——
  //    让上报端点在此时 500，等于安全网自己先断。本仓有前科：文旅 mini 那边的
  //    `transactionId` 超长就是同类缺陷，事后补的闸。
  //    productId 是**路由键**：截断后指向另一个/不存在的产品 = 存了一条看起来有效的假记录，
  //    比丢掉更坏 ⇒ 明确 400（服务端下发的 id 恒 ≤50，超长必然是客户端 bug 或伪造）。
  if (productId.length > 50) return c.json({ success: false, error: 'productId 过长' }, 400);

  const category = normalizeCategory(body?.category);
  // nodeId 是**纯诊断**字段（封面/音频/文牒类上报本来就不带它，传 null 合法），
  // 所以超长时降级成 null 而不是拒绝 —— 保住这条上报，但不存一个假的节点 id。
  const nodeId = typeof body?.nodeId === 'string' && body.nodeId && body.nodeId.length <= 50 ? body.nodeId : null;
  const note = typeof body?.note === 'string' && body.note ? body.note.slice(0, 500) : null;

  // `source` 用**显式白名单**，与 `normalizeCategory` 同款；缺省取 `'manual'`，与建表时
  // `source varchar(20) NOT NULL DEFAULT 'manual'` **保持一致**（两处说法不一致正是本仓反复踩的坑）。
  // ⚠️ 原稿写的是 `body?.source === 'manual' ? 'manual' : 'auto'` —— 排除式，且缺省落到 'auto'：
  //    既与 DDL 的默认值相反，又会让 'Manual' 这种大小写走样被静默记成自动上报。
  const source = body?.source === 'auto' ? 'auto' : 'manual';

  // detail 是**附件性质的自由 blob**，客户端可任意构造 ⇒ 必须限量，否则一个超大 body 就能
  // 让本端点吃满内存。注意取舍：**丢的只是 detail，上报本身永远不丢**（对齐 normalizeCategory 的
  // 「宁可存糙也不能丢」）。2000 字符对真实用途（`{where:'cover'}` 之类）绰绰有余。
  const rawDetail = body?.detail && typeof body.detail === 'object' && !Array.isArray(body.detail) ? body.detail : {};
  const detail = JSON.stringify(rawDetail).length <= 2000 ? rawDetail : {};
  // ⚠️ 原稿这里是 `{ ...detail, venueName: undefined }` —— 已删。`JSON.stringify` 会把
  //    `undefined` 的键整个丢掉，所以它实际是「剥掉客户端可能传的 detail.venueName」，
  //    但：① 全仓没有任何地方读 `detail.venueName`（Task 6/7 的 `venueName` 是**顶层**字段、
  //    由 venues 联查得出）；② 原稿没给理由。留着只会让审阅者反复猜它防的是什么。

  // 服务端去重（E6）：客户端不可信。取该游客在该剧本上**同类别的最近一条**。
  const [last] = await db.select({ createdAt: pmsBuiWenlvClientReports.createdAt, category: pmsBuiWenlvClientReports.category })
    .from(pmsBuiWenlvClientReports)
    .where(and(
      eq(pmsBuiWenlvClientReports.miniUserId, miniUser.miniUserId),
      eq(pmsBuiWenlvClientReports.productId, productId),
      eq(pmsBuiWenlvClientReports.category, category),
    ))
    .orderBy(desc(pmsBuiWenlvClientReports.createdAt))
    .limit(1);

  const now = new Date();
  if (isDuplicateWithin(last, category, now)) {
    return c.json({ success: true, data: { duplicate: true } });
  }

  const id = `wr_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  await db.insert(pmsBuiWenlvClientReports).values({
    id, productId, miniUserId: miniUser.miniUserId, nodeId, category, source,
    platform: miniUser.platform ?? null, note,
    detail,
    createdAt: now,
  });
  return c.json({ success: true, data: { duplicate: false, id } });
});

// GET /api/mini/wenlv/:id/claims — 我的档位领取台账（仅本人）
route.get('/:id/claims', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const productId = c.req.param('id');
    const claims = await db.select().from(pmsBuiWenlvClaims)
      .where(and(eq(pmsBuiWenlvClaims.productId, productId), eq(pmsBuiWenlvClaims.miniUserId, miniUser.miniUserId)))
      .orderBy(desc(pmsBuiWenlvClaims.claimedAt));
    if (claims.length === 0) return c.json({ success: true, data: [] });
    const tierIds = [...new Set(claims.map((x) => x.tierId))];
    const tiers = await db.select().from(pmsBuiWenlvRewardTiers).where(inArray(pmsBuiWenlvRewardTiers.id, tierIds));
    const tierMap = new Map(tiers.map((t) => [t.id, t]));
    return c.json({ success: true, data: claims.map((x) => ({
      id: x.id, tierId: x.tierId, tierName: tierMap.get(x.tierId)?.name ?? null,
      code: x.code, status: x.status, claimedAt: x.claimedAt, redeemedAt: x.redeemedAt,
    })) });
  } catch (e: any) {
    return serverError(c, e, '加载失败');
  }
});

// POST /api/mini/wenlv/:id/redeem — 领取档位奖励（核销码；同档幂等，重领返既有码）
route.post('/:id/redeem', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);
  try {
    const productId = c.req.param('id');
    const body = await c.req.json().catch(() => ({}));
    const tierId = typeof body.tierId === 'string' ? body.tierId : '';
    if (!tierId) return c.json({ success: false, error: '参数错误' }, 400);
    const denied = await assertTicket(c, productId, miniUser.miniUserId);
    if (denied) return denied;
    const progress = await getProgress(productId, miniUser.miniUserId);
    if (!progress) return c.json({ success: false, error: '尚未开始体验' }, 400);
    // 团队场次不发个人档位（§八 U1(b)）：核销通路整体关闭。
    // 位置要求：必须在档位判定之前 —— 并集一旦满足，人人能领到核销码，发出去的实物要收回。
    if (progress.sessionId) return c.json({ success: false, error: '团队场次不发个人档位，请用队伍进度兑换' }, 403);
    const [tier] = await db.select().from(pmsBuiWenlvRewardTiers)
      .where(and(eq(pmsBuiWenlvRewardTiers.id, tierId), eq(pmsBuiWenlvRewardTiers.productId, productId))).limit(1);
    if (!tier) return c.json({ success: false, error: '档位不存在' }, 404);
    // 幂等前置：已领过同档直接返回既有 claim（先于条件判定，保证已领不因后续状态变动二次发码）
    const [existing] = await db.select().from(pmsBuiWenlvClaims)
      .where(and(eq(pmsBuiWenlvClaims.progressId, progress.id), eq(pmsBuiWenlvClaims.tierId, tierId))).limit(1);
    if (existing) return c.json({ success: true, data: existing });
    // 档位达成判定（未达成 403；集章领奖不改 progress.status，非终局）
    const state = progress.state as WenlvState;
    if (!evalCondition(tier.condition ?? null, state)) {
      return c.json({ success: false, error: '档位未达成' }, 403);
    }
    // 生成唯一核销码（前缀 + 随机，撞唯一索引则重试）
    const makeCode = () => 'LY' + randomUUID().replace(/-/g, '').slice(0, 10).toUpperCase();
    let code = makeCode();
    // claim 行类型用 drizzle 推断（typeof existing 会塌成 undefined，改用 $inferSelect）
    type ClaimRow = typeof pmsBuiWenlvClaims.$inferSelect;
    let row: ClaimRow | undefined;
    // fresh=false 时 row 是并发先手插入的既有 claim（仅读回返回），不能再写 redeem event（先手已写）
    let fresh = false;
    for (let i = 0; i < 3; i++) {
      try {
        const [ins] = await db.insert(pmsBuiWenlvClaims).values({
          id: randomUUID(), productId, miniUserId: miniUser.miniUserId, progressId: progress.id,
          tierId, rewardId: tier.rewardId, code, status: 'claimed', claimedAt: new Date(), updatedAt: new Date(),
        }).returning();
        row = ins; fresh = true; break;
      } catch (e: any) {
        // 读 SQLSTATE/约束名必须穿透 drizzle 包装层：drizzle-orm 0.45.2 把 pg 错误包成
        // DrizzleQueryError，其 message 只有 `Failed query: <SQL>` 与 `params: <参数>`——
        // **既不含 23505 也不含约束名**，code / constraint 都在 cause 上（见 drizzle-orm/errors.js）。
        // 旧写法 `e?.code ?? e?.message` 因此恒不命中：同档并发双击的落后者被 rethrow → 外层 catch 返 500，
        // 并把 SQL 与参数（含刚生成的核销码）原文透给客户端。真 pg 错误从 `cause` 读。
        const pgErr = (e?.cause ?? e) as { code?: string; constraint?: string } | undefined;
        // claims 表有两个唯一约束，语义不同须按 constraint 精确区分（只看 23505 会把撞码误判成同档冲突）：
        //  - uq_wenlv_claims_progress_tier(progress_id,tier_id)：同档并发双击时落后者命中——
        //    先手已插入成功，重试换码必然再次撞同 (progressId,tierId)，须读回既有 claim 原样返回（幂等同码，不能返 500）
        //  - uq_wenlv_claims_code：核销码撞车（极低概率），换新 code 重试即可
        // 其余 23505（本表只剩 id 主键，随机 UUID 下实际不可达）不接，照旧抛出以免掩盖真实故障。
        if (pgErr?.code === '23505' && pgErr.constraint === 'uq_wenlv_claims_progress_tier') {
          const [winner] = await db.select().from(pmsBuiWenlvClaims)
            .where(and(eq(pmsBuiWenlvClaims.progressId, progress.id), eq(pmsBuiWenlvClaims.tierId, tierId))).limit(1);
          row = winner ?? undefined; break;
        }
        if (pgErr?.code === '23505' && pgErr.constraint === 'uq_wenlv_claims_code') {
          code = makeCode(); continue;
        }
        throw e;
      }
    }
    if (!row) return c.json({ success: false, error: '核销码生成失败，请重试' }, 500);
    if (fresh) {
      await db.insert(pmsBuiWenlvEvents).values({
        id: randomUUID(), productId, miniUserId: miniUser.miniUserId, eventType: 'redeem',
        nodeId: null, payload: { tierId, code },
      });
    }
    // 集章：不改 progress.status（非终局），幂等与档位语义已满足
    return c.json({ success: true, data: row });
  } catch (e: any) {
    return serverError(c, e, '领取失败');
  }
});

export default route;
