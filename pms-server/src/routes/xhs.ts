import { Hono } from 'hono';
import { eq, and, desc } from 'drizzle-orm';
import { db } from '../db/index.js';
import { pmsBuiXhsDrafts, pmsBuiXhsPosts } from '../db/schema/promotion.js';

const route = new Hono();

// ====== 草稿箱 CRUD ======

// GET /api/xhs/drafts — 获取草稿列表
route.get('/drafts', async (c) => {
  const status = c.req.query('status') || 'draft';
  const list = await db
    .select()
    .from(pmsBuiXhsDrafts)
    .where(
      and(
        eq(pmsBuiXhsDrafts.merchantId, 'default'),
        eq(pmsBuiXhsDrafts.status, status),
      ),
    )
    .orderBy(desc(pmsBuiXhsDrafts.updatedAt))
    .limit(50);
  return c.json({ success: true, data: list });
});

// POST /api/xhs/drafts — 保存草稿
route.post('/drafts', async (c) => {
  const body = await c.req.json();
  const id = `xhsd_${Date.now()}`;
  await db.insert(pmsBuiXhsDrafts).values({
    id,
    merchantId: 'default',
    title: body.title || '',
    content: body.content || '',
    tags: body.tags || [],
    images: body.images || [],
    calendarId: body.calendarId || null,
    status: 'draft',
  } as any);
  return c.json({ success: true, data: { id }, message: '草稿已保存' });
});

// PUT /api/xhs/drafts/:id — 更新草稿
route.put('/drafts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  await db
    .update(pmsBuiXhsDrafts)
    .set({
      title: body.title,
      content: body.content,
      tags: body.tags,
      images: body.images,
      status: body.status || 'draft',
      updatedAt: new Date(),
    } as any)
    .where(eq(pmsBuiXhsDrafts.id, id));
  return c.json({ success: true, message: '草稿已更新' });
});

// DELETE /api/xhs/drafts/:id — 删除草稿
route.delete('/drafts/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(pmsBuiXhsDrafts).where(eq(pmsBuiXhsDrafts.id, id));
  return c.json({ success: true, message: '草稿已删除' });
});

// ====== 发布前检查 ======

// POST /api/xhs/drafts/:id/check — AI发布前检查
route.post('/drafts/:id/check', async (c) => {
  const id = c.req.param('id');
  const [draft] = await db
    .select()
    .from(pmsBuiXhsDrafts)
    .where(eq(pmsBuiXhsDrafts.id, id));
  if (!draft) return c.json({ success: false, error: '草稿不存在' }, 404);

  const checks: Array<{ rule: string; pass: boolean; message: string; level: string }> = [];

  // 标题关键词检查
  const keywordPattern = /(民宿|酒店|旅游|攻略|推荐|打卡|探店|周末|亲子|情侣|周边|网红|隐藏|绝美)/;
  const titleHasKeyword = keywordPattern.test(draft.title || '');
  checks.push({
    rule: '标题关键词',
    pass: titleHasKeyword,
    message: titleHasKeyword
      ? '✅ 标题包含搜索关键词'
      : '⚠️ 建议在标题中加入民宿/旅游相关关键词以提升搜索曝光',
    level: titleHasKeyword ? 'pass' : 'warn',
  });

  // 正文字数
  const len = (draft.content || '').length;
  checks.push({
    rule: '正文字数',
    pass: len >= 100,
    message: len >= 100 ? `✅ 正文 ${len} 字` : `⚠️ 正文仅 ${len} 字，建议 100-1000 字`,
    level: len >= 100 ? 'pass' : len < 50 ? 'error' : 'warn',
  });

  // 话题标签
  const tags = (draft.tags as string[]) || [];
  checks.push({
    rule: '话题标签',
    pass: tags.length >= 3,
    message:
      tags.length >= 3
        ? `✅ ${tags.length} 个话题标签`
        : `⚠️ 仅 ${tags.length} 个标签，建议 5-8 个以覆盖更多搜索`,
    level: tags.length >= 3 ? 'pass' : tags.length === 0 ? 'error' : 'warn',
  });

  // 配图数量
  const images = (draft.images as string[]) || [];
  checks.push({
    rule: '配图数量',
    pass: images.length >= 3,
    message:
      images.length >= 3
        ? `✅ ${images.length} 张配图`
        : `⚠️ 仅 ${images.length} 张，建议 6-9 张以提升笔记质量分`,
    level: images.length >= 3 ? 'pass' : 'warn',
  });

  const allPass = checks.every(c => c.level === 'pass');
  const errors = checks.filter(c => c.level === 'error');
  const warnings = checks.filter(c => c.level === 'warn');

  return c.json({
    success: true,
    data: {
      checks,
      allPass,
      summary: allPass
        ? '✅ 全部通过，可以发布！'
        : errors.length > 0
          ? `❌ ${errors.length} 项需要修复，${warnings.length} 项建议优化`
          : `⚠️ ${warnings.length} 项建议优化`,
      errors: errors.length,
      warnings: warnings.length,
    },
  });
});

