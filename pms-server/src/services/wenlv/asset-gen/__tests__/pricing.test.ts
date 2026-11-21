import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  imageUnitPrice, ttsUnitPrice, calcImageCost, calcTtsCost, calcPromptCost,
} from '../pricing.js';

// 收尾清理的**逐行实测结论**（别再用一句「都是冗余/都必需」糊过去，两种说法都不全对）：
//   • `delete process.env.WENLV_IMAGE_UNIT_PRICE;` —— **有 bite，删不得**。实测单独删掉它
//     即 3 failed：前序用例留下的 '9' / '0.333333' 会漏进后面三条期望默认价的用例。
//   • `delete process.env.WENLV_TTS_UNIT_PRICE;` —— 当前用例集下**惰性**（单独删仍 26 passed），
//     但与上一行同类、成本为零，保留作对称防御。
//   • `vi.unstubAllEnvs()` + 两条 prompt delete —— 当前**也惰性**：单独删、两两删、三条一起删
//     都仍 26 passed，因为每个依赖默认价的用例都自己 stub 了它要读的那个变量。
//     留着是防将来新增用例读到未 stub 的变量；但别指望它重置模块级状态 ——
//     warnedEnv 这类模块级 Set 它清不掉（vi.clearAllMocks 也清不掉）。
afterEach(() => {
  delete process.env.WENLV_IMAGE_UNIT_PRICE;
  delete process.env.WENLV_TTS_UNIT_PRICE;
  // 文本 LLM 的用例走 vi.stubEnv（本身可还原），这两行 delete 目前是冗余的那一半。
  vi.unstubAllEnvs();
  delete process.env.WENLV_PROMPT_MODEL_INPUT_PRICE;
  delete process.env.WENLV_PROMPT_MODEL_OUTPUT_PRICE;
});

