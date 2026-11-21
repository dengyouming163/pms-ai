// wwwroot/pms-server/src/routes/ota/import.ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { db } from '../../db/index.js';
import { pmsBuiRoomTypes } from '../../db/schema/rooms.js';
import { mediaAssets } from '../../db/schema/assets.js';
import { eq, and } from 'drizzle-orm';
import { randomUUID } from 'crypto';
import { z } from 'zod';
import { serverError } from '../../lib/http-error.js';

const roomTypeInputSchema = z.object({
  name: z.string().min(1),
  bedType: z.string().optional(),
  area: z.union([z.string(), z.number()]).optional(),
  maxGuests: z.number().optional(),
  facilities: z.array(z.string()).optional(),
  roomCount: z.number().optional(),
  basePrice: z.number().optional(),
  images: z.array(z.string()).optional(),
  description: z.string().optional(),
});

const importRoomsSchema = z.object({
  roomTypes: z.array(roomTypeInputSchema).min(1, 'roomTypes 不能为空'),
});

const assetInputSchema = z.object({
  url: z.string().min(1),
  name: z.string().min(1),
  assetCategory: z.string().optional(),
  tags: z.array(z.string()).optional(),
});

const importAssetsSchema = z.object({
  assets: z.array(assetInputSchema).min(1, 'assets 不能为空'),
});

const route = new Hono();

// 从 otaAuthMiddleware 注入的上下文获取 storeId 和 merchantId
function resolveStoreContext(c: Context) {
  const storeId = c.get('storeId') as string;
  const merchantId = c.get('merchantId') as string;
  if (!storeId) throw new Error('无法解析门店ID，请检查 API Key 绑定状态');
  return { storeId, merchantId: merchantId || 'default' };
}

// GET /api/ota/import/rooms — 查询已有房型（去重用）
route.get('/rooms', async (c) => {
  try {
    const { storeId } = resolveStoreContext(c);
    const roomTypes = await db
      .select()
      .from(pmsBuiRoomTypes)
      .where(eq(pmsBuiRoomTypes.storeId, storeId));
    return c.json({ roomTypes });
  } catch (err: any) {
    return serverError(c, err, '查询房型失败');
  }
});

// POST /api/ota/import/rooms — 批量导入房型
route.post('/rooms', async (c) => {
  try {
    const { storeId, merchantId } = resolveStoreContext(c);
    const body = await c.req.json();
    const parsed = importRoomsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: '参数校验失败', details: parsed.error.issues }, 400);
    }
    const { roomTypes } = parsed.data;

    let created = 0;
    let skipped = 0;

    for (const rt of roomTypes) {
      // 去重：按 name + storeId 查重
      const existing = await db
        .select({ id: pmsBuiRoomTypes.id })
        .from(pmsBuiRoomTypes)
        .where(
          and(
            eq(pmsBuiRoomTypes.storeId, storeId),
            eq(pmsBuiRoomTypes.name, rt.name),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // 新建房型
      await db.insert(pmsBuiRoomTypes).values({
        id: `rt-${randomUUID()}`,
        merchantId,
        storeId,
        name: rt.name || '未命名房型',
        bedType: rt.bedType || '大床',
        area: rt.area ? String(rt.area) : '0',
        maxGuests: rt.maxGuests || 2,
        facilities: rt.facilities || [],
        roomCount: rt.roomCount || 1,
        basePrice: rt.basePrice || 0,
        images: rt.images || [],
        description: rt.description || '',
        status: 'active',
      });
      created++;
    }

    return c.json({ created, skipped });
  } catch (err: any) {
    return serverError(c, err, '导入房型失败');
  }
});

// GET /api/ota/import/assets — 查询已有素材（去重用）
// 素材统一写入 media_assets 表（与 pms-web /api/assets 素材库同源，门店后台可见）
route.get('/assets', async (c) => {
  try {
    const { storeId } = resolveStoreContext(c);
    const rows = await db
      .select()
      .from(mediaAssets)
      .where(
        and(
          eq(mediaAssets.storeId, storeId),
          eq(mediaAssets.status, 'active'),
        ),
      );

    const assets = rows.map((r) => ({
      id: r.id,
      url: r.url,
      name: r.name,
      assetCategory: r.category,
      tags: (r.purposeTags as string[]) || [],
    }));

    return c.json({ assets });
  } catch (err: any) {
    return serverError(c, err, '查询素材失败');
  }
});

// POST /api/ota/import/assets — 批量导入素材元数据（写入 media_assets，与 pms-web 素材库同源）
route.post('/assets', async (c) => {
  try {
    const { storeId, merchantId } = resolveStoreContext(c);
    const body = await c.req.json();
    const parsed = importAssetsSchema.safeParse(body);
    if (!parsed.success) {
      return c.json({ error: '参数校验失败', details: parsed.error.issues }, 400);
    }
    const { assets } = parsed.data;

    let created = 0;
    let skipped = 0;

    for (const asset of assets) {
      // 去重：按 name + storeId 查重
      const existing = await db
        .select({ id: mediaAssets.id })
        .from(mediaAssets)
        .where(
          and(
            eq(mediaAssets.storeId, storeId),
            eq(mediaAssets.name, asset.name),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        skipped++;
        continue;
      }

      // 新建素材记录（与 /api/assets POST 结构一致，仅上传人为空）
      await db.insert(mediaAssets).values({
        id: `asset_${randomUUID()}`,
        merchantId,
        storeId,
        url: asset.url,
        name: asset.name,
        mediaType: 'image',
        category: asset.assetCategory || 'room',
        purposeTags: asset.tags || [],
        value: { source: 'ota-import', createdAt: new Date().toISOString() },
      });
      created++;
    }

    return c.json({ created, skipped });
  } catch (err: any) {
    return serverError(c, err, '导入素材失败');
  }
});

export default route;
