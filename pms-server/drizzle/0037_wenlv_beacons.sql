-- 文旅信标设备台账（1 张新表）。
--
-- 为什么设备独立成表，而不是把广播参数挂到点位上：
-- 「设备」是第一类实体（有身份、有归属、有状态、可换绑、可报废），而点位是被动资源。
-- 把参数冗余到 points 上会多出一份**必然漂移**的真相 —— 换绑/改参数/报废都要同步改两处，
-- 漏一处就是静默失效。绑定关系的唯一真相是 beacons.point_id。
--
-- 为什么 mac 是设备身份而不是 uuid/major/minor：
-- ⚠️ iOS 侧小程序拿不到 MAC（deviceId 是每 App 随机 UUID）⇒ **触发不能依赖 MAC**，
-- 所以 MAC 只服务「资产台账」与「现场认设备」，触发凭据只能是广播帧。
-- 两者是不同的东西，不要合并。
--
-- 为什么 uuid/major/minor 可空：
-- 现场先扫 MAC 入账（设备还没拆封、还没读过参数）是真实顺序。可空 = 「还没读」，
-- 与「读到了空值」是两回事。与 printed_at / created_by 同处理哲学，不回填。
--
-- 为什么没有电量列：
-- iBeacon 广播帧**不带电量**（只有 Eddystone TLM 带，而 iOS 屏蔽 Eddystone）。
-- 任何自动电量都是编的 ⇒ battery_note 是人工备注，字段名就该这么说。
--
-- 幂等：IF NOT EXISTS，可重复执行。

CREATE TABLE IF NOT EXISTS pms_bui_wenlv_beacons (
  id           varchar(50)  PRIMARY KEY,
  mac          varchar(32)  NOT NULL,          -- 归一化：大写、去分隔符
  name         varchar(100) NOT NULL,          -- 资产名（E5-01）
  model        varchar(50),                    -- 'Minew E5'
  uuid         varchar(36),                    -- 归一化：小写
  major        integer,                        -- 0..65535
  minor        integer,                        -- 0..65535
  venue_id     varchar(50),                    -- 归属场地
  point_id     varchar(50),                    -- 绑定的点位；NULL = 在库未绑
  status       varchar(20)  NOT NULL DEFAULT 'stock',  -- stock/active/faulty/retired
  tx_power     integer,                        -- 校验距离(RSSI@1m)，现场调试记
  battery_note varchar(200),
  note         text,
  created_by   varchar(50),                    -- 平台用户 id，不加外键，仅审计归属
  created_at   timestamptz  NOT NULL DEFAULT now(),
  updated_at   timestamptz  NOT NULL DEFAULT now()
);

-- (uuid, major, minor) 也要唯一：同一帧不可能对应两台设备。
-- 若真撞上那是配置错误（有人把两台设成一样了）—— 让它在登记时就报错，
-- 比让它在触发时随机命中一台好。触发歧义是最难排查的一类故障。
--
-- ⚠️ PG 的唯一索引把 NULL 当作互不相等 ⇒ 多行 uuid 为 NULL（还没读参数）不冲突。
-- 这是需要的：在库未读参数的设备可以有多台。与 uq_wenlv_venue_points_code 同机制。
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_beacons_mac
  ON pms_bui_wenlv_beacons(mac);
CREATE UNIQUE INDEX IF NOT EXISTS uq_wenlv_beacons_frame
  ON pms_bui_wenlv_beacons(uuid, major, minor);
CREATE INDEX IF NOT EXISTS idx_wenlv_beacons_venue
  ON pms_bui_wenlv_beacons(venue_id);
CREATE INDEX IF NOT EXISTS idx_wenlv_beacons_point
  ON pms_bui_wenlv_beacons(point_id);
