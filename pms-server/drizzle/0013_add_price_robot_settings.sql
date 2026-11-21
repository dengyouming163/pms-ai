-- 收益管家 store 级设置：自动确认 + 全局最低卖价（门店行 room_type_id='*'）
--> statement-breakpoint
ALTER TABLE pms_price_robot_config
  ADD COLUMN IF NOT EXISTS auto_confirm boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS global_floor integer;