describe('成本计价（纯函数）', () => {
  it('按 provider 取单价 —— 换上游时记账不会静默错', () => {
    expect(imageUnitPrice('seedream')).toBe(0.2);
    expect(imageUnitPrice('wanx')).toBe(0.14);
  });

  it('env 显式覆盖优先于内置默认', () => {
    process.env.WENLV_IMAGE_UNIT_PRICE = '9';
    expect(imageUnitPrice('seedream')).toBe(9);
    expect(imageUnitPrice('wanx')).toBe(9);   // 覆盖对所有 provider 生效
  });

  it('mock 不计费 —— 占位图没向任何上游付钱', () => {
    // 若给 mock 也定价，开发环境没配 key 时会报一个假的「本批花费 ¥2.8」，
    // 比不报更糟。需要端到端验证记账时用 env 显式覆盖（见下一条与 Task 9）。
    expect(imageUnitPrice('mock')).toBe(0);
    expect(calcImageCost(5, 'mock')).toBe(0);
  });

  it('图像按张计价', () => {
    expect(calcImageCost(3, 'seedream')).toBe(0.6);
  });

  it('TTS 按千字符计价（CosyVoice-v2 官方 ¥2/万字符 = ¥0.2/千字符）', () => {
    expect(ttsUnitPrice()).toBe(0.2);
    expect(calcTtsCost(1500)).toBe(0.3);
    expect(calcTtsCost(100)).toBe(0.02);
  });

  it('金额保留 4 位小数（写进 numeric(10,4)）', () => {
    process.env.WENLV_IMAGE_UNIT_PRICE = '0.333333';
    expect(calcImageCost(1, 'seedream')).toBe(0.3333);
  });

  it('数量为 0 静默返回 0；负数是调用方 bug，出声返回 0', () => {
    // 0 张图真的不要钱 —— 静默是对的。
    // ⚠️ 下面这两句是**恒真**的（0 × 单价 = 0），删掉守卫它们照样绿；
    // 真正有 bite 的是后面那几条负数。
    expect(calcImageCost(0, 'seedream')).toBe(0);
    expect(calcTtsCost(0)).toBe(0);
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (m?: unknown) => { warns.push(String(m)); };
    try {
      // 没有守卫时 calcImageCost(-1, 'seedream') 返回 -0.2，
      // 拼进 `cost_amount = cost_amount + (-0.2)::numeric`，直接冲减记账总额。
      expect(calcImageCost(-1, 'seedream')).toBe(0);
      expect(calcImageCost(-0.5, 'wanx')).toBe(0);
      expect(calcTtsCost(-5)).toBe(0);
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(3);
  });

  it('provider 两侧空白不该按别的价记账', () => {
    // 'wanx ' 不归一化会落到 seedream 兜底价（0.20），万相实际是 0.14 —— 虚高 43%。
    expect(imageUnitPrice('wanx ')).toBe(0.14);
    expect(imageUnitPrice(' wanx')).toBe(0.14);
    expect(imageUnitPrice('WANX')).toBe(0.14);
  });

  it('张数/字符数不是有效数字时出声记 0，不静默变成「这批不要钱」', () => {
    // 本仓 numeric 列默认 string mode，调用方从 JSON body 拿到 "3" 是很现实的。
    // 静默记 ¥0 = 账上看不见这批发图，与未登记 provider 同一类错。
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (m?: unknown) => { warns.push(String(m)); };
    try {
      expect(calcImageCost('3' as unknown as number, 'seedream')).toBe(0);
      expect(calcTtsCost('1500' as unknown as number)).toBe(0);
      expect(calcImageCost(null as unknown as number, 'seedream')).toBe(0);
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(3);
  });

  it('非法单价回落默认值，不变成 NaN 污染全表', () => {
    process.env.WENLV_IMAGE_UNIT_PRICE = 'abc';
    expect(imageUnitPrice('seedream')).toBe(0.2);
    process.env.WENLV_IMAGE_UNIT_PRICE = '-1';
    expect(imageUnitPrice('seedream')).toBe(0.2);
  });

  it('荒谬的 env 单价按非法处理，回落默认（与 abc / -1 同一条路）', () => {
    // 没有上界的话 `WENLV_IMAGE_UNIT_PRICE=1e308` 会被当成合法单价一路传到
    // numeric(10,4) 才炸，而同样手滑写 'abc' 却安静回落 —— 同一个类别的错不该两种待遇。
    process.env.WENLV_IMAGE_UNIT_PRICE = '1e308';
    expect(imageUnitPrice('seedream')).toBe(0.2);
    process.env.WENLV_TTS_UNIT_PRICE = '1e308';
    expect(ttsUnitPrice()).toBe(0.2);
  });

  it('env 单价上界被钉住：恰好 10000 接受，10001 回落默认', () => {
    // 没有这一对边界，把 1e4 改成 1e5 也会全绿 —— 上界就成了没人守的常数。
    process.env.WENLV_IMAGE_UNIT_PRICE = '10000';
    expect(imageUnitPrice('seedream')).toBe(10000);
    process.env.WENLV_IMAGE_UNIT_PRICE = '10001';
    expect(imageUnitPrice('seedream')).toBe(0.2);
  });

  it('超范围的 env 单价出声回落，且同一个坏值只响一次（不刷屏）', () => {
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (m?: unknown) => { warns.push(String(m)); };
    try {
      process.env.WENLV_TTS_UNIT_PRICE = '20000';
      expect(ttsUnitPrice()).toBe(0.2);
      expect(ttsUnitPrice()).toBe(0.2);   // 第二次调用不应再告警
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(1);
    expect(warns[0]).toContain('WENLV_TTS_UNIT_PRICE');
  });

  it('mock 也能被 env 显式定价 —— 端到端验记账链路时的唯一开关', () => {
    // imageUnitPrice 先看 env 覆盖、再看 provider，所以 mock 也能定价。
    // 一旦有人调换这两步的顺序，这条路会静默消失。
    process.env.WENLV_IMAGE_UNIT_PRICE = '0.2';
    expect(calcImageCost(5, 'mock')).toBe(1);
  });

  it('0 张图不触发单价查询 —— 未登记 provider 也不会因为一张都不出而告警', () => {
    // 让 `if (count === 0) return 0;` 真正有 bite：删掉它，imageUnitPrice 会被调用
    // 并对未登记 provider 告警（warns.length 从 0 变 1）。
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (m?: unknown) => { warns.push(String(m)); };
    try {
      expect(calcImageCost(0, 'some-future-provider')).toBe(0);
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(0);
  });

  it('只含空白的 env 视为未设，而不是「显式定价 0」', () => {
    // Number('  ') 是 0 不是 NaN。只判 raw === '' 的话，一个空白值会被读成
    // 「这批发图不要钱」，静默漏记全部成本 —— 正是本模块要防的那类错。
    process.env.WENLV_IMAGE_UNIT_PRICE = '  ';
    expect(imageUnitPrice('seedream')).toBe(0.2);
    process.env.WENLV_TTS_UNIT_PRICE = '\t';
    expect(ttsUnitPrice()).toBe(0.2);
  });

  it('未登记单价的 provider 回落 seedream 价，且出声告警', () => {
    // 静默回落 = 「换了上游，账上却按 Seedream 记」。出声是这条兜底的全部价值。
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (m?: unknown) => { warns.push(String(m)); };
    try {
      expect(imageUnitPrice('some-future-provider')).toBe(0.2);
      // 只有**恰好**等于 mock 才免费：宽松匹配（startsWith / 正则）会让 'mock-v2' 这种
      // 付费 provider 也白送 ¥0，且**一声不吭** —— 比静默回落更隐蔽。
      expect(imageUnitPrice('mock-v2')).toBe(0.2);
    } finally {
      console.warn = orig;
    }
    expect(warns.length).toBe(2);
    // 按下标取会与语句顺序耦合：调换上面两行的先后就会报假红。
    // 这两条断言关心的是「两个值都被告警了」，与顺序无关。
    const all = warns.join('\n');
    expect(all).toContain('some-future-provider');
    expect(all).toContain('mock-v2');
  });

  it('**原型链上的名字不能被当成 provider** —— 否则绕过兜底直接产出 NaN', () => {
    // IMAGE_DEFAULT 是对象字面量，带 Object.prototype。只判 `IMAGE_DEFAULT[p] !== undefined`
    // 的话，'constructor' 命中 Object 函数（typeof function，不是 undefined），
    // 于是既不进 warn 兜底、又返回一个函数，count * 函数 = NaN —— 正好污染 cost_amount。
    const orig = console.warn;
    console.warn = () => { /* 静音：下面只断言数值 */ };
    try {
      expect(imageUnitPrice('constructor')).toBe(0.2);
      expect(calcImageCost(1, 'constructor')).toBe(0.2);
      expect(imageUnitPrice('toString')).toBe(0.2);
      expect(imageUnitPrice('__proto__')).toBe(0.2);
    } finally {
      console.warn = orig;
    }
  });

  it('非有限数入参返回 0，不把 NaN/Infinity 写进 cost_amount', () => {
    expect(calcImageCost(Number.NaN, 'seedream')).toBe(0);
    expect(calcImageCost(Number.POSITIVE_INFINITY, 'seedream')).toBe(0);
    expect(calcTtsCost(Number.NaN)).toBe(0);
    expect(calcTtsCost(Number.POSITIVE_INFINITY)).toBe(0);
  });

  it('单价随模型走，且未知模型出声（判别力：无 model 参数实现会红）', () => {
    expect(ttsUnitPrice('cosyvoice-v3-plus')).toBeCloseTo(0.20, 6);
    expect(ttsUnitPrice('cosyvoice-v3-flash')).toBeCloseTo(0.10, 6);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const p = ttsUnitPrice('some-unknown-model');
    expect(Number.isFinite(p)).toBe(true);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('大小写 / 空白不改变命中的单价（判别力：不归一化则 v3-flash 被记成 0.20，静默虚高 2 倍）', () => {
    expect(ttsUnitPrice(' CosyVoice-V3-Flash ')).toBeCloseTo(0.10, 6);
  });

  it('表内建的键名不得穿过「未登记」兜底（Object.prototype 继承陷阱）', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    for (const evil of ['constructor', 'toString', 'hasOwnProperty', '__proto__']) {
      const p = ttsUnitPrice(evil);
      expect(Number.isFinite(p)).toBe(true);
      expect(typeof p).toBe('number');
    }
    warn.mockRestore();
    expect(ttsUnitPrice('cosyvoice-v3-flash')).toBeCloseTo(0.10, 6);   // 对照：查表整体未失效
  });

  it('env 单价优先于内置表（与 imageUnitPrice 同级口径）', () => {
    vi.stubEnv('WENLV_TTS_UNIT_PRICE', '0.33');
    expect(ttsUnitPrice('cosyvoice-v3-flash')).toBeCloseTo(0.33, 6);
    vi.unstubAllEnvs();
  });
});

describe('文本 LLM 分价（元/千 token）', () => {
  it('未设 env 时用内置默认价：输入 0.0024 / 输出 0.0096', () => {
    // 1000 输入 token + 1000 输出 token = 0.0024 + 0.0096
    expect(calcPromptCost(1000, 1000)).toBe(0.012);
    // 只钉总和的话，把两个默认价对调（0.0096 / 0.0024）这里照样绿 —— 名字说的是「分价」，
    // 断言就得能分开。下面两条把它钉住。
    expect(calcPromptCost(1000, 0)).toBe(0.0024);
    expect(calcPromptCost(0, 1000)).toBe(0.0096);
  });

  it('输入与输出**分开取价**（同一批 token 数，换输出价结果必须变）', () => {
    // 这条是本模块存在的理由：若实现把两个价看成一个，本用例必红
    vi.stubEnv('WENLV_PROMPT_MODEL_OUTPUT_PRICE', '0.1');
    expect(calcPromptCost(0, 1000)).toBe(0.1);
    expect(calcPromptCost(1000, 0)).toBe(0.0024);
  });

  it('env 覆盖生效', () => {
    vi.stubEnv('WENLV_PROMPT_MODEL_INPUT_PRICE', '1');
    vi.stubEnv('WENLV_PROMPT_MODEL_OUTPUT_PRICE', '2');
    expect(calcPromptCost(1000, 1000)).toBe(3);
  });

  it('token 数非数字 / NaN / 负数 → 按 0 记，且不抛', () => {
    for (const bad of ['abc', NaN, -1, null, undefined]) {
      expect(calcPromptCost(bad as any, bad as any)).toBe(0);
    }
  });

  it('非法 token 数**必须出声**（按 0 记）：输入、输出各一条，不静默吞掉', () => {
    // 「不静默」是本模块的立身之本，而这条告警路径原先**零用例看守**：
    // 把 normalizeTokenCount 里两处 warnOnceToken 调用全删掉，整个文件照样 25 passed。
    //
    // ⚠️ 两个 raw 值必须是**本文件其他地方没用过的哨兵**：承载去重的 warnedEnv 是模块级 Set，
    //    跨用例累积、从不重置，也不受 vi.clearAllMocks / beforeEach / afterEach 影响
    //    （它们只清 mock 历史，清不掉模块内部状态）。用了别处出现过的值 ⇒ 去重命中 ⇒
    //    这里看到 0 条告警，用例恒红且原因难查。输入/输出用两个独立哨兵，才能分别断言。
    const SENTINEL_IN = 'not-a-number-for-warn-assertion-in';
    const SENTINEL_OUT = 'not-a-number-for-warn-assertion-out';
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => { /* 静音 */ });
    let msgs: string[] = [];
    try {
      expect(calcPromptCost(SENTINEL_IN as any, SENTINEL_OUT as any)).toBe(0);
      msgs = warnSpy.mock.calls.map((c: any[]) => String(c[0]));
    } finally {
      warnSpy.mockRestore();
    }
    // 只认**本次调用**产生的、带本次哨兵的告警 —— 不写 toHaveBeenCalledTimes(1) 那种
    // 全局计数，它会被前序用例的调用污染。
    const inMsgs = msgs.filter((m: string) => m.includes(SENTINEL_IN));
    const outMsgs = msgs.filter((m: string) => m.includes(SENTINEL_OUT));
    expect(inMsgs.length).toBe(1);
    expect(outMsgs.length).toBe(1);
    expect(inMsgs[0]).toContain('按 0 记');
    expect(outMsgs[0]).toContain('按 0 记');
    // 文案里必须带 label：输入非法与输出非法指向不同的上游字段，混了排障时会误导。
    expect(inMsgs[0]).toContain('输入');
    expect(outMsgs[0]).toContain('输出');
  });

  it('env 超上界 → 回落默认价（不是按荒谬单价记账）', () => {
    vi.stubEnv('WENLV_PROMPT_MODEL_INPUT_PRICE', '20000');
    expect(calcPromptCost(1000, 0)).toBe(0.0024);
  });

  it('只含空白的 env → 视为未设，走默认价', () => {
    vi.stubEnv('WENLV_PROMPT_MODEL_INPUT_PRICE', '   ');
    expect(calcPromptCost(1000, 0)).toBe(0.0024);
  });
});
