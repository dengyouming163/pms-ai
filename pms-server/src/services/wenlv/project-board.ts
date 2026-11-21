// 驾驶舱项目看板（P2 spec §3）：六步进度判据纯函数 + 逐产品聚合。
//
// 纪律：
//   · deriveSteps 是**纯函数**（无 IO）：只根据聚合查询结果推六步灯态，可单测；
//   · buildProjectBoard 承担全部 IO（逐产品查 venue/profile/商户/节点/队伍/进度），
//     前端零推断，直接消费 steps；
//   · publish ④ 的 todoCount 走依赖注入：路由层组装 loadProductIntegrityInput +
//     buildPublishChecklist，服务层不反向依赖 route（保持可测、无循环 import）。
import { eq, and, ne, isNotNull, count } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvVenues, pmsBuiWenlvVenueProfiles,
  pmsBuiWenlvMerchantPartners,
  pmsBuiWenlvDirectorStates, pmsBuiWenlvProgress,
} from '../../db/schema/index.js';
import { loadRuntimeGraph } from './script-room.js';

export type StepState = 'done' | 'partial' | 'todo';

export type BoardSteps = {
  venue: StepState;                     // ① 建场：绑 venueId 且场地存在
  profile: StepState;                   // ② 档案商户：双有 done，仅档案 partial，皆无 todo
  content: StepState;                   // ③ 剧本内容：节点≥1 且含 atoms 节点≥1 done；仅节点 partial；0 节点 todo
  publish: { state: StepState; todoCount: number }; // ④ 发布就绪：todoCount=0 done，>0 partial
  deploy: StepState;                    // ⑤ 布房履约：venue.status==='live' done，否则 todo（未绑场地也是 todo）
  ops: { activeTeams: number; completedTotal: number }; // ⑥ 营业数据：纯计数无灯
};

/** 六步判据纯函数（输入为聚合查询结果，不打库，可单测）。 */
export function deriveSteps(input: {
  venueId: string | null; venueExists: boolean; venueStatus: string | null;
  hasProfile: boolean; linkedMerchants: number;   // linkedMerchants = platformMerchantId 非空的合作商户数
  nodeCount: number; atomNodeCount: number;
  publishTodoCount: number;
  activeTeams: number; completedTotal: number;
}): BoardSteps {
  return {
    // ① 建场：绑了 venueId 且场地真实存在 ⇒ done；其余（未绑 / 绑了但场地不存在）⇒ todo
    venue: input.venueId && input.venueExists ? 'done' : 'todo',
    // ② 档案商户：档案 + 已关联平台商户 ⇒ done；仅档案 ⇒ partial；皆无 ⇒ todo
    profile: input.hasProfile && input.linkedMerchants > 0 ? 'done'
      : input.hasProfile ? 'partial' : 'todo',
    // ③ 剧本内容：节点≥1 且至少 1 个节点配了 atoms ⇒ done；有节点但全无 atoms ⇒ partial；0 节点 ⇒ todo
    content: input.nodeCount > 0 && input.atomNodeCount > 0 ? 'done'
      : input.nodeCount > 0 ? 'partial' : 'todo',
    // ④ 发布就绪：预检清单清空 ⇒ done；有待办 ⇒ partial（不存在 todo 态——清单本身就是待办集合）
    publish: { state: input.publishTodoCount === 0 ? 'done' : 'partial', todoCount: input.publishTodoCount },
    // ⑤ 布房履约：场地进入 live ⇒ done；其余一律 todo（含未绑场地）
    deploy: input.venueStatus === 'live' ? 'done' : 'todo',
    // ⑥ 营业数据：纯计数无灯
    ops: { activeTeams: input.activeTeams, completedTotal: input.completedTotal },
  };
}

export interface ProjectBoardRow { productId: string; name: string; venueId: string | null; steps: BoardSteps }

/**
 * 逐产品聚合驾驶舱六步进度。products 排除软删（status='deleted'）。
 * publishTodoCount 由路由层注入（loadProductIntegrityInput + buildPublishChecklist 的清单长度），
 * 本服务不反向 import route。
 */
export async function buildProjectBoard(deps: {
  publishTodoCount: (productId: string) => Promise<number>;
}): Promise<ProjectBoardRow[]> {
  const products = await db.select({
    id: pmsBuiWenlvProducts.id,
    name: pmsBuiWenlvProducts.name,
    venueId: pmsBuiWenlvProducts.venueId,
  }).from(pmsBuiWenlvProducts).where(ne(pmsBuiWenlvProducts.status, 'deleted'));

  const rows: ProjectBoardRow[] = [];
  for (const product of products) {
    const venueId = product.venueId ?? null;
    const [venueRow, profileRow, merchantAgg, runtime, teamAgg, progressAgg, publishTodoCount] = await Promise.all([
      venueId
        ? db.select({ status: pmsBuiWenlvVenues.status }).from(pmsBuiWenlvVenues)
          .where(eq(pmsBuiWenlvVenues.id, venueId)).limit(1)
        : Promise.resolve([] as { status: string }[]),
      venueId
        ? db.select({ id: pmsBuiWenlvVenueProfiles.id }).from(pmsBuiWenlvVenueProfiles)
          .where(eq(pmsBuiWenlvVenueProfiles.venueId, venueId)).limit(1)
        : Promise.resolve([] as { id: string }[]),
      venueId
        ? db.select({ n: count() }).from(pmsBuiWenlvMerchantPartners)
          .where(and(eq(pmsBuiWenlvMerchantPartners.venueId, venueId), isNotNull(pmsBuiWenlvMerchantPartners.platformMerchantId)))
        : Promise.resolve([{ n: 0 }]),
      // 0079 统一模型：节点/原子只从规范图投影装配（nodeId 即 scene.id，结局场景已剔除）。
      loadRuntimeGraph(product.id),
      db.select({ n: count() }).from(pmsBuiWenlvDirectorStates)
        .where(eq(pmsBuiWenlvDirectorStates.productId, product.id)),
      db.select({ n: count() }).from(pmsBuiWenlvProgress)
        .where(and(eq(pmsBuiWenlvProgress.productId, product.id), eq(pmsBuiWenlvProgress.status, 'completed'))),
      deps.publishTodoCount(product.id),
    ]);

    const nodeRows = runtime.nodes;
    const nodeCount = nodeRows.length;
    const atomNodeCount = nodeRows.filter((n) => Array.isArray(n.atoms) && n.atoms.length > 0).length;

    rows.push({
      productId: product.id,
      name: product.name,
      venueId,
      steps: deriveSteps({
        venueId,
        venueExists: venueRow.length > 0,
        venueStatus: venueRow[0]?.status ?? null,
        hasProfile: profileRow.length > 0,
        linkedMerchants: merchantAgg[0]?.n ?? 0,
        nodeCount,
        atomNodeCount,
        publishTodoCount,
        activeTeams: teamAgg[0]?.n ?? 0,
        completedTotal: progressAgg[0]?.n ?? 0,
      }),
    });
  }
  return rows;
}
