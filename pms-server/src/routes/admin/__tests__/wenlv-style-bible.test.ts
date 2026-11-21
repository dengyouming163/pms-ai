import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import { eq, inArray } from 'drizzle-orm';
import { productHeadSchema } from '../wenlv.js';
import route from '../wenlv-asset-gen.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts } from '../../../db/schema/index.js';
import { acquire, release, _debugResetGuard } from '../../../lib/in-flight-guard.js';

// 守卫的两个集合是**进程级**状态（同进程跑完本文件全部用例）。不清的话，上一条成功用例
// 留下的 3s 冷却会被下一条当成前置状态 —— 2026-09-14 `hold` 上线后本文件 1 条就是这么红的。
// 显式清空 = 把「每个用例从干净的守卫开始」变成前提而不是假设。
// （`beforeEach` 对无库的那几条也生效，无害。）
beforeEach(() => { _debugResetGuard(); });

// 只把 bootstrapStyleBible 换成 mock，其余导出保持真身（**不要**用只含一个键的工厂，
// 会把模块其它导出一起抹掉）。这样「真自举」这条路径可以被测到，而**不会真的调 LLM 花钱**。
//
// ⚠️ 2026-09-14 实测：本仓 `src/types/vitest.d.ts` 是**手写类型桩**，把 `vi.mock` 的工厂
//    声明成 `() => unknown`（**不带** `importOriginal` 形参），所以计划原文的
//    `async (importOriginal) => ...` 在 ts-check 下报 TS2345 + TS7006。
//    2026-09-19 更正：本行原先称「仓库既定做法是换写法而不是扩桩」——桩头部第 2 行其实
//    写的是**用时补桩**，本次 Task 8 就是这么做的（追加了 toThrow/toBeLessThan）。
//    这里仍不扩桩，理由只是「本次不值得为它改桩」，不是「不许改」。
//    故这里只对**工厂本身**做一次 `as any`（运行时 vitest 4 确实会把 importOriginal 传进来，
//    桩只是把它省掉了），其余调用面一律走下面这个显式类型别名，不依赖 `vi.mocked`。
vi.mock('../../../services/wenlv-asset-gen-scheduler.js', (async (importOriginal: any) => ({
  ...(await importOriginal()),
  bootstrapStyleBible: vi.fn(),
})) as any);
import { bootstrapStyleBible } from '../../../services/wenlv-asset-gen-scheduler.js';

/**
 * 类型桩没有 `vi.mocked`（见上）。运行时这个绑定就是 `vi.fn()`，按它被用到的调用面显式取用 ——
 * 这样断言仍是强类型的，且不需要为了一个测试去扩桩。
 */
type BsbMock = {
  mockResolvedValueOnce: (v: unknown) => void;
  mockRejectedValueOnce: (e: unknown) => void;
  mock: { calls: unknown[][] };
};
const bsbMock = bootstrapStyleBible as unknown as BsbMock;

describe('productHeadSchema 的 styleBible（防 .partial() 注入默认值清空基线）', () => {
  it('省略 styleBible 时 parsed 结果里**不含**该键', () => {
    // ⚠️ 这是本项目踩过的坑（见 zod-partial-injects-defaults 记忆）：
    // 若 styleBible 写成 z.any().default({})，.partial() 对省略字段**仍会注入默认值**，
    // 于是一次「只改名字」的 PATCH 会把风格基线整个清空。
    const r = productHeadSchema.partial().safeParse({ name: '新名字' });
    expect(r.success).toBe(true);
    expect('styleBible' in (r as any).data).toBe(false);
  });

  it('显式传 styleBible 时透传', () => {
    const r = productHeadSchema.partial().safeParse({
      styleBible: { artStyle: '水墨', forbidden: ['现代物件'] },
    });
    expect(r.success).toBe(true);
    expect((r as any).data.styleBible.artStyle).toBe('水墨');
  });

  it('显式传 null 时透传（允许清空，但必须是显式的）', () => {
    const r = productHeadSchema.partial().safeParse({ styleBible: null });
    expect(r.success).toBe(true);
    expect((r as any).data.styleBible).toBeNull();
  });
});

const TOKEN = process.env.INTERNAL_SERVICE_TOKEN || 'test-internal-token';
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };
const postRaw = (raw: string) =>
  route.request('/style-bible/bootstrap', { method: 'POST', headers: H, body: raw });
