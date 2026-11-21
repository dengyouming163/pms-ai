// 履约包聚合（P2 spec §4）：原子实例清单 / 实体道具 / 商户培训卡 / 场地配合能力一次返回，
// 不落存储，供创作台内容编辑器的履约包打印视图消费。
//
// 纪律（与 project-board / publish-check 同款）：
//   · expandAtoms 是**纯函数**（无 IO）：节点排序 + atoms 展开，可单测；
//   · buildFulfillmentPack 承担全部 IO（产品 venueId / 节点 / 道具 / 商户 / 场地档案），
//     前端零推断，直接消费四个分片。
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvProps,
  pmsBuiWenlvMerchantPartners, pmsBuiWenlvVenueProfiles,
} from '../../db/schema/index.js';
import { loadRuntimeGraph } from './script-room.js';

export type FulfillmentPack = {
  atoms: Array<{ nodeId: string; nodeTitle: string; atomId: string; type: string; title?: string }>;
  props: Array<{ id: string; name: string; code: string | null; placeNote: string | null }>;
  merchants: Array<{ id: string; name: string; platformMerchantId: string | null; staffCard: unknown }>;
  supportActions: Record<string, unknown>;
};

/** expandAtoms 的节点入参：与 nodes 表 select 投影同形（纯结构，可内存构造）。 */
export type PackNodeRow = {
  id: string;
  title: string;
  atoms?: readonly { id: string; type: string; title?: string }[] | null;
  mapX: number | null;
  mapY: number | null;
  createdAt: Date;
};

// 坐标比较：null 排最后（未上图的节点不抢动线前排）。
const cmpCoord = (a: number | null, b: number | null): number =>
  a === null ? (b === null ? 0 : 1) : b === null ? -1 : a - b;

/**
 * 节点排序 + atoms 展开纯函数。
 * 履约顺序取画布坐标近似动线：mapY 升 → mapX 升 → createdAt 升，null 坐标排最后。
 * （atoms 元素无 order 字段——0073 已删；节点顺序即打印视图的履约顺序。）
 * atoms 为 null/[] 的节点跳过，不产出行。
 */
export function expandAtoms(nodes: readonly PackNodeRow[]): FulfillmentPack['atoms'] {
  const sorted = [...nodes].sort((a, b) =>
    cmpCoord(a.mapY, b.mapY) || cmpCoord(a.mapX, b.mapX) || a.createdAt.getTime() - b.createdAt.getTime());
  const atoms: FulfillmentPack['atoms'] = [];
  for (const node of sorted) {
    for (const atom of node.atoms ?? []) {
      atoms.push({ nodeId: node.id, nodeTitle: node.title, atomId: atom.id, type: atom.type, title: atom.title });
    }
  }
  return atoms;
}

/**
 * 组装履约包：atoms（坐标动线序）+ 实体道具 + 商户培训卡 + 场地配合能力。
 * 产品未绑场地 ⇒ merchants=[]、supportActions={}（空形状有意义，前端直接渲染空态）。
 */
export async function buildFulfillmentPack(productId: string): Promise<FulfillmentPack> {
  const [product] = await db.select({ venueId: pmsBuiWenlvProducts.venueId })
    .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId)).limit(1);
  const venueId = product?.venueId ?? null;

  const [runtime, propRows, merchantRows, profileRows] = await Promise.all([
    // 0079 统一模型：节点即 scenes，经规范图投影取（结局场景已剔除，坐标/atoms 全保留）。
    loadRuntimeGraph(productId),
    db.select({
      id: pmsBuiWenlvProps.id,
      name: pmsBuiWenlvProps.name,
      code: pmsBuiWenlvProps.code,
      placeNote: pmsBuiWenlvProps.placeNote,
    }).from(pmsBuiWenlvProps).where(eq(pmsBuiWenlvProps.productId, productId)),
    venueId
      ? db.select({
          id: pmsBuiWenlvMerchantPartners.id,
          name: pmsBuiWenlvMerchantPartners.name,
          platformMerchantId: pmsBuiWenlvMerchantPartners.platformMerchantId,
          staffCard: pmsBuiWenlvMerchantPartners.staffCard,
        }).from(pmsBuiWenlvMerchantPartners).where(eq(pmsBuiWenlvMerchantPartners.venueId, venueId))
      : Promise.resolve([] as { id: string; name: string; platformMerchantId: string | null; staffCard: string | null }[]),
    venueId
      ? db.select({ supportActions: pmsBuiWenlvVenueProfiles.supportActions })
        .from(pmsBuiWenlvVenueProfiles).where(eq(pmsBuiWenlvVenueProfiles.venueId, venueId)).limit(1)
      : Promise.resolve([] as { supportActions: Record<string, unknown> }[]),
  ]);

  return {
    atoms: expandAtoms(runtime.nodes),
    props: propRows,
    merchants: merchantRows,
    supportActions: profileRows[0]?.supportActions ?? {},
  };
}
