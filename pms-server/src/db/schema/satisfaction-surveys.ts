import { pgTable, varchar, integer, jsonb, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';

/**
 * 离店满意度回访记录表（C2 差评预检：消息回访）。
 *
 * 双重职责：
 *  1) 调度器幂等台账 —— satisfaction-scheduler 扫描到「离店 1h」的已核销订单后，先 INSERT 一行
 *     （score=NULL）作为「已投递回访问卷」的标记（order_id 唯一 + onConflictDoNothing 为闸门），
 *     避免每 60s 一轮 tick 对同一订单重复推送；
 *  2) 回访答卷 —— 客人经小程序 POST /api/mini/survey/:orderId/submit 回填 score + complaints。
 *
 * 差评（score < 3）补偿：不满意时系统发该门店补偿券（type='full_reduce'），券记录 id 回写 coupon_record_id，
 * 以「该字段为空」作为「是否已补偿」的守卫，保证每单至多补偿一次（不依赖券记录查重）。
 */
export const pmsBuiSatisfactionSurveys = pgTable('pms_bui_satisfaction_surveys', {
  id: varchar('id', { length: 50 }).primaryKey(),
  miniUserId: varchar('mini_user_id', { length: 50 }).notNull(),
  orderId: varchar('order_id', { length: 50 }).notNull(),
  // 满意度 1-5（NULL = 已投递问卷、待客人回填）
  score: integer('score'),
  // 不满点：床品/卫生/隔音/服务/其他
  complaints: jsonb('complaints').$type<string[]>().default([]),
  // 可选文字评价（口碑展示）
  comment: varchar('comment', { length: 500 }),
  // 门店 id（口碑按店聚合；submit 时从订单回填）
  storeId: varchar('store_id', { length: 50 }),
  // 补偿券记录 id（不满意时发）
  couponRecordId: varchar('coupon_record_id', { length: 50 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, (t) => [uniqueIndex('uq_survey_order').on(t.orderId)]);
