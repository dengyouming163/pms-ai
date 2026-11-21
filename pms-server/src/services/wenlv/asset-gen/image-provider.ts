/**
 * 文生图 provider（S3）：字节 Seedream 4.0（火山方舟）。
 *
 * 选型理由见 spec §1.2：**图片用字节，文本与语音留阿里**。
 * 单价差 ¥0.06/张（一个场地差约 ¥0.9），但 Seedream 支持**参考图** ——
 * 这是把防漂移从「文本约束」升级为「视觉锚定」的关键，值这个钱。
 *
 * ⚠️ pms-ai-crew 里另有一份 Python 骨架 `pms-ai-crew/src/services/wenlv_image.py`（已核实零调用方）。
 *    S3 **不接线**那一份：OSS 转存与资源库落库都在 pms-server，
 *    走 Python 要多一条跨服务回写链路。
 *
 * **契约是同步的**（spec §5.2）：resolve 即素材就绪。
 * 上游若本身异步（如 Seedance 视频，`/contents/generations/tasks`），
 * 由 provider 内部轮询消化，**不让这个复杂性漏进调度器**。
 */
/**
 * 同步结果：urls 到手即素材就绪，没有中间态，故不需要任务 id 字段。
 *
 * 一次生成的产物。**字段名是复数** —— 子项目① 起，一次调用可能出多张
 *（方舟 `sequential_image_generation`）。存量调用点用 `urls[0]`。
 */
export type GenResult = { urls: string[]; provider: string; model: string };

export type GenOptions = {
  assetType: string;
  /**
   * **本次实际要发出去的参考图**，顺序即入参顺序（锚图在前）。
   *
   * ⚠️ 张数上限**不由本层保证**（`candidates.ts` 不读这个数组）：它是 Task 10 的
   *    调用方把准确的 `availableRefs` 传给 `resolveCandidateCount` 的**后果**，
   *    而本层**不校验**（生产调用方 scheduler 现在会传最多 8 张：锚图 1 + 图集 ≤6 + 涂鸦 1，
   *    见 scheduler 的 `refs` 构造）。
   */
  referenceUrls?: string[];
  /** 要出几张候选，默认 1。1 时不带 sequential 字段，保持与既有单图路径逐字节一致。 */
  candidates?: number;
};

export interface ImageProvider {
  readonly name: string;
  generate(prompt: string, opts: GenOptions): Promise<GenResult>;
}

/**
 * 抛给上层的生成失败错误。带上两个张数，因为**只有 provider 知道**上游实际产出了几张：
 * 上层拿到错误时只能看到消息文本，而消息里那句「(N 张 URL 形态非法)」里的 N 是
 * **被拒收**的张数，不是**实际产出**的张数 —— 拿它计费会把「少算」变成「按错的数少算」。
 *
 * 消费方：`wenlv-asset-gen-scheduler.ts` 的 `generateImageJob` catch —— 上游已产出 = 钱已经花了，
 * 拿到 `producedCount` 就补记这一笔（此前那条路径**不记账**，是代码里自陈的「已知账面缺口 T-I」）。
 */
export class ImageGenError extends Error {
  readonly producedCount: number;   // 上游实际返回的 URL 张数（= 真的会计费的张数）
  readonly rejectedCount: number;   // 其中被我们判为非法的张数
  constructor(message: string, producedCount: number, rejectedCount: number) {
    super(message);
    this.name = 'ImageGenError';
    this.producedCount = producedCount;
    this.rejectedCount = rejectedCount;
  }
}

/**
 * 单张的墙钟预算。多张按线性放宽 —— 上游是顺序解码，不是并行。
 *
 * 同步接口，且图片比文本慢得多，给足时间。
 * 导出供测试断言量级：调成 50ms 之类的值会让几乎每一次真实请求都超时，
 * 而该分支此前没有任何用例看守。
 */
export const TIMEOUT_MS = 120_000;

/** 占位 provider：无 key 时的回退。产物是占位图，**不静默**（spec §8）。 */
export class MockImageProvider implements ImageProvider {
  readonly name = 'mock';

