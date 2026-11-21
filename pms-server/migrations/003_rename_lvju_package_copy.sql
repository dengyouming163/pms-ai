-- =============================================================================
-- 微信小程序审核整改：套餐文案「旅居」→「住宿」
-- 目标表：public.pms_platform_products（商品主表，platform 库 public schema）
--   name         ：套餐名称（顶层列）
--   extra_attrs  ：jsonb，套餐描述存于 extra_attrs->>'description'
-- 说明：仅替换含「旅居」的文案，不影响 product_type 枚举值（'travel' 机器值不变，
--       仅后台展示标签已在 pms-platform-web 改为「住宿套餐」）。
-- 用法：先执行「预览」SELECT 确认影响范围，再执行对应 UPDATE。
-- =============================================================================

-- 0. 预览：套餐名称含「旅居」的记录
SELECT id, name
FROM public.pms_platform_products
WHERE name LIKE '%旅居%';

-- 0. 预览：套餐描述（extra_attrs.description）含「旅居」的记录
SELECT id, name, extra_attrs->>'description' AS description
FROM public.pms_platform_products
WHERE extra_attrs->>'description' LIKE '%旅居%';

-- 1. 更新套餐名称
UPDATE public.pms_platform_products
SET name = replace(name, '旅居', '住宿')
WHERE name LIKE '%旅居%';

-- 2. 更新套餐描述（仅 description 字段，保留其它 extra_attrs 键）
UPDATE public.pms_platform_products
SET extra_attrs = jsonb_set(
  extra_attrs,
  '{description}',
  to_jsonb(replace(COALESCE(extra_attrs->>'description', ''), '旅居', '住宿')),
  true
)
WHERE extra_attrs->>'description' LIKE '%旅居%';

-- 3.（可选）价格季标签若含「旅居」也一并替换
UPDATE public.pms_platform_product_pricing
SET season_label = replace(season_label, '旅居', '住宿')
WHERE season_label LIKE '%旅居%';
