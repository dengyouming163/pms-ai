const{ Pool }=require('pg');
const p=new Pool({host:'132.232.166.40',port:15432,database:'aipms',user:'aipms',password:'dengyouming2tll',connectionTimeoutMillis:10000});
(async()=>{
const c=await p.connect();
try{
const t=await c.query("SELECT table_name FROM information_schema.tables WHERE table_schema='public' AND table_type='BASE TABLE' ORDER BY table_name");
console.log('TABLES:',t.rows.map(r=>r.table_name).join(', '));
const s=await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pms_bui_staff' ORDER BY ordinal_position");
console.log('STAFF:',s.rows.map(r=>r.column_name).join(', '));
const o=await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pms_bui_orders' ORDER BY ordinal_position");
console.log('ORDERS:',o.rows.map(r=>r.column_name).join(', '));
const a=await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pms_bui_ai_suggestions' ORDER BY ordinal_position");
console.log('AI_SUGG:',a.rows.map(r=>r.column_name).join(', '));
const h=await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pms_bui_ai_chat_history' ORDER BY ordinal_position");
console.log('AI_CHAT:',h.rows.map(r=>r.column_name).join(', '));
const r=await c.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='pms_bui_rooms' ORDER BY ordinal_position");
console.log('ROOMS:',r.rows.map(r=>r.column_name).join(', '));
}finally{c.release();p.end()}
})().catch(e=>{console.error('ERR:',e.message);p.end()});
