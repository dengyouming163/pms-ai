-- 离店满意度回访表 M2 迁移：加 store_id + comment（口碑数据基础，生产环境手动执行）
-- store_id：口碑按店聚合，submit 时从订单回填；comment：可选文字评价（≤500 字）
ALTER TABLE pms_bui_satisfaction_surveys ADD COLUMN IF NOT EXISTS store_id varchar(50);
ALTER TABLE pms_bui_satisfaction_surveys ADD COLUMN IF NOT EXISTS comment varchar(500);