  async generate(prompt: string, opts: GenOptions): Promise<GenResult> {
    // 刻意用 placeholder.local：一眼能看出是占位图，不会被误当真实产物
    const q = encodeURIComponent(prompt.slice(0, 32));
    // 与 ArkImageProvider 同一条规则：纯空白串是「没有参考图」，不是「参考图是一个空格」。
    // 两边不一致会让基于 mock 的人工判据报出一个真实 provider 根本不会发的参考图标记。
    const ref = (opts.referenceUrls ?? []).some((u) => u.trim()) ? '&ref=1' : '';
    // assetType 必须编码：`#` 之后会被当成 fragment（`?q=` 标记直接消失，人工判据静默失效），
    // `<>` 也会原样落库。
    const assetType = encodeURIComponent(opts.assetType);
    // 候选数用计划字面，**不做 clamp**：`Math.max(1, NaN)` 仍是 NaN、也挡不住 Infinity，
    // 只会让本层与 candidates.ts（对同一批非法入参**故意抛错**）持相反政策。
    const n = opts.candidates ?? 1;
    // ⚠️ 非法候选数下本方法与 Ark **形态分叉**（如实记录，不修）：
    //    ① `candidates < 1` 时这里返回 **0 张**（`Array.from({ length: 0 })`），
    //       而 Ark 走普通单图请求、返回上游真实结果 **1 张**；
    //    ② 这条路径**不可达** —— 唯一的生产调用方（scheduler）传进来的 `candidates` 是
    //       `resolveCandidateCount(requested, refs.length)` 的**返回值**，而该函数对
    //       `requested < 1`（及非整数）先抛错 ⇒ 走到本层时必为 ≥1 的整数；
    //    ③ **不要**在这里加 clamp 「修」它：那会让本层与 `candidates.ts` 对同一批非法值
    //       持相反政策（见上一段），正是前一轮删掉的东西。
    // 每张一个**不同的** URL（下标标记）。真实 provider 返回的就是 N 个不同地址；
    // 若这里是同一个 URL 的 N 份拷贝，任何按 URL 去重 / 按 URL 生成 OSS 对象名 /
    // 数「不同素材数」的逻辑，在 mock 下与生产下行为就不同 —— 正是「形状要与真实
    // provider 一致」要防的事。
    return {
      urls: Array.from({ length: n }, (_, i) =>
        `https://placeholder.local/${assetType}?q=${q}${ref}&cand=${i}`),
      provider: 'mock',
      model: 'mock',
    };
  }
}

/**
 * 字节 Seedream provider（火山方舟，OpenAI 兼容风格）。
 *
 * ⚠️ 首次真实联调时**以方舟控制台与官方文档为准**核对四处：
 *    模型 ID（`doubao-seedream-4-0-250828` 是 2026-09 检索值）、
 *    `size` 取值、`response_format` 是否被接受、
 *    以及参考图 `image` 字段接受的形态（单张字符串 / 多张数组 —— 本实现按「单张发字符串、
 *    多张发数组、空数组不传该键」发送，**这三种形态上游各自如何解释尚未真跑验证**）。
 *    已知坑：方舟对 OpenAI 专属参数（`n` / `quality` / `style`）会报 400，
 *    故本实现**只传必要字段**。判据 5/12 会真跑，届时以实测为准修正。
 */
export class ArkImageProvider implements ImageProvider {
  readonly name = 'seedream';

  // 读时取 env（不是构造时）—— 便于测试与运行时改配置
  private apiKey(): string {
    return (process.env.ARK_API_KEY || '').trim();
  }
  private model(): string {
    // 先取再判空：纯空白串是 truthy，`||` 不兜底，trim 后会变成 `''` ——
    // 于是实际发给上游 `model: ""`，而配置看起来「明明设了」。
    const v = (process.env.WENLV_IMAGE_MODEL ?? '').trim();
    return v || 'doubao-seedream-4-0-250828';
  }
  // 同样读时取：base 写死在模块顶层的话，进程启动后改 env 就不生效了
  // （测试里要指向本地假端点，或临时切到海外区时会被坑），也与本文件「读时取」的约定一致。
  private base(): string {
    const v = (process.env.ARK_BASE_URL ?? '').trim();
    // 末尾斜杠要去掉，否则拼出 `//images/generations`，不少网关按不同路径处理 → 404。
    return (v || 'https://ark.cn-beijing.volces.com/api/v3').replace(/\/+$/, '');
  }

