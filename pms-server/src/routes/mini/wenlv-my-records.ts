// C 端「我的探秘」列表读口。与 my-play 的区别：
//   my-play 基于**券**（listWenlvTickets）⇒ 只有买过券的剧本才出现，玩完券用完的剧本会消失。
//   my-records 基于**进度表**（pms_bui_wenlv_progress）⇒ 所有玩过的剧本（active + completed）都出现，
//     是真正的「历史探秘记录」。
// 单独挂载在 /api/mini/wenlv/my-records，理由同 my-play（避免被 /:id 吞掉）。
import { Hono } from 'hono';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiWenlvProgress, pmsBuiWenlvProducts } from '../../db/schema/index.js';
import { parseMiniToken } from '../../middleware/mini-auth.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

route.get('/', async (c) => {
  const miniUser = parseMiniToken(c.req.header('Authorization'));
  if (!miniUser) return c.json({ success: false, error: '未登录' }, 401);

  try {
    // 1. 查当前用户所有探秘进度（active + completed，排除 abandoned）
    const progRows = await db.select({
      id: pmsBuiWenlvProgress.id,
      productId: pmsBuiWenlvProgress.productId,
      status: pmsBuiWenlvProgress.status,
      characterId: pmsBuiWenlvProgress.characterId,
      startedAt: pmsBuiWenlvProgress.startedAt,
      completedAt: pmsBuiWenlvProgress.completedAt,
      updatedAt: pmsBuiWenlvProgress.updatedAt,
    }).from(pmsBuiWenlvProgress)
      .where(and(
        eq(pmsBuiWenlvProgress.miniUserId, miniUser.miniUserId),
        inArray(pmsBuiWenlvProgress.status, ['active', 'completed']),
      ));

    if (!progRows.length) return c.json({ success: true, data: { list: [] } });

    // 2. 批量查产品名（一次 inArray，不 N+1）
    const productIds = [...new Set(progRows.map((r) => r.productId))];
    const prodRows = await db.select({
      id: pmsBuiWenlvProducts.id,
      name: pmsBuiWenlvProducts.name,
      coverImage: pmsBuiWenlvProducts.coverImage,
    }).from(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, productIds));
    const prods = new Map(prodRows.map((p) => [p.id, p]));

    // 3. 组装返回（按 updatedAt 降序：最近玩的在前）
    const list = progRows.map((r) => {
      const p = prods.get(r.productId);
      return {
        progressId: r.id,
        contentProductId: r.productId,
        productName: p?.name ?? null,
        coverImage: p?.coverImage ?? null,
        playState: r.status === 'completed' ? 'completed' : 'playing',
        characterId: r.characterId,
        startedAt: r.startedAt.toISOString(),
        completedAt: r.completedAt ? r.completedAt.toISOString() : null,
        updatedAt: r.updatedAt.toISOString(),
      };
    });
    list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    return c.json({ success: true, data: { list } });
  } catch (e: any) {
    return serverError(c, e, '加载探秘记录失败');
  }
});

export default route;
