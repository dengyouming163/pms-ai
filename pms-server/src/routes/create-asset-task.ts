// src/routes/create-asset-task.ts
import { sql } from 'drizzle-orm';
import { db } from '../db/index.js';
import { assetTasks } from '../db/schema/index.js';
import type { getTenantScope } from '../utils/tenant.js';

type TenantScope = ReturnType<typeof getTenantScope>;

/** 创建打卡任务（手动发布与自动化 scheduler 共用） */
export async function createAssetTask(
  scope: TenantScope,
  body: any,
  publisherId: string | null,
  publisherName: string | null,
): Promise<string> {
  const id = `task_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`;
  await db.insert(assetTasks).values({
    id, merchantId: scope.merchantId,
    storeId: scope.storeId === '*' ? 'default_store' : scope.storeId,
    title: body.title, taskDate: body.taskDate || null,
    deadline: body.deadline ? new Date(body.deadline) : null, // drizzle timestamp 需 Date，前端传 ISO 字符串需转换
    templateRefs: body.templateRefs || [], roomIds: body.roomIds || [],
    roomNames: body.roomNames || [], roomTypeIds: body.roomTypeIds || [],
    roomTypeNames: body.roomTypeNames || [], shotRequirements: body.shotRequirements || [],
    purposeTags: body.purposeTags || [], guideText: body.guideText || '',
    assigneeScope: body.assigneeScope || 'all', assigneeStaffIds: body.assigneeStaffIds || [],
    status: 'published',
    publisherId, publisherName,
    ruleId: body.ruleId || null,
  } as any)
  // 幂等兜底：并发/多实例下同规则同日重复产单时静默跳过（依赖部分唯一索引 idx_asset_tasks_rule_date）
  .onConflictDoNothing({
    target: [assetTasks.taskDate, assetTasks.ruleId],
    where: sql`${assetTasks.ruleId} IS NOT NULL`,
  });
  return id;
}
