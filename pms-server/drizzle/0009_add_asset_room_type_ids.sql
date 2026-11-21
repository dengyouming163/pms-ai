-- 素材库绑定房型：新增多值房型绑定列
ALTER TABLE media_assets
  ADD COLUMN IF NOT EXISTS room_type_ids jsonb DEFAULT '[]'::jsonb,
  ADD COLUMN IF NOT EXISTS room_type_names jsonb DEFAULT '[]'::jsonb;

-- 回填旧单值 room_type_id → 数组（仅当数组为空时）
UPDATE media_assets
  SET room_type_ids = jsonb_build_array(room_type_id)
  WHERE room_type_id IS NOT NULL
    AND (room_type_ids IS NULL OR jsonb_array_length(room_type_ids) = 0);

-- 回填房型名称（join pms_bui_room_types 按 id 取 name）
UPDATE media_assets ma
  SET room_type_names = COALESCE((
    SELECT jsonb_agg(rt.name ORDER BY rt.name)
    FROM pms_bui_room_types rt
    WHERE rt.id = ANY(ARRAY(SELECT jsonb_array_elements_text(ma.room_type_ids)))
  ), '[]'::jsonb)
  WHERE jsonb_array_length(COALESCE(ma.room_type_ids, '[]'::jsonb)) > 0;
