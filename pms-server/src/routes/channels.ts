import { Hono } from 'hono';
import { z } from 'zod';
import jwt from 'jsonwebtoken';
import { db } from '../db/index';
import { pmsBuiChannels, pmsBuiReviews } from '../db/schema';
import { eq, desc, isNull, and, sql } from 'drizzle-orm';
import { validateBody } from '../utils/validate';
import { JWT_SECRET } from '../constants.js';

function getMerchantId(c: any): string {
  const auth = c.req.header('Authorization');
  if (auth?.startsWith('Bearer ')) {
    try { const p = jwt.verify(auth.slice(7), JWT_SECRET) as any; return p.merchantId || 'default'; } catch {}
  }
  return 'default';
}

const route = new Hono();

// Map DB channel row to frontend ChannelInfo format
function mapChannel(ch: any) {
  return {
    id: ch.id,
    name: ch.name,
    icon: ch.icon,
    color: ch.color,
    category: ch.category || 'domestic_ota',
    status: ch.status,
    commission: ch.commissionRate ? parseFloat(ch.commissionRate) : 0,
    autoSync: ch.autoSync ?? true,
    autoPrice: ch.autoPrice ?? false,
    syncInterval: ch.syncInterval ?? 30,
    lastSyncAt: ch.lastSyncAt ? new Date(ch.lastSyncAt).toISOString() : '',
    todayOrders: ch.todayOrders ?? 0,
    todayRevenue: ch.todayRevenue ?? 0,
    monthOrders: ch.monthOrders ?? 0,
    monthRevenue: ch.monthRevenue ?? 0,
    account: ch.account || '',
    balance: ch.balance ?? 0,
    features: ch.features || [],
    description: ch.description || '',
    connectedAt: ch.connectedAt ? new Date(ch.connectedAt).toISOString() : '',
  };
}

// Map DB review row to frontend ReviewInfo format
function mapReview(rv: any) {
  return {
    id: rv.id,
    channelId: rv.channelId,
    channelName: rv.channelName,
    channelIcon: rv.channelIcon,
    guestName: rv.guestName,
    rating: rv.rating,
    content: rv.content || '',
    roomType: rv.roomType || '标准间',
    stayDate: rv.stayDate || '',
    replyStatus: rv.replyStatus,
    replyContent: rv.replyContent || '',
    reviewTime: rv.reviewTime,
  };
}

route.get('/', async (c) => {
  const type = c.req.query('type');
  const isCatalog = c.req.query('catalog') === '1';
  const storeId = isCatalog ? '' : (c.req.query('storeId') || c.req.header('X-Store-Id') || '');

  // 渠道目录模式：只返回平台模板
  if (isCatalog) {
    const all = await db.select().from(pmsBuiChannels).where(isNull((pmsBuiChannels as any).storeId));
    return c.json({ channels: all.map(mapChannel) });
  }

  // 门店渠道配置：返回目录+门店开通的合并列表
  if (storeId) {
    const [catalog, storeChannels] = await Promise.all([
      db.select().from(pmsBuiChannels).where(isNull((pmsBuiChannels as any).storeId)),
      db.select().from(pmsBuiChannels).where(eq((pmsBuiChannels as any).storeId, storeId)),
    ]);
    // 合并：门店开通的覆盖目录默认值，未开通的状态设为 inactive
    const merged = catalog.map(ch => {
      const sc = storeChannels.find(s => s.name === ch.name);
      return sc ? mapChannel({ ...ch, ...sc }) : mapChannel({ ...ch, status: 'inactive' });
    });
    return c.json({ channels: merged });
  }

  if (type === 'mappings') {
    const channels = await db.select().from(pmsBuiChannels);
    return c.json(channels.map(ch => ({
      id: ch.id,
      channelId: ch.id,
      name: ch.name,
      status: ch.status,
      connectedAt: ch.connectedAt ? new Date(ch.connectedAt).toISOString() : '',
    })));
  }

  if (type === 'sync') {
    const channels = await db.select().from(pmsBuiChannels);
    return c.json({
      synced: channels.map(ch => ({
        channelId: ch.id,
        name: ch.name,
        lastSync: new Date().toISOString(),
        status: 'success',
      })),
    });
  }

  if (type === 'inventory') {
    const channels = await db.select().from(pmsBuiChannels);
    return c.json({
      channels: channels.map(ch => ({
        id: ch.id,
        name: ch.name,
        synced: ch.status === 'connected',
        lastSync: ch.lastSyncAt ? new Date(ch.lastSyncAt).toISOString() : '',
        inventoryCount: ch.todayOrders || 0,
      })),
    });
  }

  if (type === 'reviews') {
    const reviews = await db.select().from(pmsBuiReviews).orderBy(desc(pmsBuiReviews.reviewTime));
    return c.json(reviews.map(mapReview));
  }

  // Default: return channels list with summary
  const channels = await db.select().from(pmsBuiChannels);
  const mapped = channels.map(mapChannel);

  const connected = mapped.filter(ch => ch.status === 'connected').length;
  const disconnected = mapped.filter(ch => ch.status === 'disconnected').length;
  const error = mapped.filter(ch => ch.status === 'error').length;
  const totalOrders = mapped.reduce((s, ch) => s + ch.todayOrders, 0);
  const totalMonthOrders = mapped.reduce((s, ch) => s + ch.monthOrders, 0);
  const totalMonthRevenue = mapped.reduce((s, ch) => s + ch.monthRevenue, 0);
  const avgCommission = mapped.length > 0
    ? Math.round(mapped.reduce((s, ch) => s + ch.commission, 0) / mapped.length * 10) / 10
    : 0;

  const summary = {
    total: mapped.length,
    connected,
    disconnected,
    error,
    todayOrders: totalOrders,
    monthOrders: totalMonthOrders,
    monthRevenue: totalMonthRevenue,
    avgCommission,
  };

  return c.json({ channels: mapped, summary });
});

