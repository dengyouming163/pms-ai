// scripts/migrate-assets.ts
// 运行：tsx --env-file=.env scripts/migrate-assets.ts
// 将 pms_bui_settings(category='assets') 存量 JSON 素材迁移到 media_assets，保留原数据
import { db } from '../src/db/index.js';
import { pmsBuiSettings, mediaAssets } from '../src/db/schema/index.js';
import { eq } from 'drizzle-orm';

async function main() {
  const rows = await db.select().from(pmsBuiSettings).where(eq(pmsBuiSettings.category, 'assets'));
  console.log(`发现 ${rows.length} 条存量素材`);
  let migrated = 0;
  for (const r of rows) {
    const v = (r.value as any) || {};
    if (!v.url) continue;
    // 幂等：已迁移过则跳过
    const [existing] = await db.select({ id: mediaAssets.id }).from(mediaAssets)
      .where(eq(mediaAssets.id, r.id)).limit(1);
    if (existing) continue;
    await db.insert(mediaAssets).values({
      id: r.id, merchantId: r.merchantId, storeId: r.storeId || 'default_store',
      url: v.url, mediaType: 'image',
      category: v.assetCategory || 'other',
      purposeTags: v.tags || [], shotType: null,
      value: v.value || null, // 保留旧 AI 笔记 blob（video/xhs 历史）若存在
      uploaderStaffName: v.name || null,
      createdAt: r.updatedAt,
    } as any);
    migrated++;
  }
  console.log(`迁移完成：${migrated}/${rows.length}`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
