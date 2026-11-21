// 入住订单日期列改造：varchar(20) → date 的「影子列三步法」执行器。
//   --dry-run  只报告：哪些行的日期无法解析、无法解析的原始值长什么样（**不写库**）
//   --apply    回填影子列 check_in_date_d / check_out_date_d
//   --swap     校验通过后：删除旧列，影子列改名为正式列名
// 与接口共用同一份解析规则（src/services/checkin-order/date-normalize.ts），避免两处漂移。
import { Pool } from 'pg';
import { normalizeCheckinDate } from '../src/services/checkin-order/date-normalize.js';

const DATABASE_URL = process.env.DATABASE_URL
  || `postgresql://${process.env.PG_USER}:${process.env.PG_PASSWORD}@${process.env.PG_HOST}:${process.env.PG_PORT || 5432}/${process.env.PG_DATABASE}?sslmode=${process.env.PG_SSL === 'true' ? 'require' : 'disable'}`;

const mode = process.argv.includes('--dry-run') ? 'dry-run'
  : process.argv.includes('--apply') ? 'apply'
  : process.argv.includes('--swap') ? 'swap'
  : '';

if (!mode) {
  console.error('用法: npx tsx scripts/normalize-checkin-dates.ts --dry-run|--apply|--swap');
  process.exit(2);
}

// 安全失败：连接配置缺失时立即中止，绝不兜底成任何硬编码连接串。
// 否则 pg 会拼出 `postgresql://undefined:undefined@undefined:5432/undefined`，
// 直到 DNS 解析才抛 `getaddrinfo ENOTFOUND undefined`，报错晦涩难以定位。
if (!process.env.DATABASE_URL && !(process.env.PG_HOST && process.env.PG_DATABASE && process.env.PG_USER)) {
  console.error('缺少数据库连接配置：未设置 DATABASE_URL，且 PG_HOST / PG_DATABASE / PG_USER 不完整。');
  console.error('请先导出 DATABASE_URL，或导出 PG_HOST / PG_DATABASE / PG_USER / PG_PASSWORD；');
  console.error('也可用 `npx tsx --env-file=.env scripts/normalize-checkin-dates.ts --dry-run` 自动加载 .env。');
  process.exit(1);
}

const pool = new Pool({ connectionString: DATABASE_URL });

interface Row { id: string; check_in_date: string | null; check_out_date: string | null; created_at: Date; }

/** 缺年份时用录入年份补全（补录单的入住日可能早于录入日，故取两者较早的年份也合理；这里用录入年份） */
function resolveOne(raw: string | null, fallbackYear: number): string | null {
  return normalizeCheckinDate(raw, fallbackYear);
}

/** 读全表 → 逐行解析 → 返回「待回填列表」与「无法解析清单」。每次调用都重新查库，**不复用旧快照**。 */
async function collect(): Promise<{
  total: number;
  failures: { id: string; field: string; raw: string }[];
  updates: { id: string; in: string | null; out: string | null }[];
}> {
  const { rows } = await pool.query<Row>(
    'SELECT id, check_in_date, check_out_date, created_at FROM pms_bui_checkin_orders ORDER BY created_at',
  );
  const failures: { id: string; field: string; raw: string }[] = [];
  const updates: { id: string; in: string | null; out: string | null }[] = [];

  for (const r of rows) {
    const fallbackYear = new Date(r.created_at).getFullYear();
    const inD = resolveOne(r.check_in_date, fallbackYear);
    const outD = resolveOne(r.check_out_date, fallbackYear);
    if (r.check_in_date && !inD) failures.push({ id: r.id, field: 'check_in_date', raw: r.check_in_date });
    if (r.check_out_date && !outD) failures.push({ id: r.id, field: 'check_out_date', raw: r.check_out_date });
    updates.push({ id: r.id, in: inD, out: outD });
  }
  return { total: rows.length, failures, updates };
}

/** 把解析结果写进影子列（幂等：同一行可被重复覆盖）。`--apply` 与 `--swap` 都会调用它。 */
async function backfill(updates: { id: string; in: string | null; out: string | null }[]): Promise<number> {
  let changed = 0;
  for (const u of updates) {
    const res = await pool.query(
      'UPDATE pms_bui_checkin_orders SET check_in_date_d = $2, check_out_date_d = $3 WHERE id = $1',
      [u.id, u.in, u.out],
    );
    changed += res.rowCount || 0;
  }
  return changed;
}

