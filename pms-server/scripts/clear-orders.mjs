/**
 * 清空所有订单数据（开发环境垃圾数据清理）。
 * 按依赖顺序：先删引用订单的子表，再删主订单表。
 * 用法：node scripts/clear-orders.mjs
 */
import { readFileSync } from 'fs';
import { Pool } from 'pg';

// 手动加载 .env（不依赖 dotenv 包）
for (const line of readFileSync('.env', 'utf8').split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim();
}

const pool = new Pool({
  host: process.env.PG_HOST || '127.0.0.1',
  port: Number(process.env.PG_PORT) || 5432,
  database: process.env.PG_DATABASE,
  user: process.env.PG_USER,
  password: process.env.PG_PASSWORD,
});

// 删除顺序：子表（引用 order_id / order_no）→ 主订单表
const TABLES = [
  // —— 引用订单的子表 ——
  'pms_satisfaction_surveys',   // 回访问卷（order_id）
  'pms_inbox',                   // 站内消息（order_id）
  'pms_mini_payments',           // 小程序支付（order_id）
  'pms_distribution',            // 分销记录（order_id / order_no）
  'pms_finance',                 // 财务流水（order_no）
  'pms_bui_wenlv_sessions',      // 文旅场次（order_id，软引用）
  'pms_bui_wenlv_claims',        // 文旅券领取（order_id，软引用）
  // —— 主订单表 ——
  'pms_bui_orders',              // 平台订单
  'pms_bui_channel_orders',      // 渠道待处理订单
  'pms_bui_checkin_orders',      // 入住订单
  'pms_ota_orders',              // OTA 原始订单
];

async function main() {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const counts = {};
    for (const table of TABLES) {
      const { rowCount } = await client.query(`DELETE FROM ${table}`);
      counts[table] = rowCount;
      console.log(`  ✓ ${table}: 删除 ${rowCount} 行`);
    }
    await client.query('COMMIT');
    console.log('\n✅ 全部订单数据已清空（事务已提交）');
    console.log('删除统计：', counts);
  } catch (e) {
    await client.query('ROLLBACK');
    console.error('❌ 删除失败，已回滚：', e.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

main();
