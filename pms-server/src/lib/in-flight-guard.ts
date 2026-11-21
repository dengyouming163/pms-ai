/**
 * 进程内守卫：同一 key 既不能**同时在飞**，也不能在**刚刚成功之后**立刻再来一次。
 *
 * 为什么需要它：文旅素材生成花钱的端点（`/api/admin/wenlv-asset-gen/*`）此前没有任何
 * 请求级幂等 —— 用户双击一次「生成」，就是两个并发请求各建一整批 job、各记一次费
 * （`costAmount` 是 SQL `+=` 累加）。
 *
 * ## 覆盖到什么程度（2026-09-14 重写）
 * 此前这里写着「守卫粒度到请求即可堵住真实触发形态（同一个浏览器双击）」——**那句是错的**，
 * 它把「一个在一处 DB 写上成立的机制」说成了「一处通用保障」。真实覆盖是下面三层，各挡各的形态：
 *
 *  1. **在飞集合**（`acquire` / `release`）：只挡**真正重叠**的并发，即第二个请求必须在第一个
 *     `release` 之前到达。对本模块的 `/style-bible/bootstrap`（跨秒级 LLM 调用）有效。
 *     ⚠️ 对窗口只有**一次 INSERT/UPDATE（数十毫秒）**的端点，典型双击（两次点击间隔 100–300ms）
 *     几乎挡不住：第二个请求到达时第一个多已 `release`，`acquire` 照样返回 true。
 *     但**并非绝对**——只要第二个请求恰好落在那一次 DB 写的窗口内（慢 DB、脚本化重复提交、
 *     第一个请求排队），在飞集合**是会命中的**。所以它是「覆盖不全」而不是「恒不触发」。
 *  2. **成功后冷却**（`hold`，默认 `SUCCESS_COOLDOWN_MS`）：挡**串行的重复触发**，也就是真实
 *     「同一次双击的第二下」。本模块**保留冷却**的三个端点（`/batch`、`/iterate`、
 *     `/style-bible/bootstrap`）里，对 `/batch` 这类短端点它才是真正被挡住的机制。
 *     ⚠️ **不是每个端点都需要它**：`/retry` 成功后行状态即变 `pending`，第二次点击在状态
 *     校验处就拿 400，到不了 `acquire` —— 冷却在那里挡不住任何付费，只会在「任务又失败」
 *     时给出文案不实的 409，故 `0e5a2c33` 之后**已摘除**（见路由文件头）。
 *     `hold` 只在**成功路径**上调用（失败还冷却的话，一次失败会让用户 3s 内无法重试）。
 *  3. **前端在请求 pending 期间禁用按钮**：第一道防线，在前端实现（Task 15/16），不在本模块。
 *     本模块是它失效时的兜底，不是它的替代品。
 *
 * ## ⚠️ 单实例假设（必须知道）
 * 守卫状态只活在**当前 Node 进程的内存**里。多副本 / 多实例部署下，两个副本各收到一半请求时
 * 它**完全失效**（两边各自 `acquire` 都成功）。届时需要改成 DB 条件更新 claim
 * （`UPDATE … SET … WHERE status = 'pending'` 那类，靠行锁而不是靠进程内存）。
 * 本系统当前的 pms-server 是**单实例**（compose 一个副本），故这一层足够。
 *
 * ## 用法契约
 * - `acquire(key)` 返回 `true` = 拿到，**必须**在 `finally` 里 `release(key)`；
 * - 返回 `false` = 已有同 key 在飞**或**该 key 正处于成功冷却中，调用方自己决定回什么（本仓回 409）；
 * - **不要**在拿到之前做任何副作用；**不要**在 `catch` 里 `release` 而不写 `finally`
 *   （异常路径会永久锁死该 key）；
 * - `hold(key)` 只在成功路径上调用，且**不**需要在 `finally` 里配套撤销 —— 冷却就是靠过期消失的。
 *
 * ## 为什么这次**存了**时间戳（本节 2026-09-14 整节重写）
 * 上一版是纯 `Set<string>`，注释里写「刻意不存时间戳」，理由是「被拒的 acquire 结构上不可能
 * 覆盖已有条目」。那个理由是成立的，但它保护的是一个**不够用的机制**：纯 Set 只能表达
 * 「现在在飞」，挡得住真正重叠、挡不住「第一次已经返回、第二次还在路上」这个真实形态（双击）。
 * 所以现在多一个 `Map<string, number>`（key → 冷却到期时刻），它的存在**就是为了**那段空窗。
 *   - 过期条目在 `acquire` 里**惰性清理**：刻意**不用** `setInterval` / `setTimeout` ——
 *     定时器会让测试挂住进程，模块被多次加载时还会泄漏一份没人回收的 interval。
 *   - 仍然**别顺手往 `acquire` 里塞别的东西**：两个集合各自语义单一（一个「此刻在飞」、
 *     一个「到某时刻为止别再放行」）。要加第三种状态就另开一个结构，别往这两个里塞字段。
 */
