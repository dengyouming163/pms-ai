import { eq, and, inArray, sql } from 'drizzle-orm';
import { db, type Tx } from '../db/index.js';
import { pmsBuiRooms, pmsBuiOrders } from '../db/schema/index.js';
import { OCCUPYING_STATUSES, isAvailable } from '../utils/mini-availability.js';

/**
 * 在事务内对房型加行锁后执行 fn。
 * 并发下单同一房型会在 FOR UPDATE 上排队，保证「检查可订→建单」原子性。
 */
export async function withRoomTypeLock<T>(roomTypeId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  return db.transaction(async (tx) => {
    // 对房型行加锁（房型不存在时 fn 内部自行校验）
    await tx.execute(sql`SELECT id FROM pms_bui_room_types WHERE id = ${roomTypeId} FOR UPDATE`);
    return fn(tx);
  });
}

/** 事务内检查可订余量（必须在 withRoomTypeLock 内调用） */
export async function checkAvailability(
  tx: Tx,
  storeId: string,
  roomTypeId: string,
  checkIn: string,
  checkOut: string,
): Promise<{ total: number; occupied: number; available: boolean }> {
  const rooms = await tx.select({ id: pmsBuiRooms.id }).from(pmsBuiRooms)
    .where(and(eq(pmsBuiRooms.storeId, storeId), eq(pmsBuiRooms.roomTypeId, roomTypeId)));
  const overlapping = await tx.select({ id: pmsBuiOrders.id }).from(pmsBuiOrders)
    .where(and(
      eq(pmsBuiOrders.storeId, storeId),
      eq(pmsBuiOrders.roomTypeId, roomTypeId),
      inArray(pmsBuiOrders.status, OCCUPYING_STATUSES),
      sql`${pmsBuiOrders.checkIn} < ${checkOut}`,
      sql`${pmsBuiOrders.checkOut} > ${checkIn}`,
    ));
  const total = rooms.length;
  const occupied = overlapping.length;
  return { total, occupied, available: isAvailable(total, occupied) };
}
