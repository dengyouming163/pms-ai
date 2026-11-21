import { Hono } from 'hono';
import { db } from '../db/index';
import { pmsBuiSettings, pmsBuiRoomTypes } from '../db/schema';
import { eq, and, desc, sql } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';

const route = new Hono();

// POST /api/kb/ai-generate — 触发 AI 生成周边推荐
route.post('/ai-generate', async (c) => {
  const scope = getTenantScope(c);

  // 1. 读取民宿档案
  const [profileRow] = await db.select().from(pmsBuiSettings)
    .where(and(eq(pmsBuiSettings.category, 'property_profile'), eq(pmsBuiSettings.key, 'main'), ...tenantWhere(scope, pmsBuiSettings)))
    .limit(1);

  const profile = (profileRow?.value || {}) as Record<string, any>;

  // 2. 读取房型数据
  const roomTypes = await db.select({
    name: pmsBuiRoomTypes.name,
    basePrice: pmsBuiRoomTypes.basePrice,
    area: pmsBuiRoomTypes.area,
    bedType: pmsBuiRoomTypes.bedType,
    maxGuests: pmsBuiRoomTypes.maxGuests,
  }).from(pmsBuiRoomTypes)
    .where(and(eq(pmsBuiRoomTypes.storeId, scope.storeId), eq(pmsBuiRoomTypes.status, 'active')));

  // 3. 封装 AI 上下文
  const context = {
    profile: {
      name: profile.name || '',
      address: profile.address || '',
      description: profile.description || '',
      full_description: profile.full_description || '',
      region: profile.region || '',
      landmarks: profile.landmarks || '',
      tags: profile.tags || [],
      facilities: {
        wifi: profile.wifi, parking: profile.parking,
        pet_friendly: profile.pet_friendly, garden: profile.garden,
        meals_included: profile.meals_included,
      },
      dining: {
        breakfast_type: profile.breakfast_type,
        local_cuisine: profile.local_cuisine,
      },
      transport: {
        airport_distance: profile.airport_distance,
        station_distance: profile.station_distance,
        pickup_service: profile.pickup_service,
      },
    },
    room_types: roomTypes,
    room_count: roomTypes.length,
  };

  // 4. 调用千问生成
  const prompt = `你是贵州民宿周边推荐专家。根据以下民宿信息，生成周边推荐。必须基于民宿的真实位置和区域来生成，不能编造不存在的地点。

民宿信息：
${JSON.stringify(context, null, 2)}

请输出标准JSON格式：
{
  "recommendations": {
    "scenic": [{ "title": "...", "content": "50-100字自然语言描述", "metadata": { "distance_km": 0.5, "distance_text": "步行10分钟", "price": "门票10元", "tags": ["古镇","历史"] } }],  // 至少3条
    "food": [{ "title": "...", "content": "50-100字描述", "metadata": { "distance_km": 0.3, "distance_text": "步行5分钟", "price": "人均15元", "tags": ["本地特色"] } }],  // 至少3条
    "transport": { "title": "交通指南", "content": "出行建议", "metadata": { "airport": "40分钟车程", "station": "30分钟车程", "local": "公交X路" } },
    "climate": { "title": "气候贴士", "content": "气候描述+穿衣建议", "metadata": { "summer": "均温23℃", "best_months": "7-9月" } },
    "culture": [{ "title": "...", "content": "人文体验描述", "metadata": { "distance_km": 8, "distance_text": "驾车15分钟", "price": "体验¥80/人", "tags": ["苗族","体验"] } }]  // 至少2条
  }
}

只输出JSON，不要markdown代码块。`;

  const llmRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY || ''}`,
    },
    body: JSON.stringify({
      model: 'qwen-max',
      messages: [{ role: 'user', content: prompt }],
      temperature: 0.3,
    }),
  });
  const llmData = await llmRes.json() as any;

  let result;
  try {
    const text = llmData.choices[0].message.content;
    result = JSON.parse(text.replace(/```json\n?|```/g, '').trim());
  } catch {
    return c.json({ success: false, error: 'AI 生成失败，请稍后重试' }, 500);
  }

  // 5. 存入 pms_bui_settings
  const recs = result.recommendations;
  const types = [
    { key: 'scenic', items: recs.scenic || [] },
    { key: 'food', items: recs.food || [] },
    { key: 'transport', items: [recs.transport].filter(Boolean) },
    { key: 'climate', items: [recs.climate].filter(Boolean) },
    { key: 'culture', items: recs.culture || [] },
  ];

  let count = 0;
  for (const { key, items } of types) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!item) continue;
      const id = `guide_${scope.storeId}_${key}_${i}`;
      await db.insert(pmsBuiSettings).values({
        id, merchantId: scope.merchantId, storeId: scope.storeId,
        category: 'kb_guide', key: `guide_${key}_${i}`,
        value: {
          guide_type: key,
          title: item.title || item.name || '',
          content: item.content || item.description || '',
          metadata: item.metadata || {},
          status: 'draft',
          ai_generated: true,
          version: 1,
          generated_at: new Date().toISOString(),
        },
      } as any).onConflictDoUpdate({
        target: [pmsBuiSettings.id],
        set: { value: sql`excluded.value`, updatedAt: new Date() } as any,
      });
      count++;
    }
  }

  return c.json({ success: true, message: `已生成 ${count} 条周边推荐，请到周边推荐页审核发布`, count });
});

// GET /api/kb/guides — 读取周边推荐列表
route.get('/guides', async (c) => {
  const scope = getTenantScope(c);
  const rows = await db.select().from(pmsBuiSettings)
    .where(and(eq(pmsBuiSettings.category, 'kb_guide'), ...tenantWhere(scope, pmsBuiSettings)))
    .orderBy(desc(pmsBuiSettings.updatedAt));
  return c.json({ success: true, data: rows });
});

// PUT /api/kb/guides/:id — 更新单条
route.put('/guides/:id', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json();
  await db.update(pmsBuiSettings)
    .set({ value: body, updatedAt: new Date() } as any)
    .where(eq(pmsBuiSettings.id, id));
  return c.json({ success: true });
});

// PUT /api/kb/guides/:id/publish — 发布
route.put('/guides/:id/publish', async (c) => {
  const id = c.req.param('id');
  const [row] = await db.select().from(pmsBuiSettings).where(eq(pmsBuiSettings.id, id)).limit(1);
  if (!row) return c.json({ success: false, error: '不存在' }, 404);
  const val = { ...(row.value as any), status: 'published' };
  await db.update(pmsBuiSettings)
    .set({ value: val, updatedAt: new Date() } as any)
    .where(eq(pmsBuiSettings.id, id));
  return c.json({ success: true });
});

// DELETE /api/kb/guides/:id
route.delete('/guides/:id', async (c) => {
  const id = c.req.param('id');
  await db.delete(pmsBuiSettings).where(eq(pmsBuiSettings.id, id));
  return c.json({ success: true });
});

// POST /api/kb/ai-assist — AI 辅助写作（描述/地标/标签）
route.post('/ai-assist', async (c) => {
  const { type, context } = await c.req.json();

  const prompts: Record<string, string> = {
    description: `为民宿写一句吸引人的一句话描述（30字以内）。民宿名：${context.name}，位置：${context.region}${context.address}，特点：${(context.tags||[]).join('、')}。`,
    full_description: `为民宿写一段详细介绍（100-150字），包含位置、风格、适合人群。民宿名：${context.name}，区域：${context.region}，地址：${context.address}，标签：${(context.tags||[]).join('、')}。`,
    landmarks: `根据民宿位置列出周边主要地标和景点（3-5个，每行一个，格式：地标名 - 距离描述）。地址：${context.address}，区域：${context.region}，经纬度：${context.geo_lat},${context.geo_lng}。`,
  };

  const prompt = prompts[type];
  if (!prompt) return c.json({ success: false, error: '不支持的类型' }, 400);

  const llmRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY || ''}` },
    body: JSON.stringify({ model: 'qwen-turbo', messages: [{ role: 'user', content: prompt }], temperature: 0.5, max_tokens: 200 }),
  });
  const data = await llmRes.json() as any;
  const text = data.choices[0].message.content.trim();
  return c.json({ success: true, data: { text } });
});

