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

try {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS pms_bui_sessions (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      device VARCHAR(256) DEFAULT '未知设备',
      ip VARCHAR(64) DEFAULT '',
      token VARCHAR(512) NOT NULL,
      current BOOLEAN DEFAULT false,
      created_at TIMESTAMP DEFAULT NOW() NOT NULL,
      last_active_at TIMESTAMP DEFAULT NOW() NOT NULL
    )
  `);
  console.log('OK: pms_bui_sessions table created');
} catch (e: any) {
  console.error('ERR:', e.message);
}

await pool.end();
