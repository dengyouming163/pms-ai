-- 0041：文旅「免费剧本」引流 —— 两列
--
-- is_free   ：免费游玩的**唯一权威**。放在内容产品（pms_bui_wenlv_products）上，
--             与 assertTicket 同服务同库 ⇒ 零跨服务调用、零歧义。
--             ⚠️ 不能放交易产品：一个 contentProductId 可对应多个交易产品（套餐/场次），
--                「任一 is_free 即免费」会让「付费套餐旁挂一个免费单票 ⇒ 全免费」。
-- visit_count：试玩次数。每次「开始/继续游玩」+1（首次建行时为 1）。
--             ⚠️ 已通关的**回看**不计数 —— 那条分支的注释明令「只读返回，不能写任何新状态」。
--
-- 两列都 NOT NULL DEFAULT：存量行自动落到 false / 0，无需回填，无需停机。
ALTER TABLE pms_bui_wenlv_products ADD COLUMN IF NOT EXISTS is_free boolean NOT NULL DEFAULT false;
ALTER TABLE pms_bui_wenlv_progress ADD COLUMN IF NOT EXISTS visit_count integer NOT NULL DEFAULT 0;
