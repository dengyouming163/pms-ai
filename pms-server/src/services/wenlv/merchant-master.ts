// 商户主数据 service（0081）：/merchants 模块的列表与详情聚合。
// 概念区分：本文件操作 pms_bui_wenlv_merchants（主数据）；场地级合作挂接
// （pms_bui_wenlv_merchant_partners）经 merchant_id 回指本表 —— Task 21 场地档案
// 切换后才写入，本 service 只消费它做关联场地计数 / 合作场地与剧本房聚合。
import { and, desc, eq, isNotNull, like, or, sql } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiWenlvMerchants, pmsBuiWenlvMerchantPartners, pmsBuiWenlvVenues, pmsBuiWenlvScriptRooms,
} from '../../db/schema/index.js';

export type MerchantMasterListParams = { q?: string; status?: string };

/** like 模式串转义：q 里的 % 和 _ 是通配符，搜「100%」会把整表匹配进来 ——
 *  字面化后再包 %%，语义才是「包含这两个字符」。PG like 默认转义符是反斜杠。 */
const escapeLike = (raw: string) => raw.replace(/[\\%_]/g, '\\$&');

/** 列表 where 构建：抽纯函数供单测（不打库，同 funnel.test 范式）。
 *  q 非空 → 名称/联系人模糊匹配；status 非空 → 精确等值；两者可叠加。 */
export function buildMerchantMasterWhere(params: MerchantMasterListParams) {
  const conds = [];
  const q = params.q?.trim();
  if (q) conds.push(or(
    like(pmsBuiWenlvMerchants.name, `%${escapeLike(q)}%`),
    like(pmsBuiWenlvMerchants.contactName, `%${escapeLike(q)}%`),
  ));
  if (params.status) conds.push(eq(pmsBuiWenlvMerchants.status, params.status));
  return conds.length ? and(...conds) : undefined;
}

/** 关联场地数： merchant_partners 按 merchant_id 计 distinct venue（无关挂接行数）。
 *  用相关子查询而不是 join 聚合，避免与列表行的其他 select 互相干扰。 */
const venueCountSql = sql<number>`(select count(distinct vp.venue_id)::int from pms_bui_wenlv_merchant_partners vp where vp.merchant_id = ${pmsBuiWenlvMerchants.id})`;

export async function listMerchantMaster(params: MerchantMasterListParams) {
  return db.select({
    id: pmsBuiWenlvMerchants.id,
    name: pmsBuiWenlvMerchants.name,
    type: pmsBuiWenlvMerchants.type,
    contactName: pmsBuiWenlvMerchants.contactName,
    contactPhone: pmsBuiWenlvMerchants.contactPhone,
    status: pmsBuiWenlvMerchants.status,
    note: pmsBuiWenlvMerchants.note,
    createdAt: pmsBuiWenlvMerchants.createdAt,
    venueCount: venueCountSql,
  }).from(pmsBuiWenlvMerchants)
    .where(buildMerchantMasterWhere(params))
    .orderBy(desc(pmsBuiWenlvMerchants.createdAt));
}

export async function getMerchantDetail(id: string) {
  const [merchant] = await db.select().from(pmsBuiWenlvMerchants)
    .where(eq(pmsBuiWenlvMerchants.id, id)).limit(1);
  if (!merchant) return null;
  // 合作场地：挂接行 join 场地表。一个场地可能有多条挂接行（不同剧本房各挂一条），
  // 而 merchantPartnerId 每行不同，SQL DISTINCT 去不掉 —— 拉回后按场地 id 去重（保留首条），
  // 保留挂接行 id 供前端解绑（deleteMerchant(merchantPartnerId)）。
  const venueRows = await db.select({
    merchantPartnerId: pmsBuiWenlvMerchantPartners.id,
    id: pmsBuiWenlvVenues.id,
    name: pmsBuiWenlvVenues.name,
    status: pmsBuiWenlvVenues.status,
  }).from(pmsBuiWenlvMerchantPartners)
    .innerJoin(pmsBuiWenlvVenues, eq(pmsBuiWenlvVenues.id, pmsBuiWenlvMerchantPartners.venueId))
    .where(eq(pmsBuiWenlvMerchantPartners.merchantId, id))
    .orderBy(desc(pmsBuiWenlvMerchantPartners.createdAt));
  const venues = [...new Map(venueRows.map((r) => [r.id, r])).values()];
  // 剧本房引用：挂接行反向绑房（script_room_id 非空）join 房表，纯展示（Task 22 才加跳转）。
  const roomRows = await db.select({
    id: pmsBuiWenlvScriptRooms.id,
    name: pmsBuiWenlvScriptRooms.name,
    status: pmsBuiWenlvScriptRooms.status,
    contentId: pmsBuiWenlvScriptRooms.contentId,
  }).from(pmsBuiWenlvMerchantPartners)
    .innerJoin(pmsBuiWenlvScriptRooms, eq(pmsBuiWenlvScriptRooms.id, pmsBuiWenlvMerchantPartners.scriptRoomId))
    .where(and(eq(pmsBuiWenlvMerchantPartners.merchantId, id), isNotNull(pmsBuiWenlvMerchantPartners.scriptRoomId)));
  const rooms = [...new Map(roomRows.map((r) => [r.id, r])).values()];
  return { merchant, venues, rooms };
}
