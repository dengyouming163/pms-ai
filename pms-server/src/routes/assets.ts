import { Hono } from 'hono';
import { db } from '../db/index.js';
import { mediaAssets, pmsBuiRoles } from '../db/schema/index.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import { ZipArchive } from 'archiver';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';
import { hasPermission } from '../utils/permissions.js';
import { requirePermission } from '../middleware/permission-guard.js';
import type { AuthUser } from '../middleware/auth.js';
import templatesRoute from './assets-templates.js';

const route = new Hono<{ Variables: { authUser?: AuthUser } }>();

// 挂载模板子路由 → /api/assets/templates
route.route('/templates', templatesRoute);

// GET /api/assets — 素材列表（?category=&room_id=&purpose=&quality=&scope=all&limit=&offset=）
route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const { category, room_id: roomId, purpose, quality, room_type_ids, unbound, scope: scopeAll, limit: limitRaw, offset: offsetRaw } = c.req.query();
  // 分页参数：limit 默认 200（移动端显式传 50 分页；pms-web 等未分页消费方默认取 200，兼顾可见范围），上限 200
  const limit = Math.min(Math.max(Number(limitRaw) || 200, 1), 200);
  const offset = Math.max(Number(offsetRaw) || 0, 0);
  // 素材库为商家级共享资源：scope=all 时忽略门店过滤（仅按商户隔离），
  // 避免门店切换/历史素材 storeId 与当前门店体系不一致导致素材不可见；asset-picker 等按门店场景不传该参数保持门店隔离
  const conditions: any[] = [eq(mediaAssets.merchantId, scope.merchantId), eq(mediaAssets.status, 'active')];
  if (scopeAll !== 'all' && scope.storeId && scope.storeId !== '*') conditions.push(eq(mediaAssets.storeId, scope.storeId));
  if (category) conditions.push(eq(mediaAssets.category, category));
  if (roomId) conditions.push(eq(mediaAssets.roomId, roomId));
  if (quality) conditions.push(eq(mediaAssets.quality, quality));
  // 用途筛选：SQL 条件过滤，保证 limit/offset 分页正确
  if (purpose) conditions.push(sql`${mediaAssets.purposeTags} ?| ARRAY[${purpose}]::text[]`);
  // 按房型筛选：命中任一房型即返回
  if (room_type_ids) {
    const ids = room_type_ids.split(',').filter(Boolean);
    if (ids.length > 0) conditions.push(sql`${mediaAssets.roomTypeIds} ?| ARRAY[${sql.join(ids, sql`, `)}]::text[]`);
  }
  // 未绑定筛选
  if (unbound === 'true') {
    conditions.push(sql`(
      ${mediaAssets.roomTypeIds} IS NULL
      OR ${mediaAssets.roomTypeIds} = '[]'::jsonb
      OR jsonb_array_length(${mediaAssets.roomTypeIds}) = 0
    )`);
  }
  const rows = await db.select().from(mediaAssets)
    .where(and(...conditions)).orderBy(desc(mediaAssets.createdAt)).limit(limit).offset(offset);
  // 过滤后总数（供前端判断是否还有更多）
  const [totalRow] = await db.select({ count: sql`count(*)::int` }).from(mediaAssets).where(and(...conditions));
  const total = totalRow?.count ?? 0;
  const assets = rows.map(r => ({
    ...r,
    // 优先返回落库的素材名，未落库时回退 url 尾段
    name: r.name || r.url.split('/').pop() || '',
    assetCategory: r.category,
    tags: (r.purposeTags as string[]) || [],
  }));
  return c.json({ assets, total });
});

