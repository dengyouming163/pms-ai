import { pgTable, varchar, text, timestamp, jsonb, integer, numeric, boolean } from 'drizzle-orm/pg-core';

// ========== 声音中台 — 音色管理 ==========
export const pmsBuiVoiceProfiles = pgTable('pms_bui_voice_profiles', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull().default('*'),
  name: varchar('name', { length: 50 }).notNull(),
  aliyunVoiceId: varchar('aliyun_voice_id', { length: 128 }),
  status: varchar('status', { length: 20 }).notNull().default('ready'),
  sampleUrl: text('sample_url'),
  sampleDuration: integer('sample_duration'),
  language: varchar('language', { length: 10 }).default('zh'),
  isDefault: boolean('is_default').default(false),
  description: varchar('description', { length: 200 }),
  source: varchar('source', { length: 20 }).default('bailian'),  // 'bailian' | 'ims'
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== 视频合成任务记录 ==========
export const pmsBuiVideoTasks = pgTable('pms_bui_video_tasks', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  type: varchar('type', { length: 20 }).notNull(),
  status: varchar('status', { length: 20 }).notNull().default('pending'),
  inputParams: jsonb('input_params'),
  outputUrl: text('output_url'),
  aliyunTaskId: varchar('aliyun_task_id', { length: 128 }),
  errorMessage: text('error_message'),
  pipeline: jsonb('pipeline'),  // 数字人口播异步管线状态跟踪
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== 内容周历 ==========
export const pmsBuiContentCalendar = pgTable('pms_bui_content_calendar', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  date: varchar('date', { length: 20 }).notNull(),
  topic: varchar('topic', { length: 200 }),
  titleSuggestion: text('title_suggestion'),
  weather: jsonb('weather'),
  events: jsonb('events'),
  occupancyHint: varchar('occupancy_hint', { length: 50 }),
  status: varchar('status', { length: 20 }).notNull().default('suggested'),
  noteId: varchar('note_id', { length: 64 }),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== 小红书草稿箱 ==========
export const pmsBuiXhsDrafts = pgTable('pms_bui_xhs_drafts', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  title: varchar('title', { length: 200 }),
  content: text('content'),
  tags: jsonb('tags'),
  images: jsonb('images'),
  calendarId: varchar('calendar_id', { length: 64 }),
  status: varchar('status', { length: 20 }).notNull().default('draft'),
  publishUrl: text('publish_url'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== 小红书已发布笔记 ==========
export const pmsBuiXhsPosts = pgTable('pms_bui_xhs_posts', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  draftId: varchar('draft_id', { length: 64 }),
  publishUrl: text('publish_url'),
  views: integer('views').default(0),
  likes: integer('likes').default(0),
  collects: integer('collects').default(0),
  comments: integer('comments').default(0),
  conversions: integer('conversions').default(0),
  orders: integer('orders').default(0),
  publishedAt: timestamp('published_at'),
  statsUpdatedAt: timestamp('stats_updated_at'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ========== 竞品配置 ==========
export const pmsBuiCompetitorConfig = pgTable('pms_bui_competitor_config', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }),
  hotelName: varchar('hotel_name', { length: 100 }).notNull(),
  platform: varchar('platform', { length: 30 }).notNull(),
  platformHotelId: varchar('platform_hotel_id', { length: 100 }),
  platformUrl: text('platform_url'),
  ourRoomTypeId: varchar('our_room_type_id', { length: 64 }),
  competitorRoomType: varchar('competitor_room_type', { length: 100 }),
  lastPrice: integer('last_price'),
  lastCrawledAt: timestamp('last_crawled_at'),
  status: varchar('status', { length: 20 }).notNull().default('active'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== AI定价持久化记录 ==========
export const pmsBuiAiPricingRecords = pgTable('pms_bui_ai_pricing_records', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull(),
  date: varchar('date', { length: 20 }).notNull(),
  roomType: varchar('room_type', { length: 100 }).notNull(),
  channel: varchar('channel', { length: 50 }).notNull(),
  basePrice: integer('base_price').notNull(),
  suggestedPrice: integer('suggested_price').notNull(),
  totalAdjust: numeric('total_adjust', { precision: 5, scale: 1 }),
  confidence: integer('confidence'),
  factors: jsonb('factors').notNull().default([]),
  expectedRevenue: integer('expected_revenue'),
  monthlyImpact: integer('monthly_impact'),
  generatedAt: timestamp('generated_at').defaultNow(),
  adopted: boolean('adopted').default(false),
});

// ========== 竞品价格快照 ==========
export const pmsBuiCompetitorSnapshots = pgTable('pms_bui_competitor_snapshots', {
  id: varchar('id', { length: 64 }).primaryKey(),
  competitorId: varchar('competitor_id', { length: 64 }).notNull(),
  price: integer('price').notNull(),
  crawledAt: timestamp('crawled_at').defaultNow().notNull(),
  source: varchar('source', { length: 20 }).default('crawler'),
});

// ========== 创作记录 ==========
export const pmsBuiCreationRecords = pgTable('pms_bui_creation_records', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull().default('default_store'),
  type: varchar('type', { length: 20 }).notNull().default('copy'),
  title: varchar('title', { length: 200 }),
  script: text('script'),
  tags: varchar('tags', { length: 500 }),
  titles: jsonb('titles'),
  audioUrl: text('audio_url'),
  taskId: varchar('task_id', { length: 128 }),
  taskStatus: varchar('task_status', { length: 20 }).default('completed'),
  duration: integer('duration'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== 热点话题 ==========
export const pmsBuiHotTopics = pgTable('pms_bui_hot_topics', {
  id: varchar('id', { length: 64 }).primaryKey(),
  date: varchar('date', { length: 10 }).notNull(),
  scene: varchar('scene', { length: 30 }).default('short_video'),
  label: varchar('label', { length: 20 }).notNull(),
  icon: varchar('icon', { length: 5 }).notNull(),
  prompt: text('prompt').notNull(),
  style: varchar('style', { length: 20 }).notNull(),
  source: varchar('source', { length: 50 }),
  sortOrder: integer('sort_order').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
});

// ========== 创作会话 ==========
export const pmsBuiCreationSessions = pgTable('pms_bui_creation_sessions', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull().default('default_store'),
  title: varchar('title', { length: 100 }),
  scene: varchar('scene', { length: 30 }).default('short_video'),
  style: varchar('style', { length: 20 }).default('story'),
  duration: integer('duration').default(30),
  platform: varchar('platform', { length: 20 }).default('抖音'),
  messageCount: integer('message_count').default(0),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== 批量一键成片任务 ==========
export const pmsBuiBatchJobs = pgTable('pms_bui_batch_jobs', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).default('default_store'),
  title: varchar('title', { length: 200 }),
  voiceId: varchar('voice_id', { length: 128 }),
  script: text('script'),
  tags: jsonb('tags'),
  bgm: varchar('bgm', { length: 200 }),
  groupMedia: jsonb('group_media'),
  aliyunJobId: varchar('aliyun_job_id', { length: 128 }),
  outputUrls: jsonb('output_urls'),
  status: varchar('status', { length: 20 }).default('processing'),
  errorMessage: text('error_message'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== IMS 公共模板库 ==========
export const pmsBuiImsTemplates = pgTable('pms_bui_ims_templates', {
  id: varchar('id', { length: 64 }).primaryKey(),
  name: varchar('name', { length: 200 }).notNull(),
  mediaCount: integer('media_count').default(0),
  textCount: integer('text_count').default(0),
  tags: text('tags'),  // JSON 数组字符串
  clipsParam: text('clips_param'),  // 模板原始 ClipsParam JSON
  previewUrl: text('preview_url'),
  orientation: varchar('orientation', { length: 20 }).default('portrait'),
  status: varchar('status', { length: 20 }).default('active'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});

// ========== IMS 人声克隆任务持久化 ==========
export const pmsBuiVoiceCloneTasks = pgTable('pms_bui_voice_clone_tasks', {
  id: varchar('id', { length: 64 }).primaryKey(),
  merchantId: varchar('merchant_id', { length: 64 }).notNull().default('default'),
  storeId: varchar('store_id', { length: 50 }).notNull().default('*'),
  voiceId: varchar('voice_id', { length: 64 }).notNull().unique(),
  voiceName: varchar('voice_name', { length: 64 }),
  gender: varchar('gender', { length: 10 }),
  scenario: varchar('scenario', { length: 20 }),
  jobId: varchar('job_id', { length: 128 }),          // CreateCustomizedVoiceJob 返回
  trainingJobId: varchar('training_job_id', { length: 128 }), // SubmitCustomizedVoiceJob 返回
  currentStep: integer('current_step').default(1),
  status: varchar('status', { length: 30 }),
  demos: jsonb('demos'),
  recordings: jsonb('recordings'),
  detectResults: jsonb('detect_results'),
  createdAt: timestamp('created_at').defaultNow().notNull(),
  updatedAt: timestamp('updated_at').defaultNow().notNull(),
});