  /**
   * 按候选数放宽墙钟预算：120s + 60s × (N-1)。
   * N = 1 时 120s（与既有完全一致），N = 4 时 300s；
   * **N < 1 或非有限值（NaN / ±Infinity）一律按 1 张处理**，即 120s。
   * 不放宽的话多图必被自己的超时切断，**而钱已经花了**。
   */
  static timeoutFor(candidates: number): number {
    // 入参非法时退回基准预算：本层**不是**校验层（配额算式 candidates.ts 负责校验并在非法时抛错），
    // 这里只保证不产出 `AbortSignal.timeout(NaN)` —— 那会抛 RangeError，被下面 fetch 的 catch
    // 标成「网络」失败，在本文件这个以诊断为唯一目的的地方给出错误的失败类别。
    // `Math.max(1, NaN)` 仍是 NaN，故必须用 `Number.isFinite` 判定。
    const n = Number.isFinite(candidates) ? Math.max(1, candidates) : 1;
    return TIMEOUT_MS + 60_000 * (n - 1);
  }

  async generate(prompt: string, opts: GenOptions): Promise<GenResult> {
    const key = this.apiKey();
    if (!key) {
      // 不静默降级：上层要能把这个错误写进 error_message
      throw new Error('未配置 ARK_API_KEY，无法调用 Seedream');
    }
    // model 只读一次，body 与返回值共用 —— 否则在 await fetch 期间改 env，
    // 会让返回的 model 与实际调用上游的模型不一致，往 job 表落一条假记录
    //（而那张表存在的意义正是「事后能回答这张图当时用什么生成的」）。
    const model = this.model();
    const url = `${this.base()}/images/generations`;
    const body: Record<string, unknown> = {
      model,
      prompt,
      size: '2K',
      response_format: 'url',
      watermark: false,   // 平台水印会毁掉素材
    };
    // 参考图 = 防漂移的落点。本层**确定**的事实只有一条：空白串被丢弃、不进请求体
    // （trim + filter(Boolean)）—— 空白串必须当作「没有参考图」，不是「参考图是一个空格」。
    // 单张发字符串 / 多张发数组 / 空数组**完全不传 image 键**：形态是本层自定的策略，
    // 上游各自如何解释尚未真跑验证，见类注释顶上那条 caveat。
    const refs = (opts.referenceUrls ?? []).map((u) => u.trim()).filter(Boolean);
    if (refs.length === 1) body.image = refs[0];
    else if (refs.length > 1) body.image = refs;
    // 候选数 >1 才带多图字段：=1 时保持与既有单图路径**逐字节一致**的请求体，
    // 免得给一条已在生产跑通的路径引入无谓的变量。
    // 用计划字面、**不做 clamp**（clamp 对 NaN 无效且与 candidates.ts 的政策相反）。
    // ⚠️ `timeoutFor` 兜的**只是 abort delay**，不是 `candidates` 本身：本层**完全不校验**
    //    `candidates`，非法值会被原样发出去 —— 例如 `Infinity` 经 `JSON.stringify` 变成
    //    `max_images: null`（JSON 没有 Infinity 字面量），到上游才报错。校验职责在
    //    `candidates.ts`（`resolveCandidateCount` 对非整数 / <1 抛错），本层只保证
    //    不产出非法的 abort delay。
    const n = opts.candidates ?? 1;
    if (n > 1) {
      body.sequential_image_generation = 'auto';
      body.sequential_image_generation_options = { max_images: n };
    }
    // ⚠️ 绝不传 OpenAI 的 `n` / `quality` / `style` —— 方舟对它们一律 400。

    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
        body: JSON.stringify(body),
        // 同步接口，且图片比文本慢得多，给足时间；多张还要再放宽（见 timeoutFor）
        signal: AbortSignal.timeout(ArkImageProvider.timeoutFor(n)),
      });
    } catch (e: any) {
      // 网络层失败必须把 URL 与 cause 上的诊断码带出来：
      // undici 的 `fetch failed` 只有四个字，真正的 ENOTFOUND / ECONNREFUSED 在 e.cause 上，
      // 而 error_message 只落 e.message —— 不织进去就永远看不到。
      const c = e?.cause ?? e;
      const kind = c?.name === 'TimeoutError' ? '超时' : '网络';
      throw new Error(`文生图失败（${kind}）：${url} ${c?.code ?? ''} ${c?.message ?? e?.message ?? String(e)}`.trim());
    }

    // 先取原始文本再解析：`res.json()` 会把解析错误吞掉，
    // 于是「200 + 网关 HTML 错误页」与「200 + data 为空」坍缩成同一句「失败：200」，
    // 运维无从判断是反代、审核还是返回结构变了。
    const status = res.status;
    const raw = await res.text().catch(() => '');
    let data: any = {};
    let parsed = true;
    try {
      data = JSON.parse(raw);
    } catch {
      parsed = false;
    }

    // 只认真实 http(s) URL：上游把 url 序列化成字符串 "null" / " " 时必须算失败，
    // 否则 job 记 succeeded、素材库里躺一个取不到的图，全链路没有一处报警。
    // ⚠️ 逐张校验协议，**不是** `filter(Boolean)` —— `filter(Boolean)` 会把 `'null'`、`' '`
    //    当合法 URL 收下，正是上面那条防护要挡的。
    // `Array.isArray` 不是冗余：data 可能是对象/字符串（网关错误页的合法 JSON），
    // 直接 `.map` 会抛 TypeError，把「HTTP 状态 / detail / body 摘录」这套诊断换成
    // 一句 `data.map is not a function`。非数组一律当「零张」处理，走下面同一句错误。
    const arr: any[] = Array.isArray(data?.data) ? data.data : [];
    const rawUrls: string[] = arr.map((d: any) => (typeof d?.url === 'string' ? d.url.trim() : ''));
    const urls = rawUrls.filter((u) => /^https?:\/\//i.test(u));
    const malformed = rawUrls.length - urls.length;

    // 判失败的三类，**共用既有那句错误消息**（保留 HTTP 状态 / detail / body 摘录）：
    //   ① `!res.ok`：状态码优先于形态
    //   ② `urls.length === 0`：一张合法 URL 都没有（含 data 为空数组）
    //   ③ `malformed > 0`：**有任意一张形态非法就整条失败**，不静默丢弃 ——
    //      丢了它，落库张数会少于上游实际返回数，而成本核对正是靠张数。
    //      （「上游少返回」是另一回事：那不算错，以实际张数为准、不补空位。）
    if (!res.ok || urls.length === 0 || malformed > 0) {
      const detail = data?.error?.message || data?.message
        || (parsed ? '(无错误字段)' : '上游返回非 JSON（疑似网关/反代错误页）');
      // 张数挂在错误对象上抛给上层（计费用）。**只有本层知道**这两个数：
      //   · producedCount = **原始数组长度**（`rawUrls`，不是过滤后的 `urls`）——
      //     两者之差正是被拒收的张数，拿 `urls.length` 计费会从「少算」变成「按错的数少算」。
      //   · 非 2xx 一律记 0：状态码优先于形态（见上面 ①）。403/429 那种错误信封里
      //     即便恰好带着 data.url，也不是上游的产物；按它计费等于一次被拒的请求
      //     被记成「上游出了 N 张」——凭空造钱，并顺带吃掉批次熔断的额度。
      //     （`!res.ok` 且 data 为空是生产上的常态，那时两者本就都是 0。）
      const produced = res.ok ? rawUrls.length : 0;
      const rejected = res.ok ? malformed : 0;
      throw new ImageGenError(
        `文生图失败：HTTP ${status} ${detail} body=${raw.slice(0, 200)}` +
        (malformed > 0 ? `（${malformed} 张 URL 形态非法）` : ''),
        produced, rejected,
      );
    }

    // provider 取自 this.name（单一事实源），不写字面量 —— 写死会让标签与类名各自漂移。
    // 这个标签是有账务后果的：pricing.ts 对 provider === 'mock' 的单价记 0，
    // 真 provider 若错报成 'mock'，真实出图会被记成 ¥0（「凭空造钱」）。
    return { urls, provider: this.name, model };
  }
}

/** 按 env 选择 provider；未配置时回落 mock。 */
export function getImageProvider(): ImageProvider {
  const raw = process.env.WENLV_IMAGE_PROVIDER;
  // 归一化大小写：`ARK` / `Seedream` 这类写法必须能命中，否则会静默退回 mock ——
  // 那意味着整批出的是占位图、账上记 ¥0、状态却全是 succeeded，而没有任何告警。
  const name = (raw ?? '').trim().toLowerCase();
  if (name === 'ark' || name === 'seedream') return new ArkImageProvider();
  if (name === '' || name === 'mock') return new MockImageProvider();
  // 非空但不认识 → 一定是拼错了（如 'seedream4' / 'volc' / 'doubao'）。
  // 必须出声：静默用 mock 等于「以为生成了真素材，实际是占位图且没花钱」。
  console.warn(`[wenlv-asset-gen] 未识别的 WENLV_IMAGE_PROVIDER「${raw}」，已回落 mock（不产生真实素材、记账 ¥0）`);
  return new MockImageProvider();
}
