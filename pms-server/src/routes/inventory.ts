import { Hono } from 'hono';
import { eq, and, desc, sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiRooms, pmsBuiOrders } from '../db/schema/index.js';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';

const route = new Hono();

// GET /api/inventory/overview — 库存概览
route.get('/overview', async (c) => {
  const scope = getTenantScope(c);
  const allRooms = await db.select().from(pmsBuiRooms).where(and(...tenantWhere(scope, pmsBuiRooms)));
  const today = new Date().toISOString().split('T')[0];

  const total = allRooms.length;
  const available = allRooms.filter(r => r.status === 'available').length;
  const occupied = allRooms.filter(r => r.status === 'occupied').length;
  const dirty = allRooms.filter(r => r.status === 'dirty').length;
  const maintenance = allRooms.filter(r => r.status === 'maintenance').length;

  // 各渠道今日订单
  const orders = await db.select().from(pmsBuiOrders).where(and(...tenantWhere(scope, pmsBuiOrders)));
  const channelSold: Record<string, number> = {};
  orders.filter(o => o.status === 'confirmed' || o.status === 'checked_in').forEach(o => {
    const ch = o.channel || '直营';
    channelSold[ch] = (channelSold[ch] || 0) + 1;
  });

  return c.json({
    success: true,
    data: {
      total, available, occupied, dirty, maintenance,
      occupancyRate: total > 0 ? Math.round((occupied / total) * 100) : 0,
      channelSold,
      alert: available <= 2 ? 'urgent' : available <= 5 ? 'warning' : 'normal',
      alertMsg: available <= 2 ? '🚨 仅剩2间可售' : available <= 5 ? '⚠️ 可售不足5间' : '',
    },
  });
});

// POST /api/inventory/save-quotas — 保存渠道配额
route.post('/save-quotas', async (c) => {
  const scope = getTenantScope(c);
  const body = await c.req.json();
  const { quotas } = body as { quotas: Record<string, Record<string, number>> };
  const storeId = scope.storeId !== '*' ? scope.storeId : 'default_store';

  // 先删除该门店所有旧配额
  await db.execute(sql`DELETE FROM pms_bui_channel_inventory WHERE store_id = ${storeId}`);

  // 重新插入
  for (const [roomType, channels] of Object.entries(quotas)) {
    for (const [channel, quota] of Object.entries(channels)) {
      if (quota > 0) {
        const id = `ci_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        await db.execute(sql`INSERT INTO pms_bui_channel_inventory (id, merchant_id, store_id, channel_id, room_type_id, quota) VALUES (${id}, ${scope.merchantId}, ${storeId}, ${channel}, ${roomType}, ${quota})`);
      }
    }
  }
  return c.json({ success: true, message: '配额已保存' });
});

// GET /api/inventory/quotas — 加载已保存配额
route.get('/quotas', async (c) => {
  const scope = getTenantScope(c);
  const storeId = scope.storeId !== '*' ? scope.storeId : 'default_store';
  const result = await db.execute(`SELECT room_type_id, channel_id, quota FROM pms_bui_channel_inventory WHERE store_id = '${storeId}'`);
  const quotas: Record<string, Record<string, number>> = {};
  const rows = (result as any).rows || result || [];
  if (Array.isArray(rows)) {
    rows.forEach((r: any) => {
      if (!quotas[r.room_type_id]) quotas[r.room_type_id] = {};
      quotas[r.room_type_id][r.channel_id] = Number(r.quota);
    });
  }
  return c.json({ success: true, data: quotas });
});

export default route;
