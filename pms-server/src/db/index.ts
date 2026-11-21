import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema';

const required = (key: string) => {
  const val = process.env[key];
  if (!val) throw new Error(`FATAL: ${key} 环境变量未设置！`);
  return val;
};
const pool = new Pool({
  host: required('PG_HOST'),
  port: Number(process.env.PG_PORT) || 5432,
  database: required('PG_DATABASE'),
  user: required('PG_USER'),
  password: required('PG_PASSWORD'),
  ssl: process.env.PG_SSL === 'true',
  max: 10, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
});

export const db = drizzle(pool, { schema });
export { pool };

/** Drizzle 事务类型（随 db 实例自动同步，各 service 统一复用） */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
