/**
 * 素材生成成本计价（S3）。
 *
 * 单价**按 provider 取** —— 不同上游单价不同（Seedream ¥0.20 / 万相 ¥0.14），
 * 只留一个数的话，换 provider 时记账会静默错。
 * env 显式设置**优先于**内置默认：调价时改 .env，不改代码 ——
 * 让「记账口径」变成一次代码发布的副产品是不对的。
 *
 * 单位与 pms_bui_ai_usage 不同（那是 token），所以 S3 **不写**那张表（spec §6.1）。
 *
 * 默认值来自 2026-09-13 检索的官方价目（spec §1.2 / §6），**上线前仍须在控制台复核**。
 */
const IMAGE_DEFAULT: Record<string, number> = {
  seedream: 0.20,   // 字节 Seedream 4.0，元/张
  wanx: 0.14,       // 阿里通义万相 turbo，元/张
  // mock 刻意不在表里 —— 见 imageUnitPrice
};

/** 元/千字符，**按模型**。cosyvoice-v3-plus = ¥2/万字符（= ¥0.20/千字符）。
 *  写成表而不是单个常量：模型与单价是**同一次调价的两个面**，分成两处就一定会漂 ——
 *  生产实测已经把 BAILIAN_TTS_MODEL 覆盖成 v3-flash 而单价靠人工同步（见 NEW-08）。 */
const TTS_DEFAULT_BY_MODEL: Record<string, number> = {
  'cosyvoice-v3-plus': 0.20,
  'cosyvoice-v3-flash': 0.10,   // 官方 ¥1 上下/万字符量级
};
const TTS_FALLBACK = 0.20;

/**
 * 视频生成（Seedance）单价表，**按模型**，单位：元/百万 token（输出）。
 *
 * 来自火山方舟 2025-10 价目：
 *   - doubao-seedance-1.0-pro      → 15  元/百万 token
 *   - doubao-seedance-1.0-pro-fast → 4.2 元/百万 token
 *
 * token 估算公式（火山官方）：token = 宽 × 高 × 帧率 × 时长 / 1024。
 * 帧率固定 24 fps。cost = token / 1e6 × 单价。
 */
const VIDEO_DEFAULT_BY_MODEL: Record<string, number> = {
  'doubao-seedance-1-0-pro': 15,
  'doubao-seedance-1-0-pro-fast': 4.2,
};
const VIDEO_FALLBACK = 15; // 未知模型回落 pro 价并出声

/** 分辨率 → 短边像素（长边按比例算）。Seedance 1.0 支持 480p/720p/1080p。 */
const VIDEO_RESOLUTION_SHORT: Record<string, number> = {
  '480p': 480,
  '720p': 720,
  '1080p': 1080,
};
/** 宽高比 → (宽系数, 高系数)，由短边乘系数得长边。 */
const VIDEO_RATIO_FACTORS: Record<string, [number, number]> = {
  '16:9': [16, 9],
  '9:16': [9, 16],
  '1:1': [1, 1],
};
const VIDEO_FPS = 24; // Seedance 固定 24 fps

/**
 * 文本 LLM 的默认单价（元/千 token），qwen-max 档位，输入与输出**分开**。
 * 与 IMAGE_DEFAULT / TTS_DEFAULT_BY_MODEL 同级 —— **是拍板值不是查证值**，env 可覆盖。
 * 生产首次部署时应核对阿里云控制台的实际价目；不一致就设 env 覆盖。
 *
 * 为什么必须分两价：qwen-max 的输出价约为输入的 4 倍，合成一个均价会让「长输出短输入」
 * 的调用（分镜提示词正是这种）系统性少记 3 倍以上 —— 而账面数字看起来完全正常。
 */
const PROMPT_DEFAULT = { input: 0.0024, output: 0.0096 };

/**
 * env 单价的合理上界（元）。**这是业务合理性护栏，不是列宽护栏。**
 *
 * cost_amount 是 numeric(10,4)（上限 999999.9999），所以「会不会溢列」在本层
 * 挡住的其实是 1e308 那一档；本常量取 1e4（¥10000/张 或 ¥10000/千字符），
 * 比任何现实单价高 4–5 个数量级（Seedream ¥0.20、CosyVoice ¥0.20），是**刻意收紧**的：
 * env 手滑多打几个 0 时，宁可按默认价记并出声，也不要静默按一个荒谬单价把整批账记飞。
 *
 * ⚠️ 已知未覆盖：本层只约束**单价**，不约束 `count × 单价` 这个**乘积**。
 *    calcImageCost(5e6, 'seedream') = 1e6 仍会溢 numeric(10,4)。
 *    之所以不加乘积护栏：count 来自 planBatch 的任务条数（现实是个位到百位），
 *    要触发得一次规划 500 万条任务 —— 为不可达的场景加护栏只会引入新的静默路径。
 */
