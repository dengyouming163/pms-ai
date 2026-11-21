/** 场地网络调研的**纯判定**：无 DB、无 IO，故可完整单测。
 *
 *  这里只放「有分支、有边界」的判断 —— 路由文件里只留取数与落库。
 *  理由是本仓的判据拓扑：路由文件的判断只能靠 DB 测试覆盖，而 DB 测试在默认配置下
 *  会被 `describe.skipIf(!process.env.RUN_DB)` 整块跳过 ⇒ **静默零覆盖**。
 *  纯函数放这里，断言就永远在跑。
 */

/** 五个**检索节**（不含 verify：它由汇总步派生，没有检索）。
 *  顺序即展示顺序 —— 改顺序会同时改 App 的进度文案与报告排版，故写进用例钉住。 */
export const RESEARCH_SECTIONS = ['history', 'materials', 'points', 'people', 'context'] as const;
export type ResearchSection = (typeof RESEARCH_SECTIONS)[number];

/** 汇总步派生的第 6 节（待现场核实清单），不参与检索。 */
export const RESEARCH_VERIFY_SECTION = 'verify';

/** 看门狗阈值。
 *
 *  为什么必须有它：ai-crew 的流水线在 finally 里一定会写终态，但**进程被重启时那次写入会丢**
 *  —— 丢了之后这行会永远停在 running，而重跑会被并发保护 409 挡住 ⇒ **死锁**，
 *  且用户看到的字是「有人正在调研这个场地」（那个人可能是三天前的自己）。
 *
 *  15 分钟的依据：5 节串行 = 每节一次 ≤10 秒预算的联网检索 + 一次 LLM 成文，
 *  实测整场耗时见 ai-crew 侧记录；15 分钟是它的数倍余量。
 *  ⚠️ ai-crew 侧有一份**同值副本**（`services/venue_research.py` 的 WATCHDOG_NOTE），
 *     改这里要改那里。两份都在用：那边做自检告警，这边做放行判定。 */
export const RESEARCH_STALE_MS = 15 * 60 * 1000;

/** 逐节状态的合法取值。**读端必须用它过滤** —— 缺失/越界一律按 pending，
 *  绝不能把「键不在」当成 done：那会让界面显示「本节已完成」而正文是空的。 */
const SECTION_STATES = new Set(['pending', 'running', 'done', 'failed']);

export function isResearchSectionState(v: unknown): boolean {
  return typeof v === 'string' && SECTION_STATES.has(v);
}

/** 看门狗只看这两个字段 —— **故意不含 `id`**：本函数对「没有 id 的行」无话可说，
 *  要求 id 只会让调用方（与测试）多编一个用不上的字段。
 *  两个判定函数**各自声明所需最小形状**，而不是共用一个宽的行类型。 */
type StaleCheckable = { status: string; startedAt?: Date | string | null };

/** 并发判定要多一个 `id`（reset 时要返回它）。 */
type ResearchRowLike = StaleCheckable & { id: string };

/** started_at 解析：非 Date 一律转 Date；解不出返回 NaN（调用方据此判「无法证明在跑」）。 */
function startedMs(row: StaleCheckable): number {
  const v = row.startedAt;
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') return new Date(v).getTime();
  return NaN;
}

/** 「疑似中断」：状态是 running 但已经跑太久（或根本没有可信的 started_at）。
 *
 *  三种输入都判 true，理由逐条：
 *   · **超阈值** —— 进程很可能被重启过，终态没写上；
 *   · **started_at 缺失** —— **无法证明**它在跑。判 false 会把场地永久锁在「调研中」；
 *   · **started_at 是脏值** —— 同上。且本函数**不抛**：判定函数抛异常会把 POST 变成 500，
 *     而 500 在这里等于「重跑入口也坏了」，用户彻底没救。
 *
 *  终态行永远返回 false —— `ready` 放一年也不是「疑似中断」。 */
export function isStaleRunning(row: StaleCheckable | null, now: Date): boolean {
  if (!row || row.status !== 'running') return false;
  const ms = startedMs(row);
  if (!Number.isFinite(ms)) return true;
  return now.getTime() - ms > RESEARCH_STALE_MS;
}

/** POST /venues/:id/research 的动作判定。
 *
 *  为什么不是「有行就 409」：三种情形必须分开，合并任何一种都会造出真实故障 ——
 *   · **同一 id 的 running** —— 断网重试自己刚发的那一次。判 409 会让用户看到
 *     「有人正在调研这个场地」（而那个人就是他自己），且此后**再也发不出去**；
 *   · **陈旧的 running** —— 见 isStaleRunning（死锁）；
 *   · **新 id / 无 id 的 running** —— 这才是真正的并发保护，该 409。
 *
 *  reset 时**id 不变**：行 1:1 于场地，落地产物（素材/点位）的 research_id 指向它；
 *  换 id 会让上一轮落地的产物指向一个不存在的行。 */
export function decideResearchStart(
  row: ResearchRowLike | null,
  incomingId: string | undefined,
  now: Date,
): { action: 'insert' } | { action: 'reset'; id: string } | { action: 'conflict' } {
  if (!row) return { action: 'insert' };
  if (row.status === 'running' && !isStaleRunning(row, now) && incomingId !== row.id) {
    return { action: 'conflict' };
  }
  return { action: 'reset', id: row.id };
}
