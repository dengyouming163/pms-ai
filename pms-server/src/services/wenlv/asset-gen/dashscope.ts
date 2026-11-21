/**
 * DashScope 兼容模式（OpenAI 形状）的**共享传输层**。
 *
 * 为什么单独一个文件：`callLlm`（文本）与 `callLlmVision`（看图）只差 5 个值
 * （model / messages / temperature / timeout / 失败文案），传输骨架、错误阶梯、
 * 用量读取**逐字相同**。两份副本的下场是「改一处忘一处」—— 尤其是那个
 * 「先取原始文本再解析」的排障手法，漏改的那一份会在网关返 HTML 错误页时
 * 把「限流 / 审核 / 配额 / 反代 / 结构变更」坍缩成同一句「HTTP 200」，运维分不清。
 *
 * ⚠️ `opts` 的字段**全部必填、刻意不给默认值**。这不是风格问题：若给 `temperature`
 *    默认 `0.3`，将来有人在 vision 调用里漏传它 ⇒ 静默继承生成温度，
 *    而**没有任何测试会红**（`run-once.db.test.ts` 只断言 '非 JSON' / '502 Bad Gateway'，
 *    `llm-vision.test.ts` 只断言 'body=' / 'HTTP 429'）—— 差异被抹平而全绿。
 *    必填 ⇒ 漏传是编译错误。
 */

/** DashScope 兼容模式端点。全仓**唯一**来源（换网关只改这一处）。 */
export const DASHSCOPE_CHAT_URL = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';

/**
 * 调 LLM 要一段文本，**并带回 token 用量**（用于计费）。
 *
 * ✅ 本仓 LLM 调用的 token 花费**已计入 `cost_amount`**（2026-09-18 起；此前是 spec §6 的分期缺口）。
 *    单价走 `pricing.ts` 的分价口径：`WENLV_PROMPT_MODEL_INPUT_PRICE` /
 *    `WENLV_PROMPT_MODEL_OUTPUT_PRICE`（两个 env 名，不是单一只价），未设时用
 *    `pricing.ts` 的 `PROMPT_DEFAULT`（input 0.0024 / output 0.0096 元/千 token）。
 *
 *    ⚠️ 分价的理由见 pricing.ts：qwen-max 输出价约为输入 4 倍，均价会让
 *       「长输出短输入」的分镜提示词系统性少记 —— 而账面数字看起来完全正常。
 *
 *    计入方式与落点（见 `wenlv-asset-gen-scheduler.ts`）：
 *      · 图片路径 —— `generateImageJob` 在既有的图片费自增里**一并**加 `calcPromptCost`，
 *        账落在同一个 job 行上（复用 prompt 等不调 LLM 的路径上 `llm` 为 null ⇒ 记 0）。
 *      · 自举路径 —— `bootstrapStyleBible` 落一行 `batchId='stylebible:<productId>'` 的
 *        **合成 job** 来记这一路的账（`cost_amount` 全库只存在于 job 表，没有批次表）。
 *        成功记 `succeeded`；`parseStyleBible` **解析失败**时另落一行 `failed`（同批次，
 *        2026-09-20 起）—— 那一次**已经付过**的 token 费同样进账。两行同批次 ⇒
 *        该产品的自举总额 = 批次内全部行的 SUM。
 */
export interface LlmResult {
  text: string;
  /** 上游 `usage.prompt_tokens`。缺失 / 非数一律 0 —— 见 readUsage 的注释。 */
  inputTokens: number;
  outputTokens: number;
}

/**
 * 用量从响应体 `data.usage` 取：
 *   - 正常路径（DashScope 兼容模式）一定带 `usage.prompt_tokens` / `usage.completion_tokens`；
 *   - 拿不到时一律记 **0 并保持返回结构不变** —— 抛错会让一次**已经付过钱**的调用
 *     连图和文本一起丢掉，比少记一条账糟得多（与 pricing.ts「记账失败不该打挂生成」同一口径）。
 *     ⚠️ 但「静默 0」正是本项目最怕的失败模式，所以这里**必须** `console.warn` 一次，
 *     让「账上这个批次便宜得反常」有迹可循。
 */
function readUsage(data: any, key: 'prompt_tokens' | 'completion_tokens'): number {
  const v = data?.usage?.[key];
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  console.warn(`[wenlv-asset-gen] LLM 响应缺少有效的 usage.${key}（拿到 ${JSON.stringify(v)}），本次 token 花费按 0 记`);
  return 0;
}

/**
 * 发一次 DashScope 兼容模式对话请求，返回文本 + 用量。
 *
 * 取值 + 排障口径（两条承重的约定）：
 *   · **先取原始文本再解析**：`res.json()` 会把解析错误吞掉，于是
 *     「200 + 网关 HTML 错误页」与「200 + content 为空」坍缩成同一句「HTTP 200」
 *     —— 运维分不清限流 / 审核 / 配额 / 反代 / 结构变更。这里保住原始 body，
 *     拼进错误文本的 `body=` 里。
 *   · **content 必须是字符串**：部分 OpenAI 兼容后端会把 `message.content` 返成
 *     parts 数组。数组是 truthy，光靠 `!text` 判不出来，`String(text)` 会产出
 *     `[object Object]` / 逗号拼接的**假结果**（对评审路径尤其致命：一个假评审分）。
 *     故非字符串一律走诊断抛错分支。（这是「无条件强转」的加固，**不是**已证实的
 *     DashScope 行为 —— 尚未观察到它返数组。）
 */
export async function callDashScope(opts: {
  model: string;
  messages: unknown;
  temperature: number;
  timeoutMs: number;
  /** 错误文本前缀，如「LLM 调用失败」/「视觉调用失败」。 */
  failLabel: string;
  /** 缺 DASHSCOPE_API_KEY 时的错误文案（两条路径的措辞不同）。 */
  missingKeyHint: string;
}): Promise<LlmResult> {
  const key = (process.env.DASHSCOPE_API_KEY || '').trim();
  if (!key) throw new Error(opts.missingKeyHint);
  const res = await fetch(DASHSCOPE_CHAT_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${key}` },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages,
      temperature: opts.temperature,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs),
  });
  const status = res.status;
  const raw = await res.text().catch(() => '');
  let data: any = {};
  let parsed = true;
  try {
    data = JSON.parse(raw);
  } catch {
    parsed = false;
  }
  const text: unknown = data?.choices?.[0]?.message?.content;
  if (!res.ok || typeof text !== 'string' || text === '') {
    const detail = data?.error?.message
      || (!parsed
        ? '上游返回非 JSON（疑似网关/反代错误页）'
        : res.ok
          ? (text == null || text === ''
            ? '响应里没有 choices[0].message.content'
            : `choices[0].message.content 不是字符串（收到 ${Array.isArray(text) ? 'array' : typeof text}）`)
          : '(无错误字段)');
    throw new Error(`${opts.failLabel}：HTTP ${status} ${detail} body=${raw.slice(0, 200)}`);
  }
  return {
    text,
    inputTokens: readUsage(data, 'prompt_tokens'),
    outputTokens: readUsage(data, 'completion_tokens'),
  };
}
