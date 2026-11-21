// node_refiner 锚点装配：调 LLM 前把全剧本真实 ID 白名单与上下文一次性装齐。
// 锚点是**硬约束** —— LLM 只能引用 whitelist 内真实存在的 collectible/npc/character/node ID，
// 邻接关系也以库里真实的 node_edges 为准，不靠 prompt 里口头要求「不要编造」。
//
// ⛔ venue_points.code 是现场二维码 / 信标里原样编码的**到场凭证**，绝不进 prompt（spec §6.2）：
//    点位只经 projectPoint 投影 name，code 在类型与查询投影两层都没有进入锚点的路径。
import { db } from '../../../db/index.js';
import {
  pmsBuiWenlvProducts,
  pmsBuiWenlvScenes,
  pmsBuiWenlvCollectibles,
  pmsBuiWenlvNpcs,
  pmsBuiWenlvCharacters,
  pmsBuiWenlvVenuePoints,
} from '../../../db/schema/wenlv.js';
import type { WenlvTheme, WenlvProductConfig, WenlvStyleBible } from '../../../db/schema/wenlv.js';
import { eq } from 'drizzle-orm';
import { loadRuntimeGraph } from '../script-room.js';

export interface RefineAnchor {
  product: {
    id: string;
    name: string;
    subtitle: string | null;
    theme: WenlvTheme;
    config: WenlvProductConfig;
    styleBible: WenlvStyleBible | null;
  };
  node: Record<string, unknown>;
  venuePointName: string | null;
  whitelist: {
    collectibles: { id: string; name: string; type: string }[];
    npcs: { id: string; name: string }[];
    characters: { id: string; name: string; identity: string | null }[];
    nodes: { id: string; title: string; nodeType: string }[];
  };
  neighbors: {
    prev: { id: string; title: string; edgeType: string }[];
    next: { id: string; title: string; edgeType: string }[];
  };
}

// 只投影点位 name：入参类型上就没有 code，从结构上杜绝到场凭证泄露。
export function projectPoint(p: { name: string } | undefined): string | null {
  if (!p) return null;
  return p.name;
}

type NeighborEdge = { fromNodeId: string; toNodeId: string; edgeType: string };

// prev = 指向当前节点的边（toNodeId===nodeId），取其 from 端；
// next = 从当前节点出发的边（fromNodeId===nodeId），取其 to 端。
// titleMap 缺名时回退 '(未命名)'，绝不让 undefined 进 prompt。
export function computeNeighbors(
  nodeId: string,
  edges: NeighborEdge[],
  titleMap: Record<string, string | undefined>,
): RefineAnchor['neighbors'] {
  const titleOf = (id: string): string => titleMap[id] ?? '(未命名)';
  return {
    prev: edges
      .filter((e) => e.toNodeId === nodeId)
      .map((e) => ({ id: e.fromNodeId, title: titleOf(e.fromNodeId), edgeType: e.edgeType })),
    next: edges
      .filter((e) => e.fromNodeId === nodeId)
      .map((e) => ({ id: e.toNodeId, title: titleOf(e.toNodeId), edgeType: e.edgeType })),
  };
}

export async function buildRefineAnchor(productId: string, nodeId: string): Promise<RefineAnchor> {
  // 0079 统一模型：节点/邻接从规范图 loadRuntimeGraph 取；当前节点取 scenes 全列（供 prompt 上下文）。
  const [productRows, nodeRows, runtime, collectibles, npcs, characters] = await Promise.all([
    db.select().from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId)).limit(1),
    db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, nodeId)).limit(1),
    loadRuntimeGraph(productId),
    db
      .select({
        id: pmsBuiWenlvCollectibles.id,
        name: pmsBuiWenlvCollectibles.name,
        type: pmsBuiWenlvCollectibles.type,
      })
      .from(pmsBuiWenlvCollectibles)
      .where(eq(pmsBuiWenlvCollectibles.productId, productId)),
    db
      .select({ id: pmsBuiWenlvNpcs.id, name: pmsBuiWenlvNpcs.name })
      .from(pmsBuiWenlvNpcs)
      .where(eq(pmsBuiWenlvNpcs.productId, productId)),
    db
      .select({
        id: pmsBuiWenlvCharacters.id,
        name: pmsBuiWenlvCharacters.name,
        // 描述列真实列名是 identity_desc（JS: identityDesc）；identity 是「隐士/捕快」短标签，不是描述。
        identityDesc: pmsBuiWenlvCharacters.identityDesc,
      })
      .from(pmsBuiWenlvCharacters)
      .where(eq(pmsBuiWenlvCharacters.productId, productId)),
  ]);

  const product = productRows[0];
  if (!product) throw new Error('产品不存在');
  const currentNode = nodeRows[0];
  if (!currentNode) throw new Error('节点不存在');

  // 规范图投影的 nodes（含 id/title/nodeType）与 edges（fromNodeId/toNodeId/edgeType）。
  const productNodes = runtime.nodes;
  const edges = runtime.edges;

  const titleMap: Record<string, string> = {};
  for (const n of productNodes) {
    titleMap[n.id] = n.title;
  }

  // 点位名：node 绑定了 venuePointId 才查点位，且只 select name 一列（code 不查、不投影）。
  let venuePointName: string | null = null;
  if (currentNode.venuePointId) {
    const pointRows = await db
      .select({ name: pmsBuiWenlvVenuePoints.name })
      .from(pmsBuiWenlvVenuePoints)
      .where(eq(pmsBuiWenlvVenuePoints.id, currentNode.venuePointId))
      .limit(1);
    venuePointName = projectPoint(pointRows[0]);
  }

  return {
    product: {
      id: product.id,
      name: product.name,
      subtitle: product.subtitle,
      theme: product.theme,
      config: product.config,
      styleBible: product.styleBible,
    },
    node: currentNode as Record<string, unknown>,
    venuePointName,
    whitelist: {
      collectibles: collectibles.map((c) => ({ id: c.id, name: c.name, type: c.type })),
      npcs: npcs.map((n) => ({ id: n.id, name: n.name })),
      // identityDesc 空值（null/undefined）统一归一 null，保证锚点形状稳定。
      characters: characters.map((c) => ({ id: c.id, name: c.name, identity: c.identityDesc ?? null })),
      nodes: productNodes.map((n) => ({ id: n.id, title: n.title, nodeType: n.nodeType })),
    },
    neighbors: computeNeighbors(nodeId, edges, titleMap),
  };
}