const inflight = new Set<string>();
/** key → 冷却到期时刻（`Date.now()` 毫秒）。独立于 `inflight`：`release` 不动它。 */
const cooldownUntil = new Map<string, number>();

/**
 * 成功后冷却时长（ms）。
 *
 * 为什么是 3s：真实双击的两次点击间隔 **<1s**（人是连点的）；而「成功但响应慢」那段窗口
 * （BFF 的 internalFetch 固定 10s 超时）本来就被在飞集合盖着，冷却不必为它多留。
 * 所以 3s 只需覆盖「第一次已经返回、第二次还在路上」的空窗：比双击间隔宽、
 * 又短到用户真要重来时不难受。改这个值请连带改本段与文件头第 2 层。
 */
export const SUCCESS_COOLDOWN_MS = 3000;

/**
 * 尝试占住 `key`。
 * `true` = 占住（调用方负责 `finally` 释放）；
 * `false` = 已有同 key 在飞，**或**该 key 仍在成功后冷却期内。
 */
export function acquire(key: string): boolean {
  if (inflight.has(key)) return false;
  const until = cooldownUntil.get(key);
  if (until !== undefined) {
    if (until > Date.now()) return false;
    cooldownUntil.delete(key);      // 已过期：顺手清掉（惰性清理，只在被访问到时发生）
  }
  inflight.add(key);
  return true;
}

/**
 * 释放 `key`。幂等：重复释放（或释放从未占过的 key）是无害的空操作。
 * **只**清在飞集合，**不**清冷却 —— 否则 `finally` 一执行冷却就没了，等于没加。
 */
export function release(key: string): void {
  inflight.delete(key);
}

/**
 * 把 `key` 标记为「冷却到 `now + ms`」。**只在成功路径上调用**（见文件头第 2 层）。
 * 与在飞集合互不影响：既可以在 `release` 之前调，也可以在之后（本仓四个端点放在成功返回前）。
 */
export function hold(key: string, ms: number = SUCCESS_COOLDOWN_MS): void {
  cooldownUntil.set(key, Date.now() + ms);
}

/**
 * **仅供测试**：当前冷却表里的条目数。
 *
 * 存在的唯一理由：「过期条目被惰性清理」这件事在**纯行为层面不可观测** —— 一个「到期即失效
 * 但条目一直留着」的实现，所有 acquire 的返回值都与真清理的实现逐位相同，差别只在内存会
 * 无界增长。所以要么放弃断言清理、要么开这个只读窗口。选了后者。生产代码**不要**调用它。
 */
export function _debugCooldownSize(): number {
  return cooldownUntil.size;
}

/**
 * **仅供测试**：清空在飞集合与冷却表，让每条用例从**干净的守卫**开始。
 *
 * 存在的唯一理由：两个集合是**进程级**状态，而 vitest 在同一进程内跑完一个文件里所有用例。
 * 没有这个出口时，「每个用例从干净的守卫开始」只能靠**默认假设**——而真实缺陷正是被它掩盖的：
 * 2026-09-14，`hold` 上线后 8 条 DB 用例集体变红，其中一半就是「上一条用例留下的冷却
 * 被下一条当成自己的前置状态」。把它变成显式的 `beforeEach`，用例之间才真的互不污染。
 *
 * ⚠️ 它**不**掩盖冷却本身的行为：冷却的专有用例断言的都是**同一用例内**的 set→读，
 *    不受用例开始时的一次清空影响。
 * ⚠️ 生产代码**不要**调用它（清空正在飞的条目 = 让双击重新穿透）。
 */
export function _debugResetGuard(): void {
  inflight.clear();
  cooldownUntil.clear();
}