const MAX_UNIT_PRICE = 1e4;

/**
 * 同一个坏 env 值只出声一次。
 * `envPrice` 每次计价都会被调用（每个 job 至少一次），逐次告警会把日志刷爆，
 * 而刷爆的告警等于没有告警。
 */
const warnedEnv = new Set<string>();

function warnOnce(name: string, raw: string): void {
  const key = `${name}=${raw}`;
  if (warnedEnv.has(key)) return;
  warnedEnv.add(key);
  console.warn(
    `[wenlv-asset-gen] ${name} 的值「${raw}」不是有效单价（须为 0–${MAX_UNIT_PRICE} 的数字），本次按内置默认价记账`,
  );
}

/**
 * token 数非法时的同类去重告警。**与单价告警共用 `warnedEnv`**：去重键是
 * `WENLV_PROMPT_TOKEN_${label}=${raw}`，**含 raw 原值**，故同一类别下**不同**的非法值
 * 各响一次 —— 也就是同一 `(类别, 原值)` 组合只响一次（与 warnOnce 的「同一个坏 env **值**
 * 只出声一次」是同一种粒度）。但**文案必须另写**：warnOnce 那句说的是「按内置默认价记账」，
 * 而 token 非法时记的是 ¥0 —— 排障时这两句指向完全不同的根因，混用会把线索抹掉。
 */
function warnOnceToken(label: string, raw: string): void {
  const key = `WENLV_PROMPT_TOKEN_${label}=${raw}`;
  if (warnedEnv.has(key)) return;
  warnedEnv.add(key);
  console.warn(
    `[wenlv-asset-gen] LLM ${label} token 数「${raw}」不是有效数字（须为 ≥0 的有限数），本次按 0 记`,
  );
}

/** 读 env 解析成正数；未设/非法返回 null。**调用时读**，便于测试与运行时改。 */
function envPrice(name: string): number | null {
  // 必须 trim 后判空：`Number('  ')` 是 0（不是 NaN），`Number('')` 也是 0。
  // 只判 `=== ''` 的话，一个只含空白的 .env 值会被当成**显式定价 0**，
  // 静默变成「这批发图不要钱」—— 正是本模块要防的那类错。
  const raw = (process.env[name] ?? '').trim();
  if (raw === '') return null;                       // 未设：静默走默认，这是正常路径
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0 && n <= MAX_UNIT_PRICE) return n;
  // ⚠️ 设了但非法（'abc' / '-1' / '1e308' / '20000'）**必须出声**。
  // 静默回落 = 「本批按 ¥0.20 记」，而 `WENLV_IMAGE_UNIT_PRICE=20000` 这类手滑
  // 会让账目少记最高 10 万倍且**没有任何信号** —— 与本文件对未登记 provider、
  // 非数字张数一律出声是同一条口径。加了这个上界却不告警，等于把静默面**扩大**了。
  // 返回 null 而非抛错：记账失败不该把整批生成打挂（见 imageUnitPrice 的同款注释）。
  warnOnce(name, raw);
  return null;
}

export function imageUnitPrice(provider: string): number {
  const override = envPrice('WENLV_IMAGE_UNIT_PRICE');
  if (override !== null) return override;
  // mock 是占位 provider：它没向任何上游付费，给它定价就是**凭空造钱**。
  // 开发环境没配 key 时走 mock，报一个假的「本批花费 ¥2.8」比不报更糟。
  // 需要端到端验证记账链路时，用 WENLV_IMAGE_UNIT_PRICE 显式覆盖。
  // provider 可能来自 env / DB，带尾随空格或大小写不一致。不归一化就会以「未登记」
  // 落到 seedream 兜底价上（万相 ¥0.14 被记成 ¥0.20，虚高 43%），
  // 而唯一的信号是一行可能被日志采集丢掉的 warn。
  const p = String(provider ?? '').trim().toLowerCase();
  if (p === 'mock') return 0;
  // **必须用 hasOwnProperty 查**，不能只判 `IMAGE_DEFAULT[provider] !== undefined`：
  // 对象字面量带 Object.prototype，`IMAGE_DEFAULT['constructor']` 命中的是 Object 函数
  // （typeof function，不是 undefined），于是「未登记 provider」这条兜底被绕过 ——
  // 返回一个函数，`count * 函数` = NaN，而 NaN 正是本模块立志要防的东西。
  const known = Object.prototype.hasOwnProperty.call(IMAGE_DEFAULT, p)
    ? IMAGE_DEFAULT[p]
    : undefined;
  if (known !== undefined) return known;
  // 未知 provider 回落 seedream 价，但**必须出声**：静默回落等于「换了个更贵/更便宜的上游，
  // 账上却按 Seedream 记」，而本模块存在的全部意义就是不静默错。
  // 不抛错是因为记账失败不该把整批生成打挂 —— 出图的价值高于这条账。
  console.warn(`[wenlv-asset-gen] 未登记单价的 provider「${provider}」，暂按 seedream ¥${IMAGE_DEFAULT.seedream}/张 记账`);
  return IMAGE_DEFAULT.seedream;
}

