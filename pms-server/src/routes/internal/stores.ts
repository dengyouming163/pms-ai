import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiStores } from '../../db/schema/index.js';
import { PREFERENCE_TAGS, REGION_TAGS } from '../../constants.js';

const route = new Hono();

/**
 * PUT /api/internal/stores/:storeId/city-tags
 * 平台后台配置门店「城市 + 偏好标签」（pms-nimi 平台化 Task 5）
 * 需 internalAuthMiddleware 校验 X-Internal-Service-Token（与 /api/internal/notify 同源）。
 *
 * body: { city?: string, preferenceTags?: string[] }
 *   - city：门店所在城市（长度 ≤ 50，可为空表示清除）
 *   - preferenceTags：偏好标签，必须取自固定库 PREFERENCE_TAGS，自动去重
 *
 * 幂等：重复提交相同值结果一致。
 */
route.put('/:storeId/city-tags', async (c) => {
  const storeId = c.req.param('storeId') || '';
  if (!storeId) return c.json({ success: false, error: '缺少 storeId' }, 400);

  const body = await c.req.json().catch(() => ({}));
  const hasCity = typeof body.city === 'string';
  const city = hasCity ? body.city.trim().slice(0, 50) : undefined;
  const hasTags = Array.isArray(body.preferenceTags);
  const rawTags: string[] = hasTags
    ? body.preferenceTags.filter((t: unknown): t is string => typeof t === 'string')
    : [];
  const hasRegionTags = Array.isArray(body.regionTags);
  const rawRegionTags: string[] = hasRegionTags
    ? body.regionTags.filter((t: unknown): t is string => typeof t === 'string')
    : [];

  // 至少需提供一个可更新字段
  if (!hasCity && !hasTags && !hasRegionTags) {
    return c.json({ success: false, error: '请至少提供 city、preferenceTags 或 regionTags' }, 400);
  }

  // 校验标签是否在固定库内
  const validSet = new Set<string>(PREFERENCE_TAGS);
  const invalid = rawTags.filter((t: string) => !validSet.has(t));
  if (invalid.length > 0) {
    return c.json({
      success: false,
      error: `无效偏好标签: ${invalid.join('、')}，仅支持 ${PREFERENCE_TAGS.join('、')}`,
    }, 400);
  }

  // 去重并保持原有顺序
  const preferenceTags = [...new Set(rawTags)];

  // 校验地域标签是否在固定库内（城市级 + 热门目的地级）
  const regionValidSet = new Set<string>(REGION_TAGS);
  const invalidRegions = rawRegionTags.filter((t: string) => !regionValidSet.has(t));
  if (invalidRegions.length > 0) {
    return c.json({
      success: false,
      error: `无效地域标签: ${invalidRegions.join('、')}，仅支持 ${REGION_TAGS.join('、')}`,
    }, 400);
  }
  const regionTags = [...new Set(rawRegionTags)];

  // 校验门店存在
  const [store] = await db
    .select({ id: pmsBuiStores.id })
    .from(pmsBuiStores)
    .where(eq(pmsBuiStores.id, storeId))
    .limit(1);
  if (!store) return c.json({ success: false, error: '门店不存在' }, 404);

  // 仅更新显式提供的字段（幂等）
  const setData: Record<string, unknown> = { updatedAt: new Date() };
  if (hasCity) setData.city = city || null;
  if (hasTags) setData.preferenceTags = preferenceTags;
  if (hasRegionTags) setData.regionTags = regionTags;
  await db.update(pmsBuiStores).set(setData).where(eq(pmsBuiStores.id, storeId));

  return c.json({
    success: true,
    data: {
      id: storeId,
      city: hasCity ? city : undefined,
      preferenceTags: hasTags ? preferenceTags : undefined,
      regionTags: hasRegionTags ? regionTags : undefined,
    },
  });
});

export default route;
