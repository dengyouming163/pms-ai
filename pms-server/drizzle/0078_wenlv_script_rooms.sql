-- 0078: 剧本房中心模型四表（P3a 结构层）
CREATE TABLE IF NOT EXISTS pms_bui_wenlv_script_rooms (
  id varchar(50) PRIMARY KEY,
  name varchar(200) NOT NULL,
  cover_image varchar(500),
  intro text,
  content_id varchar(50) NOT NULL,
  venue_id varchar(50),
  mode varchar(20) NOT NULL DEFAULT 'standard',
  difficulty varchar(20) NOT NULL DEFAULT 'normal',
  pure_play boolean NOT NULL DEFAULT false,
  status varchar(20) NOT NULL DEFAULT 'draft',
  config jsonb NOT NULL DEFAULT '{}'::jsonb,
  published_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_script_rooms_content ON pms_bui_wenlv_script_rooms(content_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_script_rooms_venue ON pms_bui_wenlv_script_rooms(venue_id);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_chapters (
  id varchar(50) PRIMARY KEY,
  script_room_id varchar(50) NOT NULL,
  title varchar(200) NOT NULL,
  time_label varchar(20),
  goal text,
  "order" integer NOT NULL DEFAULT 0,
  status varchar(20) NOT NULL DEFAULT 'draft',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_chapters_room ON pms_bui_wenlv_chapters(script_room_id);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_scenes (
  id varchar(50) PRIMARY KEY,
  chapter_id varchar(50) NOT NULL,
  title varchar(200) NOT NULL,
  type varchar(20) NOT NULL DEFAULT 'narrative',
  content text,
  npc_id varchar(50),
  atoms jsonb NOT NULL DEFAULT '[]'::jsonb,
  puzzle jsonb,
  "order" integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_scenes_chapter ON pms_bui_wenlv_scenes(chapter_id);

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_flows (
  id varchar(50) PRIMARY KEY,
  from_scene_id varchar(50) NOT NULL,
  to_scene_id varchar(50) NOT NULL,
  type varchar(20) NOT NULL DEFAULT 'auto',
  choice_text text,
  condition text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_wenlv_flows_from ON pms_bui_wenlv_flows(from_scene_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_flows_to ON pms_bui_wenlv_flows(to_scene_id);