export function ttsUnitPrice(model?: string): number {
  const env = envPrice('WENLV_TTS_UNIT_PRICE');
  if (env !== null) return env;                      // env 优先（调价不改代码）
  if (!model) return TTS_FALLBACK;                   // 老调用点：保持既有行为
  const m = String(model).trim().toLowerCase();
  // **必须用 hasOwnProperty 查**：对象字面量带 Object.prototype，
  // `TTS_DEFAULT_BY_MODEL['constructor']` 命中的是 Object 函数（不是 undefined）⇒
  // 返回一个函数，`charCount/1000 * 函数` = NaN。本文件 imageUnitPrice 上方有同款注释。
  const known = Object.prototype.hasOwnProperty.call(TTS_DEFAULT_BY_MODEL, m)
    ? TTS_DEFAULT_BY_MODEL[m]
    : undefined;
  if (known !== undefined) return known;
  console.warn(`[wenlv-asset-gen] 未登记单价的 TTS 模型「${model}」，暂按 ¥${TTS_FALLBACK}/千字符记账`);
  return TTS_FALLBACK;
}

export function promptInputUnitPrice(): number {
  return envPrice('WENLV_PROMPT_MODEL_INPUT_PRICE') ?? PROMPT_DEFAULT.input;
}

export function promptOutputUnitPrice(): number {
  return envPrice('WENLV_PROMPT_MODEL_OUTPUT_PRICE') ?? PROMPT_DEFAULT.output;
}

/**
 * 一次 LLM 调用的花费（元）。
 *
 * token 数非法一律按 0 记**并出声**（`warnOnceToken` 去重）：静默吞掉会让某类调用悄悄不记账，
 * 而「知道花了多少钱」正是 S3/S4 的交付判据。
 *
 * 与 calcImageCost / calcTtsCost 同口径（非法 → 出声记 ¥0），但有**两处刻意的差异**，
 * 别按「逐条一致」理解：
 *   1) 告警**去重**：兄弟函数用裸 `console.warn`，同批 100 个坏值就响 100 次；
 *      本函数走 `warnOnceToken`，同一 (类别, 原值) 只响 1 次（批量调用不刷日志）。
 *   2) **不短路零值**：兄弟函数先 `if (count === 0) return 0;`（不读 env）；
 *      本函数零 token 照样读两个 env 单价 —— 数值结果相同，但 env 非法时会因此多一条单价告警。
 */
export function calcPromptCost(inputTokens: unknown, outputTokens: unknown): number {
  const inTok = normalizeTokenCount('输入', inputTokens);
  const outTok = normalizeTokenCount('输出', outputTokens);
  return round4((inTok / 1000) * promptInputUnitPrice() + (outTok / 1000) * promptOutputUnitPrice());
}

/** 非有限数 / 负数 / 非数字 → 0 并出声。0 是合法值，静默通过。
 *  ⚠️ 左半边 `typeof v !== 'number'` 对**运行时行为**是冗余的（`Number.isFinite` 对字符串/null/
 *  undefined/`new Number(5)` 一律 false），但**不是死代码**：它是 `v: unknown` → `number` 的
 *  类型收窄来源。实测把它删掉跑 `tsc --noEmit` 会报两条：`v < 0` 处 TS18046、`return v` 处 TS2322。 */
function normalizeTokenCount(label: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    warnOnceToken(label, String(v));
    return 0;
  }
  if (v < 0) {
    warnOnceToken(label, String(v));
    return 0;
  }
  return v;
}

/** 保留 4 位小数，避免 JS 浮点尾巴写进 numeric(10,4)。
 *  注意这是**双精度**取整，不是十进制四舍五入 —— 两者在极少数边界上不同：
 *  env 单价若写到第 5 位小数（如 0.00015），每张可能差 1e-4。
 *  内置默认价（¥0.20 / ¥0.14）不受影响。 */
function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}