// POST /api/kb/ai-optimize — AI 优化添加单条周边推荐
route.post('/ai-optimize', async (c) => {
  const scope = getTenantScope(c);
  const { category, keyword, storeContext } = await c.req.json();
  if (!category || !keyword) return c.json({ success: false, error: '缺少参数' }, 400);

  const typePrompts: Record<string, string> = {
    scenic: `为"${keyword}"写一段50-80字的景点推荐描述，格式：{"title":"${keyword}","content":"描述文字","metadata":{"distance_km":估算距离数字,"distance_text":"距离描述如步行10分钟","price":"门票价格如免费或门票20元","tags":["标签1","标签2"]}}。只输出JSON。`,
    food: `为"${keyword}"写一段50-80字的美食推荐描述，格式：{"title":"${keyword}","content":"描述文字","metadata":{"distance_km":估算距离,"distance_text":"距离描述如步行5分钟","price":"人均价格如人均30元","tags":["标签"]}}。只输出JSON。`,
    transport: `为"${keyword}"写一段50-80字的交通指南描述，格式：{"title":"交通指南-${keyword}","content":"描述文字","metadata":{"method":"交通方式","duration":"时间","cost":"费用"}}。只输出JSON。`,
    climate: `为"${keyword}"写一段50-80字的气候贴士，格式：{"title":"气候贴士-${keyword}","content":"描述文字","metadata":{"temp":"温度","tips":"穿衣建议"}}。只输出JSON。`,
    culture: `为"${keyword}"写一段50-80字的人文推荐描述，格式：{"title":"${keyword}","content":"描述文字","metadata":{"distance_km":估算距离,"distance_text":"距离描述","price":"费用","tags":["标签"]}}。只输出JSON。`,
  };

  const prompt = typePrompts[category] || typePrompts.scenic;

  const llmRes = await fetch('https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${process.env.DASHSCOPE_API_KEY || ''}` },
    body: JSON.stringify({ model: 'qwen-turbo', messages: [{ role: 'user', content: prompt }], temperature: 0.5, max_tokens: 300 }),
  });
  const data = await llmRes.json() as any;

  let item;
  try {
    const text = data.choices[0].message.content.replace(/```json\n?|```/g, '').trim();
    item = JSON.parse(text);
  } catch { return c.json({ success: false, error: 'AI 生成失败' }, 500); }

  // 保存到 pms_bui_settings
  const id = `guide_${scope.storeId}_${category}_ai_${Date.now()}`;
  await db.insert(pmsBuiSettings).values({
    id, merchantId: scope.merchantId, storeId: scope.storeId,
    category: 'kb_guide', key: `guide_${category}_ai_${Date.now()}`,
    value: {
      guide_type: category,
      title: item.title || keyword,
      content: item.content || '',
      metadata: item.metadata || {},
      status: 'draft',
      ai_generated: true,
      version: 1,
      generated_at: new Date().toISOString(),
    },
  } as any).onConflictDoNothing();

  return c.json({ success: true, message: `已添加${keyword}` });
});

export default route;
