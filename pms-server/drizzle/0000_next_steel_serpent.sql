CREATE TABLE "pms_bui_brands" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" varchar(20) DEFAULT 'platform' NOT NULL,
	"logo" text,
	"color" varchar(20),
	"description" text,
	"store_count" integer DEFAULT 0 NOT NULL,
	"total_rooms" integer DEFAULT 0 NOT NULL,
	"contact_name" varchar(50),
	"contact_phone" varchar(20),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"facilities" jsonb DEFAULT '[]'::jsonb,
	"standards" jsonb,
	"sops" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_stores" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"brand_id" varchar(50) NOT NULL,
	"brand_name" varchar(100) NOT NULL,
	"name" varchar(100) NOT NULL,
	"address" text,
	"phone" varchar(20),
	"room_count" integer DEFAULT 0 NOT NULL,
	"manager" varchar(50),
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"facilities" jsonb DEFAULT '[]'::jsonb,
	"today_occupancy" integer DEFAULT 0,
	"today_revenue" integer DEFAULT 0,
	"month_revenue" integer DEFAULT 0,
	"latitude" varchar(30),
	"longitude" varchar(30),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_room_devices" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"store_id" varchar(50) NOT NULL,
	"room_number" varchar(20) NOT NULL,
	"device_name" varchar(100) NOT NULL,
	"device_type" varchar(50) NOT NULL,
	"status" varchar(20) DEFAULT 'normal' NOT NULL,
	"last_check_date" varchar(20),
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_room_types" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"store_id" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"bed_type" varchar(50) NOT NULL,
	"area" varchar(20),
	"max_guests" integer DEFAULT 2 NOT NULL,
	"facilities" jsonb DEFAULT '[]'::jsonb,
	"room_count" integer DEFAULT 0 NOT NULL,
	"base_price" integer NOT NULL,
	"weekday_price" integer,
	"weekend_price" integer,
	"holiday_price" integer,
	"min_price" integer,
	"description" text,
	"images" jsonb DEFAULT '[]'::jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_rooms" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"store_id" varchar(50) NOT NULL,
	"room_type_id" varchar(50) NOT NULL,
	"room_type_name" varchar(100) NOT NULL,
	"room_number" varchar(20) NOT NULL,
	"floor" integer DEFAULT 1 NOT NULL,
	"status" varchar(20) DEFAULT 'available' NOT NULL,
	"price" integer,
	"guest_name" varchar(50),
	"guest_phone" varchar(20),
	"check_in_date" varchar(20),
	"check_out_date" varchar(20),
	"booking_id" varchar(50),
	"lock_reason" text,
	"dirty_type" varchar(20),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_channel_orders" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"order_no" varchar(50) NOT NULL,
	"channel" varchar(50) NOT NULL,
	"channel_color" varchar(20),
	"icon" varchar(20),
	"channel_order_id" varchar(50),
	"guest_name" varchar(50) NOT NULL,
	"guest_phone" varchar(20),
	"check_in" varchar(20) NOT NULL,
	"check_out" varchar(20) NOT NULL,
	"room_type" varchar(100),
	"room_type_id" varchar(50),
	"room_number" varchar(20),
	"nights" integer DEFAULT 1 NOT NULL,
	"total_price" integer NOT NULL,
	"status" varchar(30) DEFAULT 'pending_confirm' NOT NULL,
	"payment_status" varchar(20) DEFAULT 'unpaid',
	"source" varchar(30) DEFAULT 'channel',
	"remark" text,
	"ota_timeout" varchar(30),
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pms_bui_channel_orders_order_no_unique" UNIQUE("order_no")
);
--> statement-breakpoint
CREATE TABLE "pms_bui_orders" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"order_no" varchar(50) NOT NULL,
	"channel" varchar(50) NOT NULL,
	"channel_color" varchar(20),
	"icon" varchar(20),
	"channel_order_id" varchar(50),
	"guest_name" varchar(50) NOT NULL,
	"guest_phone" varchar(20),
	"check_in" varchar(20) NOT NULL,
	"check_out" varchar(20) NOT NULL,
	"room_type" varchar(100),
	"room_type_id" varchar(50),
	"room_number" varchar(20),
	"nights" integer DEFAULT 1 NOT NULL,
	"total_price" integer NOT NULL,
	"status" varchar(30) DEFAULT 'pending_confirm' NOT NULL,
	"payment_status" varchar(20) DEFAULT 'unpaid',
	"source" varchar(30) DEFAULT 'channel',
	"remark" text,
	"confirmed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"cancel_reason" text,
	"store_id" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "pms_bui_orders_order_no_unique" UNIQUE("order_no")
);
--> statement-breakpoint
CREATE TABLE "pms_bui_pricing_calendar" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"store_id" varchar(50) NOT NULL,
	"date" varchar(20) NOT NULL,
	"room_types" jsonb NOT NULL,
	"is_weekend" boolean DEFAULT false NOT NULL,
	"is_holiday" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_pricing_rules" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"store_id" varchar(50) NOT NULL,
	"room_type_id" varchar(50) NOT NULL,
	"room_type" varchar(100) NOT NULL,
	"base_price" integer NOT NULL,
	"weekday_price" integer NOT NULL,
	"weekend_price" integer NOT NULL,
	"holiday_price" integer,
	"min_price" integer,
	"price_history" jsonb DEFAULT '[]'::jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_promotions" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"store_id" varchar(50) NOT NULL,
	"name" varchar(100) NOT NULL,
	"type" varchar(30) NOT NULL,
	"discount" integer NOT NULL,
	"start_date" varchar(20) NOT NULL,
	"end_date" varchar(20) NOT NULL,
	"room_types" jsonb DEFAULT '[]'::jsonb,
	"channels" jsonb DEFAULT '[]'::jsonb,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_channels" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"icon" varchar(20),
	"color" varchar(20),
	"type" varchar(30) DEFAULT 'ota' NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"today_orders" integer DEFAULT 0 NOT NULL,
	"today_revenue" integer DEFAULT 0 NOT NULL,
	"month_orders" integer DEFAULT 0 NOT NULL,
	"month_revenue" integer DEFAULT 0 NOT NULL,
	"account" varchar(100),
	"balance" integer DEFAULT 0 NOT NULL,
	"commission_rate" numeric(5, 2) DEFAULT '10.00',
	"features" jsonb DEFAULT '[]'::jsonb,
	"description" text,
	"connected_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_reviews" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"channel_id" varchar(50) NOT NULL,
	"channel_name" varchar(100) NOT NULL,
	"channel_icon" varchar(20),
	"guest_name" varchar(50) NOT NULL,
	"rating" integer NOT NULL,
	"content" text,
	"reply_content" text,
	"reply_status" varchar(20) DEFAULT 'pending' NOT NULL,
	"review_time" varchar(30) NOT NULL,
	"store_id" varchar(50),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_reconciliation_alerts" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"type" varchar(30) NOT NULL,
	"channel" varchar(50) NOT NULL,
	"title" varchar(200) NOT NULL,
	"description" text,
	"count" integer DEFAULT 0 NOT NULL,
	"amount" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_reconciliation_details" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"channel_name" varchar(100) NOT NULL,
	"order_no" varchar(50) NOT NULL,
	"guest_name" varchar(50) NOT NULL,
	"system_amount" integer NOT NULL,
	"channel_amount" integer NOT NULL,
	"difference" integer DEFAULT 0 NOT NULL,
	"status" varchar(20) DEFAULT 'matched' NOT NULL,
	"order_date" varchar(20) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_transactions" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"type" varchar(20) NOT NULL,
	"category" varchar(50) NOT NULL,
	"amount" integer NOT NULL,
	"channel" varchar(50),
	"order_no" varchar(50),
	"guest_name" varchar(50),
	"store_name" varchar(100),
	"payment_method" varchar(30) NOT NULL,
	"status" varchar(20) DEFAULT 'completed' NOT NULL,
	"remark" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_auto_tag_rules" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(100) NOT NULL,
	"rule" varchar(50) NOT NULL,
	"field" varchar(50) NOT NULL,
	"tag" varchar(50) NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_care_reminders" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"customer_id" varchar(50) NOT NULL,
	"customer_name" varchar(50) NOT NULL,
	"type" varchar(30) NOT NULL,
	"content" text NOT NULL,
	"priority" varchar(10) DEFAULT 'medium' NOT NULL,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"due_date" varchar(20),
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_customers" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"gender" varchar(10),
	"birthday" varchar(20),
	"member_level" varchar(20) DEFAULT 'regular' NOT NULL,
	"member_level_name" varchar(30) DEFAULT '普通会员' NOT NULL,
	"member_level_icon" varchar(10),
	"member_level_discount" integer DEFAULT 100 NOT NULL,
	"value_score" integer DEFAULT 0 NOT NULL,
	"total_spent" integer DEFAULT 0 NOT NULL,
	"avg_spent" integer DEFAULT 0 NOT NULL,
	"stay_count" integer DEFAULT 0 NOT NULL,
	"last_stay_date" varchar(20),
	"source" varchar(30),
	"tags" jsonb DEFAULT '[]'::jsonb,
	"preferences" jsonb DEFAULT '[]'::jsonb,
	"remark" text,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_tags" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"color" varchar(20) NOT NULL,
	"description" text,
	"count" integer DEFAULT 0 NOT NULL,
	"is_auto" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_op_logs" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"staff_id" varchar(50) NOT NULL,
	"staff_name" varchar(50) NOT NULL,
	"module" varchar(50) NOT NULL,
	"module_label" varchar(50) NOT NULL,
	"action" varchar(100) NOT NULL,
	"target" varchar(100),
	"detail" text,
	"level" varchar(10) DEFAULT 'info' NOT NULL,
	"ip" varchar(50),
	"timestamp" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_roles" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"description" text,
	"staff_count" integer DEFAULT 0 NOT NULL,
	"scope" varchar(30) DEFAULT 'store' NOT NULL,
	"is_preset" boolean DEFAULT false NOT NULL,
	"permissions" jsonb DEFAULT '[]'::jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_staff" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"name" varchar(50) NOT NULL,
	"phone" varchar(20) NOT NULL,
	"email" varchar(100),
	"avatar" varchar(200),
	"department" varchar(50) NOT NULL,
	"position" varchar(50) NOT NULL,
	"role_name" varchar(50) NOT NULL,
	"role_id" varchar(50) NOT NULL,
	"stores" jsonb DEFAULT '[]'::jsonb,
	"scope" varchar(30) DEFAULT 'store',
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_settings" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"category" varchar(30) NOT NULL,
	"key" varchar(100) NOT NULL,
	"value" jsonb NOT NULL,
	"description" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_ai_chat_history" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"role" varchar(20) NOT NULL,
	"content" text NOT NULL,
	"session_type" varchar(30) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pms_bui_ai_suggestions" (
	"id" varchar(50) PRIMARY KEY NOT NULL,
	"room_type" varchar(50) NOT NULL,
	"current_price" integer NOT NULL,
	"suggested_price" integer NOT NULL,
	"reason" text NOT NULL,
	"confidence" numeric(3, 2) NOT NULL,
	"competitor_avg" integer,
	"status" varchar(20) DEFAULT 'pending' NOT NULL,
	"type" varchar(30) DEFAULT 'pricing' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
