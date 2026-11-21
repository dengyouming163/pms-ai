-- 素材工具管理权限：为已存在的管理角色补 assets:manage
UPDATE pms_bui_roles
  SET permissions = permissions || '["assets:manage"]'::jsonb
  WHERE name IN ('超级管理员', '酒店经理')
    AND NOT (permissions @> '["assets:manage"]'::jsonb);
