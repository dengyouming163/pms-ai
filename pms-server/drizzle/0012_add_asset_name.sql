-- 素材表补充 name 列：存储前端上传的素材名（避免 GET 时用 url 尾段随机生成文件名）
ALTER TABLE media_assets ADD COLUMN IF NOT EXISTS name varchar(200);
