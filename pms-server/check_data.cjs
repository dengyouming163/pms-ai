const{Pool}=require('pg');
const p=new Pool({host:'132.232.166.40',port:15432,database:'aipms',user:'aipms',password:'dengyouming2tll',connectionTimeoutMillis:10000});
(async()=>{
const c=await p.connect();
try{
const r=await c.query("SELECT 'stores' as t,count(*) as n FROM pms_bui_stores UNION ALL SELECT 'staff',count(*) FROM pms_bui_staff UNION ALL SELECT 'rooms',count(*) FROM pms_bui_rooms UNION ALL SELECT 'orders',count(*) FROM pms_bui_orders UNION ALL SELECT 'ai_suggestions',count(*) FROM pms_bui_ai_suggestions UNION ALL SELECT 'ai_chat',count(*) FROM pms_bui_ai_chat_history UNION ALL SELECT 'transactions',count(*) FROM pms_bui_transactions");
console.log('COUNTS:');
r.rows.forEach(x=>console.log('  '+x.t+': '+x.n));
const s=await c.query('SELECT * FROM pms_bui_ai_suggestions LIMIT 5');
console.log('AI_SUGG:',JSON.stringify(s.rows,null,2));
const t=await c.query('SELECT type,count(*),SUM(amount) as total FROM pms_bui_transactions GROUP BY type');
console.log('TRANS:',JSON.stringify(t.rows));
const o=await c.query('SELECT status,count(*) FROM pms_bui_orders GROUP BY status');
console.log('ORDERS_BY_STATUS:',JSON.stringify(o.rows));
}finally{c.release();p.end()}
})().catch(e=>{console.error('ERR:',e.message);p.end()});
