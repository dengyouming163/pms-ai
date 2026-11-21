import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import route from '../regions.js';
import { REGION_CITIES, REGION_DESTINATIONS } from '../../../constants.js';

const app = new Hono();
app.route('/api/mini/regions', route);

describe('GET /api/mini/regions', () => {
  it('返回城市级 + 热门目的地级两组标签', async () => {
    const res = await app.request('/api/mini/regions');
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.cities).toEqual([...REGION_CITIES]);
    expect(body.data.destinations).toEqual([...REGION_DESTINATIONS]);
  });
});
