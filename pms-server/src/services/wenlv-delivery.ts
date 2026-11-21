// 剧本交付的度量口径（纯函数，无 DB）。
// **刻意不建状态机**：AI 生成已有 CREATED→DRAFTING→DRAFT_READY/FAILED（pms-ai-crew 拥有），
// 再建一套「生成中」必然漂移。这里只从时间戳推导阶段，实时进度仍去查 AI run。

export type DeliveryStage = 'not_started' | 'generating' | 'ready' | 'live';

export interface DeliveryStamps {
  generationStartedAt?: Date | null;
  contentReadyAt?: Date | null;
  publishedAt?: Date | null;
}

/**
 * 时间戳是否可用。
 * `new Date('garbage')` 是 truthy 的，只判存在性会让它的 `getTime()`（NaN）一路穿到调用方，
 * 最终在页面上渲染成「NaN 天」——所以这里把「无效」和「没盖章」一视同仁：都算没有。
 */
function isValidDate(d: Date | null | undefined): d is Date {
  return d instanceof Date && !Number.isNaN(d.getTime());
}

/**
 * 阶段推导：上架 > 定稿 > 起稿，逐级回退。
 *
 * 这是**裸推导原语**（只看时间戳，不认识 status）。路由/界面一律用 deliveryStageFor ——
 * 它把 `products.status` 这条权威列纳入优先级，避免同一行「发布状态」与「交付阶段」打架。
 */
export function deriveDeliveryStage(s: DeliveryStamps): DeliveryStage {
  if (isValidDate(s.publishedAt)) return 'live';
  if (isValidDate(s.contentReadyAt)) return 'ready';
  if (isValidDate(s.generationStartedAt)) return 'generating';
  return 'not_started';
}

/**
 * 毫秒差按天向上取整。不足一天记 1 天（0 天没有意义）。
 * 时间戳倒挂（迟挂的剧本、乱序盖章）同样兜到 1 天：只保证不吐出 0 或负数，
 * 不在这里掩盖上游的数据异常——异常该在数据层被看见，不该被度量函数吃掉。
 */
function ceilDays(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  if (ms <= 0) return 1;
  return Math.ceil(ms / 86_400_000);
}

export interface VenueStamps {
  surveyStartedAt?: Date | null;
  deployedAt?: Date | null;
}

/**
 * 从一批剧本里选出「首剧本」—— 度量口径（§5.3）里被 firstScriptDeliveryDays 量的那一个。
 *
 * **判据 = contentReadyAt 最早者**（内容最先定稿的那一个），而不是 createdAt 最早者。
 * 理由：§5.3 的首剧本口径量的是**交付**（公式另一端是场地 deployedAt，取 max 后才减采风开始）。
 * 一个还没定稿的剧本交付不出任何东西；若按 createdAt 选，一旦「先建的剧本卡住不动、
 * 后建的先定稿」，这个函数会返回 null，把**已经真实发生过的首次交付**整个藏掉 ——
 * 而「3 天出首剧本」正是本仓要对客展示的招牌数字，藏掉它等于该数字时有时无。
 * 所以语义收紧为「首个真正交付的剧本」：一个都没定稿 ⇒ 没有首剧本 ⇒ 度量 null。
 *
 * `contentReadyAt` 无效（NaN）等同没盖章（与同模块 isValidDate 同口径）。
 * 并列时取 createdAt 更早者，保证结果稳定可复现（不依赖查询返回顺序）。
 */
export function pickFirstScript<T extends { contentReadyAt?: Date | null; createdAt?: Date | null }>(
  scripts: T[],
): T | null {
  let best: T | null = null;
  let bestMs = 0;
  for (const s of scripts) {
    const ready = s.contentReadyAt;
    if (!isValidDate(ready)) continue;
    const ms = ready.getTime();
    if (best === null || ms < bestMs
      || (ms === bestMs && isValidDate(s.createdAt) && isValidDate(best.createdAt)
        && s.createdAt.getTime() < best.createdAt.getTime())) {
      best = s;
      bestMs = ms;
    }
  }
  return best;
}

