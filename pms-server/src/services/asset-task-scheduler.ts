// src/services/asset-task-scheduler.ts
import { eq, and, lte, inArray } from 'drizzle-orm';
import { db } from '../db/index.js';
import { assetTaskRules, assetTasks, assetTemplates } from '../db/schema/index.js';
import { calcNextRunAt, buildTaskFromRule, BJ_OFFSET_MS } from '../utils/rule-schedule.js';
import { buildShotRequirements } from '../utils/task-completion.js';
import { createAssetTask } from '../routes/create-asset-task.js';

const CHECK_INTERVAL_MS = 60_000;

/** 北京日期 YYYY-MM-DD（instant 平移 +8h 后用 UTC 字段读北京墙钟，与进程时区无关） */
function localDateStr(d: Date): string {
  const bj = new Date(d.getTime() + BJ_OFFSET_MS);
  const y = bj.getUTCFullYear();
  const m = String(bj.getUTCMonth() + 1).padStart(2, '0');
  const day = String(bj.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/** 为一条到期规则创建当日任务（幂等：当天已建则跳过） */
export async function runRuleOnce(rule: any, now = new Date()): Promise<boolean> {
  const taskDate = localDateStr(now);
  // 幂等：该规则当天是否已建任务（按 taskDate + ruleId 查重，避免多规则商户互相吞任务）
  const [existing] = await db.select({ id: assetTasks.id }).from(assetTasks)
    .where(and(eq(assetTasks.taskDate, taskDate), eq(assetTasks.ruleId, rule.id)))
    .limit(1);
  if (existing) {
    // 当天已建过该规则任务 → 推进下次执行，避免空转
    await db.update(assetTaskRules).set({
      lastRunAt: now, nextRunAt: calcNextRunAt(rule.publishTime, now), updatedAt: now,
    }).where(eq(assetTaskRules.id, rule.id));
    return false;
  }

  // 构建 shotRequirements（从模板）
  const templateRows = rule.templateRefs?.length
    ? await db.select().from(assetTemplates).where(inArray(assetTemplates.id, rule.templateRefs))
    : [];
  const shotRequirements = buildShotRequirements(rule.templateRefs || [], templateRows.map(t => ({
    id: t.id, shotType: t.shotType, name: t.name,
    mediaType: (t.mediaType as 'image' | 'video') || 'image',
    exampleImageUrl: t.exampleImageUrl ?? undefined,
    exampleVideoUrl: t.exampleVideoUrl ?? undefined,
    guideText: t.guideText ?? undefined,
    movementText: t.movementText ?? undefined,
    avoidText: t.avoidText ?? undefined,
    durationMin: t.durationMin ?? undefined,
    durationMax: t.durationMax ?? undefined,
  })), {});

  const scope = { merchantId: rule.merchantId, storeId: rule.storeId === 'default_store' ? '*' : rule.storeId };
  await createAssetTask(scope as any, {
    ...buildTaskFromRule(rule, taskDate),
    shotRequirements,
    ruleId: rule.id,
  }, rule.publisherId || null, rule.publisherName || null);

  // 推进下次执行时间（保留 publishTime 语义）
  await db.update(assetTaskRules).set({
    lastRunAt: now, nextRunAt: calcNextRunAt(rule.publishTime, now), updatedAt: now,
  }).where(eq(assetTaskRules.id, rule.id));
  return true;
}

/** 启动自动化任务调度（server.ts 调用一次） */
export function startAssetTaskScheduler(): void {
  let running = false; // 重入守卫：上一次调度未跑完时跳过本次 tick，避免并发重复产单
  setInterval(async () => {
    if (running) return;
    running = true;
    try {
      const now = new Date();
      const dueRules = await db.select().from(assetTaskRules)
        .where(and(eq(assetTaskRules.status, 'enabled'), lte(assetTaskRules.nextRunAt, now)));
      for (const rule of dueRules) {
        try { await runRuleOnce(rule, now); } catch (e) { console.error('[asset-scheduler] 规则执行失败:', rule.id, e); }
      }
    } catch (err) {
      console.error('[asset-scheduler] 扫描失败:', err);
    } finally { running = false; }
  }, CHECK_INTERVAL_MS);
  console.log('[asset-scheduler] 已启动（每 60s 检查自动化任务规则）');
}