/**
 * 前置校验：影子列 check_in_date_d / check_out_date_d 必须同时存在。
 * `--apply`（写影子列）与 `--swap`（依赖影子列改名）执行前都要过这一关。
 * 为什么 swap 必须在 DROP 之前查：`DROP COLUMN IF EXISTS check_in_date` 在「已交换后」
 * （影子列早已改名、不存在）重跑时会**静默删掉活着的正式列（连同 date 数据）**，
 * 随后 RENAME 因影子列不存在而报错 ⇒ 两个正式列都没了 ⇒ 读接口全部 42703 报 500，且不可恢复。
 * 「首次 swap 中途失败后再跑一次 --swap 修表」正是最容易踩到的场景，故这里安全失败。
 */
async function assertShadowColumnsExist(): Promise<void> {
  const { rows } = await pool.query<{ column_name: string; data_type: string }>(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_name = 'pms_bui_checkin_orders'
        AND column_name IN ('check_in_date', 'check_in_date_d', 'check_out_date', 'check_out_date_d')`,
  );
  const has = (name: string) => rows.some((r) => r.column_name === name);
  const missing = [
    !has('check_in_date_d') ? 'check_in_date_d' : '',
    !has('check_out_date_d') ? 'check_out_date_d' : '',
  ].filter(Boolean);
  if (!missing.length) return;

  const curIn = rows.find((r) => r.column_name === 'check_in_date')?.data_type;
  const curOut = rows.find((r) => r.column_name === 'check_out_date')?.data_type;
  console.error(`前置校验失败：影子列 ${missing.join(' / ')} 不存在，已中止（未执行任何 DROP/RENAME）。`);
  if (curIn === 'date' && curOut === 'date') {
    console.error('当前表已处于「交换后」状态（check_in_date / check_out_date 已是 date 类型），无需再执行；');
    console.error('重复执行 --swap 会删除正式列并永久丢失日期数据。');
  } else {
    console.error('也可能是 0083 迁移（新增影子列）尚未执行，请先执行 0083 后再运行本脚本。');
  }
  await pool.end();
  process.exit(1);
}

async function main() {
  if (mode === 'apply' || mode === 'swap') await assertShadowColumnsExist();

  const initial = await collect();
  console.log(`总行数 ${initial.total}；无法解析 ${initial.failures.length} 处`);
  if (initial.failures.length) {
    console.log('--- 无法解析清单（原始值 → 将置 NULL）---');
    for (const f of initial.failures) console.log(`${f.id}\t${f.field}\t${JSON.stringify(f.raw)}`);
  }

  if (mode === 'dry-run') {
    console.log('dry-run 结束，未写入任何数据。');
    await pool.end();
    return;
  }

  if (mode === 'apply') {
    console.log(`已回填 ${await backfill(initial.updates)} 行影子列。`);
    await pool.end();
    return;
  }

  // swap：**先重新查库并再回填一次**，再校验，最后才交换。
  // 为什么必须重读重填：`--apply` 与 `--swap` 之间线上仍在接单（H5 / 平台录入），
  // 这期间新增或改过日期的行，其影子列还是 NULL；若直接交换，这些行的入住/退房日期
  // 会在交换后变成 NULL —— 即**静默丢日期**。重新回填一行不漏地兜住这个窗口。
  const fresh = await collect();
  if (fresh.failures.length) {
    console.error(`存在 ${fresh.failures.length} 处无法解析的日期，swap 已中止。请先人工确认后再执行。`);
    await pool.end();
    process.exit(1);
  }
  console.log(`交换前增量回填 ${await backfill(fresh.updates)} 行影子列（覆盖 --apply 之后新产生的订单）。`);

  // 交换相关 DDL 必须在**同一事务**里：PostgreSQL 支持事务内 DDL，
  // 这样外部会话要么看到交换前、要么看到交换后，不会落进「旧列已删、新列未改名」的中间态而 42703 报 500；
  // 任一条失败/被中断也整体回滚，不留坏中间态。
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('ALTER TABLE pms_bui_checkin_orders DROP COLUMN IF EXISTS check_in_date');
    await client.query('ALTER TABLE pms_bui_checkin_orders DROP COLUMN IF EXISTS check_out_date');
    await client.query('ALTER TABLE pms_bui_checkin_orders RENAME COLUMN check_in_date_d TO check_in_date');
    await client.query('ALTER TABLE pms_bui_checkin_orders RENAME COLUMN check_out_date_d TO check_out_date');
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  console.log('已完成列交换：check_in_date / check_out_date 现为 date 类型。');
  await pool.end();
}

main().catch((err) => { console.error(err); process.exit(1); });
