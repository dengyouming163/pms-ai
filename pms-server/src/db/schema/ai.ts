import { pgTable, varchar, text, jsonb, decimal, smallint, boolean, timestamp, bigint, integer, real } from 'drizzle-orm/pg-core';

// 向后兼容：旧版 AI 定价建议表（pricing.ts / data-center.ts 引用）
export const pmsBuiAiSuggestions = pgTable('pms_bui_ai_suggestions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }),
  storeId: varchar('store_id', { length: 64 }),
  type: varchar('type', { length: 32 }),
  roomType: varchar('room_type', { length: 64 }),
  currentPrice: real('current_price'),
  suggestedPrice: real('suggested_price'),
  reason: text('reason'),
  confidence: varchar('confidence', { length: 8 }),
  competitorAvg: real('competitor_avg'),
  status: varchar('status', { length: 16 }).default('pending'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const pmsBuiAiInsights = pgTable('pms_bui_ai_insights', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  storeId: varchar('store_id', { length: 64 }),
  agent: varchar('agent', { length: 32 }),
  type: varchar('type', { length: 32 }),
  title: varchar('title', { length: 256 }),
  content: text('content'),
  actionLevel: varchar('action_level', { length: 2 }),
  actionPayload: jsonb('action_payload'),
  confidence: decimal('confidence', { precision: 3, scale: 2 }),
  evidence: jsonb('evidence'),
  status: varchar('status', { length: 16 }).default('active'),
  feedback: varchar('feedback', { length: 8 }),
  priority: smallint('priority').default(3),
  expiresAt: timestamp('expires_at'),
  createdAt: timestamp('created_at').defaultNow(),
  appliedAt: timestamp('applied_at'),
});

export const pmsBuiAiChatHistory = pgTable('pms_bui_ai_chat_history', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  storeId: varchar('store_id', { length: 64 }),
  userId: varchar('user_id', { length: 64 }),
  sessionId: varchar('session_id', { length: 64 }),
  role: varchar('role', { length: 16 }),
  content: text('content'),
  agentsInvolved: jsonb('agents_involved'),
  insightsGenerated: jsonb('insights_generated'),
  tokenUsage: jsonb('token_usage'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const pmsBuiAiActions = pgTable('pms_bui_ai_actions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  insightId: varchar('insight_id', { length: 64 }),
  title: varchar('title', { length: 256 }),
  description: text('description'),
  toolName: varchar('tool_name', { length: 64 }),
  toolParams: jsonb('tool_params'),
  actionLevel: varchar('action_level', { length: 2 }),
  status: varchar('status', { length: 16 }).default('pending'),
  confirmedBy: varchar('confirmed_by', { length: 64 }),
  confirmedAt: timestamp('confirmed_at'),
  decisionChain: jsonb('decision_chain'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const pmsBuiAiMemory = pgTable('pms_bui_ai_memory', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  userId: varchar('user_id', { length: 64 }),
  memoryType: varchar('memory_type', { length: 16 }),
  key: varchar('key', { length: 256 }),
  value: jsonb('value'),
  importance: decimal('importance', { precision: 3, scale: 2 }).default('0.50'),
  accessCount: integer('access_count').default(0),
  lastAccessedAt: timestamp('last_accessed_at'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const pmsBuiAiMetrics = pgTable('pms_bui_ai_metrics', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  agent: varchar('agent', { length: 32 }),
  crew: varchar('crew', { length: 64 }),
  operation: varchar('operation', { length: 32 }),
  latencyMs: integer('latency_ms'),
  tokensPrompt: integer('tokens_prompt'),
  tokensCompletion: integer('tokens_completion'),
  model: varchar('model', { length: 64 }),
  toolsCalled: integer('tools_called').default(0),
  toolsFailed: integer('tools_failed').default(0),
  insightGenerated: boolean('insight_generated'),
  insightAdopted: boolean('insight_adopted'),
  error: text('error'),
  createdAt: timestamp('created_at').defaultNow(),
});

export const pmsBuiAiUsage = pgTable('pms_bui_ai_usage', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  period: varchar('period', { length: 7 }),
  chatCount: integer('chat_count').default(0),
  insightCount: integer('insight_count').default(0),
  insightAdoptedCount: integer('insight_adopted_count').default(0),
  actionCount: integer('action_count').default(0),
  tokensUsed: bigint('tokens_used', { mode: 'number' }).default(0),
  estimatedCost: decimal('estimated_cost', { precision: 10, scale: 4 }),
  suggestionsSavings: decimal('suggestions_savings', { precision: 10, scale: 2 }),
  updatedAt: timestamp('updated_at').defaultNow(),
});

// 模式配置表
export const pmsBuiTenantModeConfig = pgTable('pms_bui_tenant_mode_config', {
  merchantId: varchar('merchant_id', { length: 64 }).primaryKey(),
  systemMode: varchar('system_mode', { length: 16 }).default('saas'),
  aiTrialUntil: timestamp('ai_trial_until'),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const pmsBuiStoreModeConfig = pgTable('pms_bui_store_mode_config', {
  storeId: varchar('store_id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  systemMode: varchar('system_mode', { length: 16 }).default('inherit'),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const pmsBuiModuleModeConfig = pgTable('pms_bui_module_mode_config', {
  id: varchar('id', { length: 64 }).primaryKey(),
  storeId: varchar('store_id', { length: 64 }).notNull(),
  module: varchar('module', { length: 32 }).notNull(),
  mode: varchar('mode', { length: 16 }).default('inherit'),
  updatedAt: timestamp('updated_at').defaultNow(),
});

export const pmsBuiUserAiPrefs = pgTable('pms_bui_user_ai_prefs', {
  userId: varchar('user_id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull(),
  preferredMode: varchar('preferred_mode', { length: 16 }).default('inherit'),
  chatEnabled: boolean('chat_enabled').default(true),
  insightEnabled: boolean('insight_enabled').default(true),
  autoActions: boolean('auto_actions').default(false),
  updatedAt: timestamp('updated_at').defaultNow(),
});