export function calcImageCost(count: number, provider: string): number {
  if (typeof count !== 'number' || !Number.isFinite(count)) {
    // 传进来不是有效数字（常见：从 JSON body 或 numeric 列拿到字符串 "3"）。
    // 静默记 0 就是「这批发图不要钱」—— 与上面未登记 provider 同一口径：出声。
    console.warn(`[wenlv-asset-gen] 图像张数不是有效数字（${typeof count}: ${String(count)}），本次按 ¥0 记账`);
    return 0;
  }
  if (count < 0) {
    // 负数不是「没有要计的账」，而是调用方算错了（待生成 - 已完成 的 off-by-one 之类）。
    // 静默记 0 会让这个 bug 无声消失 —— 与上面同一条口径。
    console.warn(`[wenlv-asset-gen] 图像张数为负（${count}），本次按 ¥0 记账`);
    return 0;
  }
  if (count === 0) return 0;
  return round4(count * imageUnitPrice(provider));
}

/** TTS 按**千字符**计价。`model` 透传给 `ttsUnitPrice`（不传则按兜底价）。 */
export function calcTtsCost(charCount: number, model?: string): number {
  if (typeof charCount !== 'number' || !Number.isFinite(charCount)) {
    console.warn(`[wenlv-asset-gen] 旁白字符数不是有效数字（${typeof charCount}: ${String(charCount)}），本次按 ¥0 记账`);
    return 0;
  }
  if (charCount < 0) {
    console.warn(`[wenlv-asset-gen] 旁白字符数为负（${charCount}），本次按 ¥0 记账`);
    return 0;
  }
  if (charCount === 0) return 0;
  return round4((charCount / 1000) * ttsUnitPrice(model));
}

/**
 * 视频生成单价（元/百万 token，输出）。
 * env `WENLV_VIDEO_UNIT_PRICE` 显式覆盖优先；否则按模型查表；未知模型回落 pro 价并出声。
 * 与 imageUnitPrice / ttsUnitPrice 同口径：mock 返回 0，未知 provider 出声后回落。
 */
export function videoUnitPrice(model?: string): number {
  const override = envPrice('WENLV_VIDEO_UNIT_PRICE');
  if (override !== null) return override;
  if (!model) return VIDEO_FALLBACK;
  // mock 是占位 provider：没向上游付费，定价即凭空造钱（与 imageUnitPrice 同口径）。
  const m = String(model).trim().toLowerCase();
  if (m === 'mock') return 0;
  // 模型名可能带版本后缀（如 doubao-seedance-1-0-pro-250528），按前缀匹配。
  const known = Object.keys(VIDEO_DEFAULT_BY_MODEL).find((k) => m.startsWith(k));
  if (known) return VIDEO_DEFAULT_BY_MODEL[known];
  console.warn(`[wenlv-asset-gen] 未登记单价的视频模型「${model}」，暂按 seedance pro ¥${VIDEO_FALLBACK}/百万 token 记账`);
  return VIDEO_FALLBACK;
}

/**
 * 一次视频生成的花费（元）。
 *
 * token 估算：宽 × 高 × 帧率 × 时长 / 1024（火山官方公式）。
 * 分辨率取短边，长边按 ratio 系数推算（保证短边 = 分辨率标称值）。
 *
 * 参数非法（duration ≤ 0、未知 resolution/ratio）按 ¥0 记并出声 ——
 * 与 calcImageCost / calcTtsCost 同口径，不静默吞掉记账。
 */
export function calcVideoCost(opts: {
  duration: number;
  resolution: string;
  ratio: string;
  model?: string;
}): number {
  const { duration, resolution, ratio, model } = opts;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0) {
    console.warn(`[wenlv-asset-gen] 视频时长非法（${String(duration)}），本次按 ¥0 记账`);
    return 0;
  }
  const short = VIDEO_RESOLUTION_SHORT[resolution];
  if (short === undefined) {
    console.warn(`[wenlv-asset-gen] 未知视频分辨率「${resolution}」，本次按 ¥0 记账`);
    return 0;
  }
  const factors = VIDEO_RATIO_FACTORS[ratio];
  if (factors === undefined) {
    console.warn(`[wenlv-asset-gen] 未知视频宽高比「${ratio}」，本次按 ¥0 记账`);
    return 0;
  }
  const [wFactor, hFactor] = factors;
  // 短边对齐：若宽系数 ≤ 高系数，宽 = short，高 = short × hFactor / wFactor；反之亦然。
  const [width, height] = wFactor <= hFactor
    ? [short, Math.round(short * hFactor / wFactor)]
    : [Math.round(short * wFactor / hFactor), short];
  const tokens = (width * height * VIDEO_FPS * duration) / 1024;
  return round4((tokens / 1_000_000) * videoUnitPrice(model));
}
