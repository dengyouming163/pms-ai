-- 定价规则 id/房型 id 加宽：虚拟规则 id 形如 rule-default-rt-<36位uuid>（52字符），超出原 varchar(50)
ALTER TABLE pms_bui_pricing_rules ALTER COLUMN id TYPE varchar(64);
ALTER TABLE pms_bui_pricing_rules ALTER COLUMN room_type_id TYPE varchar(64);