// Zod 请求体验证 schema
const channelsActionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('sync') }),
  z.object({
    action: z.literal('reply'),
    reviewId: z.string().min(1, '评价ID不能为空'),
    content: z.string().min(1, '回复内容不能为空'),
  }),
  z.object({
    action: z.literal('toggleChannel'),
    channelId: z.string().min(1, '渠道ID不能为空'),
    status: z.enum(['connected', 'disconnected', 'error']),
  }),
  z.object({
    action: z.literal('enable-store'),
    channelId: z.string().min(1),
    storeId: z.string().min(1),
    commissionRate: z.number().optional(),
  }),
  z.object({
    action: z.literal('disable-store'),
    channelId: z.string().min(1),
    storeId: z.string().min(1),
  }),
  z.object({
    action: z.literal('upsert-store'),
    channelId: z.string().min(1),
    storeId: z.string().min(1),
    commissionRate: z.number().optional(),
    account: z.string().optional(),
    autoSync: z.boolean().optional(),
  }),
]);

route.post('/', async (c) => {
  const body = await c.req.json();
  const validation = await validateBody(body, channelsActionSchema);
  if (!validation.success) {
    return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
  }
  const { data } = validation;

  if (data.action === 'sync') {
    return c.json({ success: true, message: '同步已触发' });
  }

  if (data.action === 'reply') {
    const { reviewId, content } = data;
    await db.update(pmsBuiReviews)
      .set({ replyContent: content, replyStatus: 'replied' })
      .where(eq(pmsBuiReviews.id, reviewId));
    return c.json({ success: true });
  }

  // 门店渠道操作
  if (data.action === ('enable-store' as any)) {
    const { channelId, storeId, commissionRate } = data as any;
    const [catalog] = await db.select().from(pmsBuiChannels).where(eq(pmsBuiChannels.id, channelId));
    if (!catalog) return c.json({ success: false, error: '渠道不存在' }, 404);
    const storeChannelId = `${storeId}_${channelId}`;
    await db.insert(pmsBuiChannels).values({
      id: storeChannelId, merchantId: getMerchantId(c), storeId,
      name: catalog.name, icon: catalog.icon, color: catalog.color,
      type: catalog.type, category: catalog.category,
      commissionRate: String(commissionRate || catalog.commissionRate),
      status: 'active', features: catalog.features, description: catalog.description,
      autoSync: catalog.autoSync, todayOrders: 0, todayRevenue: 0, monthOrders: 0, monthRevenue: 0, balance: 0,
    }).onConflictDoUpdate({ target: pmsBuiChannels.id, set: { status: 'active', commissionRate: String(commissionRate || catalog.commissionRate) } } as any);
    return c.json({ success: true, message: '渠道已开通' });
  }

  if (data.action === ('disable-store' as any)) {
    const { channelId, storeId } = data as any;
    const storeChannelId = `${storeId}_${channelId}`;
    // 尝试按ID查找，找不到则按storeId+name查找
    let [target] = await db.select().from(pmsBuiChannels).where(eq(pmsBuiChannels.id, storeChannelId));
    if (!target) {
      const [catalog] = await db.select().from(pmsBuiChannels).where(eq(pmsBuiChannels.id, channelId));
      if (catalog) {
        [target] = await db.select().from(pmsBuiChannels)
          .where(and(eq((pmsBuiChannels as any).storeId, storeId), eq(pmsBuiChannels.name, catalog.name)));
      }
    }
    if (target) {
      await db.update(pmsBuiChannels).set({ status: 'inactive' } as any).where(eq(pmsBuiChannels.id, target.id));
    }
    // 未开通的渠道无需停用，直接返回成功
    return c.json({ success: true, message: '渠道已停用' });
  }

  if (data.action === ('upsert-store' as any)) {
    const { channelId, storeId, commissionRate, account, autoSync } = data as any;
    const [catalog] = await db.select().from(pmsBuiChannels).where(eq(pmsBuiChannels.id, channelId));
    if (!catalog) return c.json({ success: false, error: '渠道不存在' }, 404);
    const storeChannelId = `${storeId}_${channelId}`;
    await db.insert(pmsBuiChannels).values({
      id: storeChannelId, merchantId: getMerchantId(c), storeId,
      name: catalog.name, icon: catalog.icon, color: catalog.color,
      type: catalog.type, category: catalog.category,
      commissionRate: String(commissionRate || catalog.commissionRate),
      account: account || '', status: 'active',
      features: catalog.features, description: catalog.description,
      autoSync: autoSync ?? catalog.autoSync,
      todayOrders: 0, todayRevenue: 0, monthOrders: 0, monthRevenue: 0, balance: 0,
    }).onConflictDoUpdate({ target: pmsBuiChannels.id, set: { status: 'active', commissionRate: String(commissionRate), account: account || '', autoSync: autoSync ?? catalog.autoSync } } as any);
    return c.json({ success: true, message: '配置已保存' });
  }

  if (data.action === 'toggleChannel') {
    const { channelId, status } = data;
    await db.update(pmsBuiChannels)
      .set({ status })
      .where(eq(pmsBuiChannels.id, channelId));
    return c.json({ success: true });
  }

  return c.json({ success: true });
});

export default route;