const run = !!process.env.RUN_DB;
const B = `sb-test-${Date.now()}`;

describe('POST /style-bible/bootstrap（无库）', () => {
  it('无内部 token → 403', async () => {
    const res = await route.request('/style-bible/bootstrap', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
    });
    expect(res.status).toBe(403);
  });

  it('body 恰为 JSON null → 400，不是 500', async () => {
    // 钉住 readJsonObject 那层兜底。写成 c.req.json().catch(() => ({} as any)) 的话，
    // JSON.parse('null') 成功返回 null → 不触发 catch → null.productId 抛 TypeError → 500。
    expect((await postRaw('null')).status).toBe(400);
  });

  it('缺 productId → 400', async () => {
    expect((await postRaw('{}')).status).toBe(400);
  });
});

describe.skipIf(!run)('POST /style-bible/bootstrap（有库）', () => {
  const ids: string[] = [];
  const mk = async (id: string, styleBible: unknown, venueId: string | null = null) => {
    ids.push(id);
    await db.insert(pmsBuiWenlvProducts)
      .values({ id, name: id, venueId, styleBible: styleBible as any });
  };
  afterAll(async () => {
    if (ids.length) await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, ids));
  });
  // mock 的调用数是**跨用例累积**的（文件里原本没有任何清理）。不清的话
  // 「未调用」那类断言只在「它是本文件里第一条调用它的用例」时才成立 ——
  // 一旦 shuffle 打乱顺序就会红。
  // ⚠️ 别把这条规矩的出处指向 `wenlv-asset-gen.test.ts` —— 那个文件**没有** `vi.clearAllMocks()`，
  //    它只有文件级的 `beforeEach(() => _debugResetGuard())`：清的是**守卫**，不是 **mock**，
  //    两件事别混。本仓真正把这条落到实处的，是 `routes/internal/__tests__` 与
  //    `routes/mini/__tests__` 下的几个文件（文件级 `beforeEach(() => vi.clearAllMocks())`）。
  //    （此处不写行号 —— 跨文件行号会漂成假事实，与本计划其余注释同一条纪律。）
  //
  // 用 clearAllMocks（只清 calls/instances/results），**不是** resetAllMocks
  // （会连 mockResolvedValueOnce 的实现一起重置；而且桩里根本没声明它）。
  // 所以 -empty / -boom 各自设的一次性实现不受影响。
  beforeEach(() => vi.clearAllMocks());

  it('产品不存在 → 404', async () => {
    expect((await postRaw(JSON.stringify({ productId: `${B}-nope` }))).status).toBe(404);
  });

  it('已有 artStyle 且未 force → reused:true，原样回库里的基线，**不调 LLM**', async () => {
    const id = `${B}-reuse`;
    const stored = { artStyle: '水墨', forbidden: ['现代物件'] };
    await mk(id, stored);
    const res = await postRaw(JSON.stringify({ productId: id }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.reused).toBe(true);
    expect(data.styleBible).toEqual(stored);
    // reused 分支也带 `batchId`：控制台拿这一个 id 就能查到该产品**历史累计**花了多少
    //（GET /batch/:batchId 的 totalCost），哪怕这一次没花钱。
    // 与真跑那条分支**同源**（`bootstrapStyleBible` 写行用的是同一个固定前缀），
    // 所以断言按 `stylebible:<pid>` 这个契约写死，而不是对着实现回显的字符串较真。
    expect(data.batchId).toBe(`stylebible:${id}`);
    // 真匹配器（桩里 expect<T> 返回 Matchers<T> & {not: Matchers<T>}，而 Matchers
    // 声明了 toHaveBeenCalled —— 早期误判成「桩没声明」而退化成了手写的弱断言）。
    expect(bootstrapStyleBible).not.toHaveBeenCalled();
  });

  it('styleBible={} → **不走** reused 分支（判据是 artStyle 而非「存在」）', async () => {
    const id = `${B}-empty`;
    await mk(id, {});
    bsbMock.mockResolvedValueOnce({ artStyle: '自举出来的' });
    const res = await postRaw(JSON.stringify({ productId: id }));
    const { data } = await res.json();
    expect(data.reused).toBe(false);
    // 成功路径的**唯一产出**（自举出来的基线）必须被钉住：不钉的话把响应里的
    // `styleBible: bible` 整个删掉，全仓 804 条用例照样全绿（2026-09-14 实证变异存活），
    // 而控制台会静默拿到 undefined。
    expect(data.styleBible).toEqual({ artStyle: '自举出来的' });
    // 真跑那条分支也必须回 batchId —— 它就是 `bootstrapStyleBible` 刚落进
    // `pms_bui_wenlv_asset_jobs` 的那条**合成行**的批次 id（账的查询入口）。
    // 与 reused 分支同一个契约：`stylebible:<pid>`。
    expect(data.batchId).toBe(`stylebible:${id}`);
    expect(bootstrapStyleBible).toHaveBeenCalledWith(id, null);
  });

  it('force 只认真布尔 true：`"false"`/`"0"`/1 都不算强制（`!body.force` 会误判成重跑付费 LLM）', async () => {
    const id = `${B}-force-str`;
    await mk(id, { artStyle: '水墨' });
    // 真值但**非** true 的这几种：旧写法 `!body.force` 会把它们全判成「强制」
    // → 绕过复用守卫、重跑一次付费 LLM、并用结果覆盖既有基线。
    for (const f of ['false', '0', 1, {}, []]) {
      const res = await postRaw(JSON.stringify({ productId: id, force: f }));
      expect(res.status).toBe(200);
      const { data } = await res.json();
      expect(data.reused).toBe(true);
      expect(data.styleBible).toEqual({ artStyle: '水墨' });
    }
    expect(bootstrapStyleBible).not.toHaveBeenCalled();
  });

  it('force: true（真布尔）→ 重跑自举并回新基线（正向半边，防把 force 写死成 false）', async () => {
    const id = `${B}-force-true`;
    await mk(id, { artStyle: '旧的' });
    bsbMock.mockResolvedValueOnce({ artStyle: '重跑出来的' });
    const res = await postRaw(JSON.stringify({ productId: id, force: true }));
    expect(res.status).toBe(200);
    const { data } = await res.json();
    expect(data.reused).toBe(false);
    expect(data.styleBible).toEqual({ artStyle: '重跑出来的' });
    expect(bootstrapStyleBible).toHaveBeenCalledWith(id, null);
    // ★ `toHaveBeenCalledWith` 的语义是「**至少**有一次匹配调用」，钉不住次数
    //   （Task 17 清单 29）。这里调的是**付费 LLM**：真跑两次 = 扣两次钱。
    //   配对变异实证（2026-09-14）：在真调用**之后**再加一次、结果丢弃的调用
    //   （= 重试环/预热调用写错的真实回归类），本条红
    //   `expected "vi.fn()" to be called 1 times, but got 2 times`，且**只有它红**
    //   —— 前面每条断言仍绿，证明它独立承重；把本行退回只有 `toHaveBeenCalledWith`
    //   的写法，同一变异下**全绿**。
    //   ⚠️ 变异必须加在真调用**之后**：加在之前会让多余那次吃掉 `mockResolvedValueOnce`
    //      的值 ⇒ 测试在更早的 `data.styleBible` 断言就红，那样证的是前一条断言，
    //      与次数断言无关（首轮就是这么跑出假结论的）。
    expect(bootstrapStyleBible).toHaveBeenCalledTimes(1);
  });

  it('自举抛错 → 502，且响应体**不含** SQL 原文（no-raw-error-leak）', async () => {
    const id = `${B}-boom`;
    await mk(id, null);
    bsbMock.mockRejectedValueOnce(
      new Error('Failed query: select "id" from "pms_bui_wenlv_products" params: 1'),
    );
    const res = await postRaw(JSON.stringify({ productId: id }));
    expect(res.status).toBe(502);
    // 先取原文再解析（同一个 Response 的 body 只能消费一次）：SQL 泄露必须查**原始文本**，
    // 解析后再查会漏掉「非 JSON 载荷」这种形态。
    const text = await res.text();
    const body = JSON.parse(text);
    // 失败响应体的形状也要钉 —— 只断状态码的话，把 success/error 字段整个删掉也不会红。
    expect(body.success).toBe(false);
    expect(text).not.toContain('Failed query');
    expect(text).not.toContain('pms_bui_wenlv_products');
  });

  // ===== 进程内 in-flight 守卫（S3 加固，2026-09-14 拍板）=====
  // 这三条钉的正是那处 TOCTOU 的**单实例**半边：双击时第二个请求必须在这里被拒，
  // 而不是各调一次付费 LLM。确定性做法：手动 acquire 等价于「另一个请求正在飞」，不 sleep。
  // ⚠️ 模块级 Set 是进程级共享的，每条都要自己 release（try/finally），否则后面的用例会莫名全红。
  it('进程内守卫：自举已在飞 → 409，且**不调** bootstrapStyleBible（上游确实没被调用）', async () => {
    const id = `${B}-guard-fly`;
    await mk(id, {});
    expect(acquire(`bootstrap:${id}`)).toBe(true);
    try {
      const res = await postRaw(JSON.stringify({ productId: id }));
      expect(res.status).toBe(409);
      const { error } = await res.json() as any;
      expect(error).toBe('该剧本正在生成中，请稍候再试');
      // 与既有的 409（「该剧本还没有风格基线…」）**必须是两句话**：调用方要能区分
      // 「缺前置条件」与「正在跑，等会儿再来」。上面断的是本期新增文案。
      expect(error).not.toContain('没有风格基线');
      // 这条才是「花钱被拦住了」的硬证据：付费 LLM 一次都没被调用。
      expect(bootstrapStyleBible).not.toHaveBeenCalled();
    } finally {
      release(`bootstrap:${id}`);
    }
  });

  it('进程内守卫：成功后**立刻**再来一次 → 409，且付费 LLM 只被调用一次（双击不双倍付费）', async () => {
    // 这个 id 就是刚才那条用例的重写：`hold` 上线后原断言（「跑完后 acquire 必须 true」）
    // 本身成了缺陷。改成钉住新契约 —— 成功后立刻重复触发必须被冷却挡住，且**没有第二次付费**。
    const id = `${B}-guard-rel`;
    await mk(id, {});
    bsbMock.mockResolvedValueOnce({ artStyle: '自举出来的' });
    expect((await postRaw(JSON.stringify({ productId: id }))).status).toBe(200);
    const res2 = await postRaw(JSON.stringify({ productId: id }));
    expect(res2.status).toBe(409);
    expect((await res2.json() as any).error).toBe('该剧本正在生成中，请稍候再试');
    // 硬证据：付费 LLM 一次都没被第二次触发（mock 调用数是**本用例内**的，文件级 beforeEach
    // 的 `_debugResetGuard()` 不影响 mock，describe 里的 `vi.clearAllMocks()` 负责每用例归零）。
    expect(bsbMock.mock.calls.length).toBe(1);
  });

  it('进程内守卫：冷却到期后放行，且端点确实**释放**了 key（finally 里的 release）', async () => {
    // 补 (b)(c) 之外的一层：bootstrap 的 `hold` 在 try 内、`finally { release }` 在其后执行，
    // 是四个端点里唯一「release 跑在 hold 之后」的顺序。若 release 顺手把冷却也清了、
    // 或 finally 里根本没 release，这两条断言分别会红。
    const id = `${B}-guard-expiry`;
    await mk(id, {});
    bsbMock.mockResolvedValueOnce({ artStyle: '第一次' });
    expect((await postRaw(JSON.stringify({ productId: id }))).status).toBe(200);
    expect((await postRaw(JSON.stringify({ productId: id }))).status).toBe(409);   // 冷却在挡
    // **真等** 3.1s，不用 fake timers（本用例真读写 PG）。
    await new Promise(r => setTimeout(r, 3100));
    // 到期后能再进来 = 冷却过期 **且** key 已被 finally 释放（没释放 ⇒ 在飞挡着 ⇒ 永远 409）。
    bsbMock.mockResolvedValueOnce({ artStyle: '第二次' });
    expect((await postRaw(JSON.stringify({ productId: id }))).status).toBe(200);
  });

  it('进程内守卫：key 被占住时，非法请求仍拿 404 而不是 409（获取在 404 之后）', async () => {
    // 占位用的 key **就是**那个不存在的 productId —— 守卫若挪到读产品之前，这里会变 409。
    const missing = `${B}-guard-no-such`;
    expect(acquire(`bootstrap:${missing}`)).toBe(true);
    try {
      expect((await postRaw(JSON.stringify({ productId: missing }))).status).toBe(404);
    } finally {
      release(`bootstrap:${missing}`);
    }
  });
});
