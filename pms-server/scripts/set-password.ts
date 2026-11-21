import bcrypt from 'bcryptjs';
import pg from 'pg';

const { Pool } = pg;
const pool = new Pool({
  host: '132.232.166.40',
  port: 15432,
  database: 'aipms',
  user: 'aipms',
  password: 'dengyouming2tll',
  ssl: false,
});

const hash = await bcrypt.hash('admin123', 10);
console.log('Hash:', hash);

await pool.query('UPDATE pms_bui_staff SET password = $1 WHERE phone = $2', [hash, '13800000001']);
console.log('OK: staff1 (张明远) 密码已更新为 admin123');

await pool.end();
