-- 素材表增加 value jsonb 列 — 兼容 pms-web AI 笔记（url='' + value blob，如视频/小红书脚本历史）
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS value jsonb;
