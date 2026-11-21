// C 端「我的订单」合并列表的规范化层：把各来源（住宿/文旅/套餐）的行**只做形状统一**，不做语义统一。
// 纯函数、无 IO —— 排序与文案这些最容易被写错的东西在这里可以被独立判定。
//
// 🔴 三条刻意的「不统一」（改了就是造第二个权威，第一次不一致时没有裁判）：
//   ① 状态词表：住宿与文旅各有一套（住宿有 pending_confirm/confirmed，文旅有 refunding/refunded）
//      ⇒ 原样透传。C 端按 type 分支渲染。
//   ② 金额类型：住宿 total_price 是 integer、文旅 total_amount 是 numeric(10,2)（drizzle 下是 string）
//      ⇒ 一律 String() 成字符串。**本层绝不做算术**，要算钱在各权威层算。
//   ③ 时间：一律 ISO 字符串（住宿侧是 Date 对象、文旅侧过 JSON 来已是字符串）。
//
// ⚠️ 合并的是**窗口**不是全集：三个来源各带自己的窗口（住宿 limit(50)、套餐我们传 limit=50、
//    文旅走平台侧全量列表）。跨库无法做真正的全局分页（游标要贯穿三个来源）⇒ 本层只保证「窗口内有序」。

export type UnifiedOrder = {
  type: 'wenlv' | 'lodging' | 'product';
  id: string;
  orderNo: string;
  title: string;
  amount: string;
  status: string;
  paymentStatus: string;
  createdAt: string;
  payDeadline: string | null;
  extra: Record<string, unknown>;
};

/** Date | string | null → ISO 字符串；非法/缺失给 ''（**不抛** —— 一条坏数据不该让整页 500） */
function iso(v: unknown): string {
  if (v == null) return '';
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isNaN(d.getTime()) ? '' : d.toISOString();
}

export function toUnifiedLodging(row: any, storeName: string | null): UnifiedOrder {
  const title = [storeName, row.roomType].filter(Boolean).join(' · ') || '住宿订单';
  return {
    type: 'lodging',
    id: String(row.id),
    orderNo: String(row.orderNo ?? ''),
    title,
    amount: String(row.totalPrice ?? ''),
    status: String(row.status ?? ''),
    paymentStatus: String(row.paymentStatus ?? ''),
    createdAt: iso(row.createdAt),
    payDeadline: row.payDeadline == null ? null : iso(row.payDeadline) || null,
    // 住宿独有的字段原样带上（C 端日期/晚数要用）。**不**改名成文旅那边的叫法。
    extra: {
      checkIn: row.checkIn ?? null, checkOut: row.checkOut ?? null, nights: row.nights ?? null,
      guestName: row.guestName ?? null,
    },
  };
}

export function toUnifiedWenlv(row: any): UnifiedOrder {
  return {
    type: 'wenlv',
    id: String(row.id),
    orderNo: String(row.orderNo ?? ''),
    title: row.productName ? String(row.productName) : '文旅订单',
    amount: String(row.totalAmount ?? ''),
    status: String(row.status ?? ''),
    paymentStatus: String(row.paymentStatus ?? ''),
    createdAt: iso(row.createdAt),
    payDeadline: row.payDeadline == null ? null : iso(row.payDeadline) || null,
    // leaderCode 是**能力码**（看全场实时位置 + 从本订单票池取票）；本改动不扩大暴露面：
    // 同一个值今天已到达同一个客户端（C 端 pms-nimi/src/api/modules/wenlv.ts 的 listWenlvOrders() → BFF routes/mini/wenlv-trade.ts 的 raw proxy 原样透传平台行；pages/wenlv/leader.vue 就靠它取码）。⚠️ 别读成服务端 services/platform-client.ts 的同名函数，那是另一条路。缺失显式 null。
    extra: { quantity: row.quantity ?? null, seatCount: row.seatCount ?? null, slotId: row.slotId ?? null,
             leaderCode: row.leaderCode ?? null },
  };
}

/**
 * 套餐产品单（平台 `pms_platform_product_orders`）→ 统一形状。
 * `extra` 的键不是为了对齐别的来源，是为了复刻被删组件 `OrderCard.vue` 的**展示**语义：
 *   storeId（入住指南入参）、reservationStatus（预约标识/去预约）、roomNights + quantity +
 *   reservationDate（日期行）、mode + depositAmount（模式 A 的「订金 ¥x」与「订金锁定」）。
 * 少一个键 ⇒ 新订单页上对应那段**静默**消失，不报错。
 */
export function toUnifiedProduct(row: any): UnifiedOrder {
  return {
    type: 'product',
    id: String(row.id),
    orderNo: String(row.orderNo ?? ''),
    title: row.productName ? String(row.productName) : '套餐订单',
    amount: String(row.totalAmount ?? ''),
    status: String(row.status ?? ''),
    paymentStatus: String(row.paymentStatus ?? ''),
    createdAt: iso(row.createdAt),
    payDeadline: row.payDeadline == null ? null : iso(row.payDeadline) || null,
    extra: {
      storeId: row.storeId ?? null,
      reservationStatus: row.reservationStatus ?? null,
      roomNights: row.roomNights ?? null,
      quantity: row.quantity ?? null,
      reservationDate: row.reservationDate ?? null,
      mode: row.mode ?? null,
      depositAmount: row.depositAmount ?? null,
    },
  };
}

/** 按 createdAt 降序。返回**新数组**（不就地改调用方的数组）。
 *  时间解析不出来的行排最后（不是排最前，也不是抛）—— NaN 参与比较会让 sort 结果**依赖引擎**。
 *  哨兵必须是**下确界**：`-1` 不是，任何 pre-1970 的合法时间戳（负值）都比它小，
 *  那种行会被排到坏行后面，「坏行排最后」就不成立。用 `-Infinity` 才无条件成立。
 *  两条都坏时 `-Infinity - -Infinity` 得 NaN，而规范把比较函数的 NaN 当 +0（不交换）⇒ 序仍确定。 */
export function sortUnified(list: readonly UnifiedOrder[]): UnifiedOrder[] {
  const ts = (o: UnifiedOrder) => {
    const t = Date.parse(o.createdAt);
    return Number.isNaN(t) ? Number.NEGATIVE_INFINITY : t;
  };
  return [...list].sort((a, b) => ts(b) - ts(a));
}
