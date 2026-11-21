/** 占用库存的订单状态（待支付也占用——预订单锁库存的关键） */
export const OCCUPYING_STATUSES: readonly string[] = ['pending', 'pending_confirm', 'confirmed', 'checked_in'];

/** 两个日期区间是否重叠（字符串比较可行：YYYY-MM-DD 字典序=日期序；退房日不占当晚） */
export function nightsOverlap(aIn: string, aOut: string, bIn: string, bOut: string): boolean {
  return aIn < bOut && aOut > bIn;
}

/** 统计与目标区间重叠的同房型占用订单数 */
export function countOccupied(
  orders: { roomTypeId: string | null; checkIn: string; checkOut: string; status: string }[],
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
): number {
  return orders.filter(
    (o) =>
      o.roomTypeId === roomTypeId &&
      OCCUPYING_STATUSES.includes(o.status) &&
      nightsOverlap(o.checkIn, o.checkOut, checkIn, checkOut),
  ).length;
}

/** 是否还有可订余量 */
export function isAvailable(totalRooms: number, occupied: number): boolean {
  return occupied < totalRooms;
}
