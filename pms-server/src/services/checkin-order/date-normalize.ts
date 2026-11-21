// 入住订单日期规范化。
// 为什么要单独一份：H5 粘贴文本、运营手工录入、历史脏数据三处的日期写法各不相同
// （`2026-10-18` / `2026/10/18` / `2026.10.18` / `2026年10月18日` / `10月18日` / `8月14`），
// 而迁移脚本与接口校验必须**用同一份规则**，各写一遍必然漂移。

/** 含年份：2026-10-18 / 2026/10/18 / 2026.10.18 / 2026年10月18日 */
const WITH_YEAR = /^(\d{4})\s*[年\-/.]\s*(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?$/;
/** 缺年份：10月18日 / 10-18 / 10.18 / 8月14 / 10/18 */
const WITHOUT_YEAR = /^(\d{1,2})\s*[月\-/.]\s*(\d{1,2})\s*[日号]?$/;

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

/** 组装并校验日期真实性（排除 2 月 30 日这类「格式合法但日期不存在」的输入） */
function build(year: number, month: number, day: number): string | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const dt = new Date(Date.UTC(year, month - 1, day));
  if (dt.getUTCFullYear() !== year || dt.getUTCMonth() !== month - 1 || dt.getUTCDate() !== day) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/**
 * 把各种写法归一为 `YYYY-MM-DD`。
 * @param input 原始文本（允许空串、允许带空格）
 * @param fallbackYear 缺年份时补的年份
 * @returns 规范化日期；无法解析返回 null（调用方决定是报错还是置 NULL）
 */
export function normalizeCheckinDate(input: unknown, fallbackYear: number): string | null {
  const s = String(input ?? '').replace(/\s+/g, '');
  if (!s) return null;
  const withYear = WITH_YEAR.exec(s);
  if (withYear) return build(Number(withYear[1]), Number(withYear[2]), Number(withYear[3]));
  const withoutYear = WITHOUT_YEAR.exec(s);
  if (withoutYear) return build(fallbackYear, Number(withoutYear[1]), Number(withoutYear[2]));
  return null;
}

/** 间夜数：退房日 − 入住日。退房早于入住、或任一缺失时返回 null。 */
export function nightsBetween(checkIn: string | null, checkOut: string | null): number | null {
  if (!checkIn || !checkOut) return null;
  const a = Date.parse(`${checkIn}T00:00:00Z`);
  const b = Date.parse(`${checkOut}T00:00:00Z`);
  if (Number.isNaN(a) || Number.isNaN(b) || b < a) return null;
  return Math.round((b - a) / 86400000);
}

/**
 * 写 date 列前的归一：空值/非法值 → null。
 * `date` 列**不接受空串**（PG 报 `invalid input syntax for type date: ""`），
 * 既有 H5 链路里 `String(f.checkInDate || '')` 的写法必须换成本函数。
 */
export function toDateOrNull(input: unknown, fallbackYear: number = new Date().getFullYear()): string | null {
  if (input === null || input === undefined) return null;
  const s = String(input).trim();
  if (!s) return null;
  return normalizeCheckinDate(s, fallbackYear);
}