/**
 * 首剧本交付时长 = max(场地部署完成, 剧本内容定稿) − 场地采风开始。
 * 这就是「3 天出一个场地」里那个「3 天」。
 * 返回 null = 时间戳缺失或不可用，算不出来（不要用 0 或猜测值代替）。
 *
 * 传入的 `script` 必须是 pickFirstScript 选出的那一个；调用方对「没有首剧本」的场地
 * 传 `{}` 即可 —— 终点缺失同样返回 null，语义一致。
 */
export function firstScriptDeliveryDays(venue: VenueStamps, script: DeliveryStamps): number | null {
  const startedAt = venue.surveyStartedAt;
  const readyAt = script.contentReadyAt;
  if (!isValidDate(startedAt) || !isValidDate(readyAt)) return null;
  const deployedAt = venue.deployedAt;
  const end = isValidDate(deployedAt) && deployedAt > readyAt ? deployedAt : readyAt;
  return ceilDays(startedAt, end);
}

/**
 * 后续剧本交付时长 = 内容定稿 − 起稿。
 * 这就是「10 个点位采一次服务 8 个剧本」体现在第 2–8 个剧本上的那个数。
 * 返回 null = 时间戳缺失或不可用，算不出来。
 */
export function scriptDeliveryDays(script: DeliveryStamps): number | null {
  const startedAt = script.generationStartedAt;
  const readyAt = script.contentReadyAt;
  if (!isValidDate(startedAt) || !isValidDate(readyAt)) return null;
  return ceilDays(startedAt, readyAt);
}

/**
 * 交付阶段的**展示口径**：时间戳推导值 vs `products.status` 权威列的优先级。
 *
 * 为什么需要它：本 Task 之前全仓没有任何地方写过 publishedAt，所以线上真实存在一批
 * `status='published'` 而三个章全空的存量行；此时裸 `deriveDeliveryStage` 会推成
 * `not_started`，直接展示就会让**同一行**并排出现「发布状态 published」+「交付阶段 未起稿」。
 * 阶段是从时间戳推的派生值，status 是权威列 —— 打架时一律 status 赢，且双向收口：
 *   - status='published' → 一律 live：权威列说已上架，即便缺章（存量行）或章被撤；
 *   - status≠published 却盖了 publishedAt（撤回后未清章、脏数据）→ 不许越权报 live，
 *     把 publishedAt 摘掉再推一次，降级到内容层（避免「未发布」的行显示成已上线）。
 *   - 无章的存量行若事后被 unpublish/archive，则**没有** publishedAt 可摘（它本来就没盖过章），
 *     于是重新推导回 not_started（读作「未起稿」）—— 尽管这行确实上线过、也曾被报表算作 live。
 *     这是**刻意少报**：读侧宁可低估阶段，也不要凭一个空章凭空宣称 live，方向与上面第二条一致
 *     （同样的 under-claim 取向）。要修只能靠补章，不在这里猜。
 *
 * 硬性要求是**全局**的 —— 任何并排渲染「status + 交付阶段」的界面（`GET /products/:id/full`、
 * `GET /venues/:id` 的 scripts、以及后续任何新渲染面）都不许与 status 打架。
 * 所以它放在本模块（度量口径的唯一 owner）并导出，而不是散落在路由里靠「记得别用裸函数」的约定：
 * 路由代码请一律用 deliveryStageFor，不要直接调 deriveDeliveryStage。
 */
export function deliveryStageFor(p: { status: string } & DeliveryStamps): DeliveryStage {
  if (p.status === 'published') return 'live';
  const derived = deriveDeliveryStage(p);
  return derived === 'live' ? deriveDeliveryStage({ ...p, publishedAt: null }) : derived;
}