// GET /api/assets/export — 打包下载素材（zip 流式返回，范围与列表页一致：支持 scope=all / category）
route.get('/export', async (c) => {
  const scope = getTenantScope(c);
  const { category, scope: scopeAll } = c.req.query();
  const conditions: any[] = [eq(mediaAssets.merchantId, scope.merchantId), eq(mediaAssets.status, 'active')];
  if (scopeAll !== 'all' && scope.storeId && scope.storeId !== '*') conditions.push(eq(mediaAssets.storeId, scope.storeId));
  if (category) conditions.push(eq(mediaAssets.category, category));
  const rows = await db.select().from(mediaAssets).where(and(...conditions)).limit(200);
  // 文件名去重 + 清洗非法字符（zip 不允许 \ / : * ? " < > |）
  const nameCount = new Map<string, number>();
  const uniqueName = (raw: string) => {
    const safe = raw.replace(/[\\/:*?"<>|]/g, '_').trim() || 'file';
    const count = nameCount.get(safe) || 0;
    nameCount.set(safe, count + 1);
    if (count === 0) return safe;
    const dot = safe.lastIndexOf('.');
    return dot > 0 ? `${safe.slice(0, dot)}_${count}${safe.slice(dot)}` : `${safe}_${count}`;
  };
  const zip = new ZipArchive({ zlib: { level: 9 } });
  zip.on('error', (e) => console.error('[assets/export] zip error:', e));
  // 并发下载为 Buffer 再入包：避免流式 append 时 AbortSignal 中断 body 流产生未处理 error（会导致进程崩溃）
  const entries: { buf: Buffer; name: string }[] = [];
  for (let i = 0; i < rows.length; i += 5) {
    const chunk = rows.slice(i, i + 5);
    const settled = await Promise.all(chunk.map(async (r): Promise<{ buf: Buffer; name: string } | null> => {
      try {
        const res = await fetch(r.url, { signal: AbortSignal.timeout(30_000) });
        if (!res.ok) return null;
        return { buf: Buffer.from(await res.arrayBuffer()) as Buffer, name: uniqueName(r.name || r.url.split('/').pop() || 'file') };
      } catch { /* 单文件下载失败跳过 */ return null; }
    }));
    for (const e of settled) if (e) entries.push(e);
  }
  for (const e of entries) zip.append(e.buf, { name: e.name });
  // 关键：finalize 前必须先消费 zip 的 readable 端。archiver 的 finalize() Promise
  // 依赖内部模块 emit 'end'，若流无人消费，管道背压会让模块写不完压缩数据而永远不结束。
  // 挂 'data' 监听器让流进入 flowing 模式收集输出，finalize 才能 resolve。
  const chunks: Buffer[] = [];
  zip.on('data', (c: Buffer) => chunks.push(c));
  await zip.finalize();
  const zipBuf = Buffer.concat(chunks);
  c.header('Content-Type', 'application/zip');
  c.header('Content-Disposition', 'attachment; filename="materials.zip"');
  return c.newResponse(zipBuf, 200);
});

// POST /api/assets — 创建素材记录（登录员工，自动记录上传人）
route.post('/', async (c) => {
  const scope = getTenantScope(c);
  const authUser = c.get('authUser');
  const body = await c.req.json() as any;
  // url 仅校验为字符串：pms-web AI 笔记（url='' + value blob）允许空串
  if (typeof body.url !== 'string') return c.json({ success: false, error: 'url 为必填' }, 400);
  const id = `asset_${Date.now()}`;
  await db.insert(mediaAssets).values({
    id, merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    url: body.url || '', name: body.name || null, thumbnailUrl: body.thumbnailUrl || null,
    mediaType: body.mediaType || 'image', category: body.category || body.assetCategory || 'other',
    roomId: body.roomId || null, roomName: body.roomName || null, roomTypeId: body.roomTypeId || null,
    roomTypeIds: body.roomTypeIds || (body.roomTypeId ? [body.roomTypeId] : []),
    roomTypeNames: body.roomTypeNames || [],
    purposeTags: body.purposeTags || body.tags || [], shotType: body.shotType || null,
    value: body.value || null,
    uploaderStaffId: authUser?.userId || null,
    uploaderStaffName: authUser?.name || null,
    taskId: body.taskId || null,
  } as any);
  return c.json({ success: true, id });
});

// PUT /api/assets/:id — 标记优质 / 软删除（店长，前端 request.ts 的 put 走 PUT 动词）
route.put('/:id', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  const body = await c.req.json() as any;
  const updates: any = {};
  if (body.quality !== undefined) updates.quality = body.quality;
  if (body.status !== undefined) updates.status = body.status;
  if (body.roomTypeIds !== undefined) updates.roomTypeIds = body.roomTypeIds;
  if (body.roomTypeNames !== undefined) updates.roomTypeNames = body.roomTypeNames;
  updates.updatedAt = new Date();
  await db.update(mediaAssets).set(updates)
    .where(and(eq(mediaAssets.id, id), ...tenantWhere(scope, mediaAssets)));
  return c.json({ success: true });
});

// DELETE /api/assets/:id — 软删除（保留统计完整性）
route.delete('/:id', requirePermission('assets:manage'), async (c) => {
  const scope = getTenantScope(c);
  const id = c.req.param('id') as string;
  await db.update(mediaAssets).set({ status: 'deleted', updatedAt: new Date() })
    .where(and(eq(mediaAssets.id, id), ...tenantWhere(scope, mediaAssets)));
  return c.json({ success: true });
});

// 兼容旧端：内部检查是否店长（供 tasks 路由复用）
// JWT 权限优先，空则回退查 DB 角色权限（与 requirePermission 一致，避免 JWT 未带 permissions 时全员误判为店长）
export async function isAssetsManager(c: any): Promise<boolean> {
  const authUser = c.get('authUser') as any;
  let perms: string[] = authUser?.permissions || [];
  if (perms.length === 0 && authUser?.roleId) {
    try {
      const [role] = await db.select({ permissions: pmsBuiRoles.permissions })
        .from(pmsBuiRoles).where(eq(pmsBuiRoles.id, authUser.roleId)).limit(1);
      perms = (role?.permissions as string[]) || [];
    } catch { /* DB 不可用时按 JWT 权限判定 */ }
  }
  return hasPermission(perms, 'assets:manage');
}

export default route;
