-- 判断题答案归一：AI 生成的 judge 交互写了人类可读的「正确/对」，而全链路
-- （schema 类型 / 创作台下拉 / pms-nimi 的 pickedJudge / isAnswerCorrect 的逐字比较）
-- 只认 'true' | 'false' ⇒ 这些题永远答不对。生产实测 17 条（'对' 5 + '正确' 12）。
--
-- 🚨 **本迁移绝不猜**。只重写**白名单内**的写法；白名单之外的一律原样保留。
--   理由：写错的代价不对称 —— 猜错会让一道题的真假**静默反转**（游客答「对」被判错，
--   或更糟，答「错」被判对），现场无人能察觉；而保留则会被发布闸拦下
--   （wenlv-integrity.ts:118 要求 judge 的 answer 必须是字面量 'true'/'false'），
--   错误暴露在运营点「发布」的那一刻，有人看得见、改得动。
--   ⇒ 宁可吵，不可静默。生产现存 17 条全在白名单内，故本次执行结果与旧版相同（仍归零），
--     差别只在「遇到没见过的写法时是静默猜还是留痕」。
--
-- 幂等：只改非 'true'/'false' 的 judge，重跑无副作用。**只动 judge**，不碰其它题型。
-- 注意：命中节点会被整体 jsonb_agg 重建，因此同一节点上已合法的答案也会走一遍 CASE ——
--      白名单包含大小写变体（'True' → 'true'），这是一次顺带归一，不改变语义。
UPDATE pms_bui_wenlv_nodes n
SET interactions = sub.fixed
FROM (
  SELECT n2.id,
         jsonb_agg(
           CASE
             -- 唯一的两条重写规则，取值集合**闭合**，没有 ELSE 兜底造假
             WHEN (i->>'type') = 'judge'
              AND btrim(coalesce(i->>'answer','')) IN ('对','是','正确','true','TRUE','True')
                THEN jsonb_set(i, '{answer}', to_jsonb('true'::text))
             WHEN (i->>'type') = 'judge'
              AND btrim(coalesce(i->>'answer','')) IN ('错','否','错误','false','FALSE','False')
                THEN jsonb_set(i, '{answer}', to_jsonb('false'::text))
             -- 其余一律原样（含 null/缺字段/没见过的中文写法）。
             -- ⚠️ 这里**永远不能**写成 jsonb_set(…, NULL)：jsonb_set 的第三参为 SQL NULL 时
             --    返回整个 i（不报错），看起来「无害」，但一旦改成 coalesce(…, to_jsonb('true'))
             --    之类的写法就会把无法解析的答案静默变成真 —— 那正是本迁移要避免的失败模式。
             ELSE i
           END
           ORDER BY ord) AS fixed
  FROM pms_bui_wenlv_nodes n2, jsonb_array_elements(n2.interactions) WITH ORDINALITY AS t(i, ord)
  GROUP BY n2.id
) AS sub
WHERE n.id = sub.id
  AND EXISTS (SELECT 1 FROM jsonb_array_elements(n.interactions) x
              WHERE (x->>'type') = 'judge' AND btrim(coalesce(x->>'answer','')) NOT IN ('true','false'));

-- 执行后必须为 0（与 wenlv-0030-verify.sql 的 A/C 两段同谓词）。
-- 若不为 0 ⇒ 存在白名单外的写法，**不要**改本文件去猜；把它捞出来看一眼再决定：
--   SELECT n.id, x->>'answer' FROM pms_bui_wenlv_nodes n, jsonb_array_elements(n.interactions) x
--   WHERE (x->>'type')='judge' AND btrim(coalesce(x->>'answer','')) NOT IN ('true','false');
-- 发布闸会拦住这些内容，不会带病上线。
\echo '=== 0030 执行后：残留的非 true/false judge 条数（必须 0）==='
SELECT count(*) AS remaining_bad
FROM pms_bui_wenlv_nodes n, jsonb_array_elements(n.interactions) x
WHERE (x->>'type') = 'judge'
  AND btrim(coalesce(x->>'answer','')) NOT IN ('true','false');
