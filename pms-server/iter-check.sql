\pset pager off
select '--- 迭代前后两条 ---' as s;
select id, asset_type, status, iteration, parent_job_id, cost_amount,
       coalesce(left(error_message,120),'-') as err
from pms_bui_wenlv_asset_jobs
where id in ('55da70c3-db54-479f-956b-607db3d8fb87','e0b6731b-30ff-4da9-b780-bc5a288264e2');

select '--- 批次总额（应 = 3.7601 + 迭代造价）---' as s;
select round(sum(cost_amount)::numeric, 4) as total_all_jobs from pms_bui_wenlv_asset_jobs;
