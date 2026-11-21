import { Hono } from 'hono';
import { REGION_CITIES, REGION_DESTINATIONS } from '../../constants.js';

const route = new Hono();

/**
 * GET /api/mini/regions — 地域标签选项（公开，无需登录）
 * 返回城市级 + 热门目的地级两组标签，供发现页 / 匹配向导 / 平台后台渲染 chips。
 */
route.get('/', (c) => {
  return c.json({
    success: true,
    data: {
      cities: [...REGION_CITIES],
      destinations: [...REGION_DESTINATIONS],
    },
  });
});

export default route;