// ====== 发布记录 ======

// POST /api/xhs/posts — 记录发布
route.post('/posts', async (c) => {
  const body = await c.req.json();
  const id = `xhsp_${Date.now()}`;

  await db.insert(pmsBuiXhsPosts).values({
    id,
    merchantId: 'default',
    draftId: body.draftId || null,
    publishUrl: body.publishUrl || '',
    publishedAt: new Date(),
  } as any);

  // 更新关联草稿状态
  if (body.draftId) {
    await db
      .update(pmsBuiXhsDrafts)
      .set({ status: 'published', publishUrl: body.publishUrl, updatedAt: new Date() } as any)
      .where(eq(pmsBuiXhsDrafts.id, body.draftId));
  }
  return c.json({ success: true, data: { id }, message: '发布已记录' });
});

// GET /api/xhs/posts — 发布记录列表
route.get('/posts', async (c) => {
  const list = await db
    .select()
    .from(pmsBuiXhsPosts)
    .where(eq(pmsBuiXhsPosts.merchantId, 'default'))
    .orderBy(desc(pmsBuiXhsPosts.createdAt))
    .limit(50);
  return c.json({ success: true, data: list });
});

// PATCH /api/xhs/posts/:id — 更新笔记数据（手动录入互动数据）
route.patch('/posts/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  await db
    .update(pmsBuiXhsPosts)
    .set({
      views: body.views,
      likes: body.likes,
      collects: body.collects,
      comments: body.comments,
      conversions: body.conversions,
      orders: body.orders,
      statsUpdatedAt: new Date(),
    } as any)
    .where(eq(pmsBuiXhsPosts.id, id));
  return c.json({ success: true, message: '数据已更新' });
});

// ====== 分析数据 ======

// GET /api/xhs/analytics — 获取分析概览
route.get('/analytics', async (c) => {
  const posts = await db
    .select()
    .from(pmsBuiXhsPosts)
    .where(eq(pmsBuiXhsPosts.merchantId, 'default'));

  const totalViews = posts.reduce((s, p) => s + (p.views || 0), 0);
  const totalLikes = posts.reduce((s, p) => s + (p.likes || 0), 0);
  const totalCollects = posts.reduce((s, p) => s + (p.collects || 0), 0);
  const totalComments = posts.reduce((s, p) => s + (p.comments || 0), 0);
  const totalConversions = posts.reduce((s, p) => s + (p.conversions || 0), 0);
  const totalOrders = posts.reduce((s, p) => s + (p.orders || 0), 0);

  return c.json({
    success: true,
    data: {
      totalPosts: posts.length,
      totalViews,
      totalLikes,
      totalCollects,
      totalComments,
      totalConversions,
      totalOrders,
      avgLikes: posts.length ? Math.round(totalLikes / posts.length) : 0,
      conversionRate: totalViews > 0 ? ((totalConversions / totalViews) * 100).toFixed(1) + '%' : '0%',
      posts: posts.map(p => ({
        id: p.id,
        publishUrl: p.publishUrl,
        views: p.views || 0,
        likes: p.likes || 0,
        collects: p.collects || 0,
        comments: p.comments || 0,
        conversions: p.conversions || 0,
        orders: p.orders || 0,
        publishedAt: p.publishedAt,
      })),
    },
  });
});

export default route;
