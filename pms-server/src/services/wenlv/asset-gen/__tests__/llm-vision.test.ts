import { describe, it, expect, vi, afterEach } from 'vitest';
import { buildVisionMessages, reviewModel } from '../llm-vision.js';
import { callLlmVision } from '../../../wenlv-asset-gen-scheduler.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('视觉调用的消息构造', () => {
  it('文本块在前、图片块在后，图片用 image_url 形状（OpenAI 兼容模式）', () => {
    const m = buildVisionMessages('系统', '请看这张图', ['https://oss/a.jpg']);
    expect(m[0]).toEqual({ role: 'system', content: '系统' });
    expect(m[1].role).toBe('user');
    expect(m[1].content[0]).toEqual({ type: 'text', text: '请看这张图' });
    expect(m[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://oss/a.jpg' } });
  });

  it('多张图 → 多个 image_url 块，顺序即入参顺序', () => {
    const m = buildVisionMessages('s', 't', ['https://a/1.jpg', 'https://a/2.jpg']);
    expect(m[1].content).toHaveLength(3);
    // 整块 `toEqual` 而不是计划原文的 `content[2].image_url.url`（`llm-vision.ts` 的
    // `VisionContentPart` 是 `text | image_url` 的**联合**，直接读 part 属性 ts-check 过不去：
    // TS2339 `Property 'image_url' does not exist on type 'VisionContentPart'`）。
    // 实测：即便 `content` 已从 `string | VisionContentPart[]` 收窄成 `VisionContentPart[]`，
    // 只要 part 本身是联合，这条就得先窄化 —— 故整块比对，断言同一件事且额外钉住 `type`。
    expect(m[1].content[2]).toEqual({ type: 'image_url', image_url: { url: 'https://a/2.jpg' } });
  });

  it('评审模型：env 优先，否则 qwen-vl-max（**不是** qwen-max，那是纯文本）', () => {
    expect(reviewModel()).toBe('qwen-vl-max');
    vi.stubEnv('WENLV_REVIEW_MODEL', 'qwen-vl-plus');
    expect(reviewModel()).toBe('qwen-vl-plus');
  });

  it('env 设成空白 → 回落默认（不把空模型名发给上游）', () => {
    vi.stubEnv('WENLV_REVIEW_MODEL', '   ');
    expect(reviewModel()).toBe('qwen-vl-max');
  });

  it('空 / 空白 URL 被跳过（不产出 `image_url: { url: "" }` 的畸形请求）', () => {
    const m = buildVisionMessages('s', 't', ['', '   ', 'https://a/1.jpg']);
    expect(m[1].content).toHaveLength(2);
    expect(m[1].content[1]).toEqual({ type: 'image_url', image_url: { url: 'https://a/1.jpg' } });
  });
});

/**
 * `callLlmVision` 是**生产函数**（Task 13/14 才接线），这里是它唯一的直接覆盖。
 *
 * 为什么值得单测：纯函数那 4 条只证明「消息形状对、模型名对」，
 * 证明不了 `callLlmVision` 真的把 `reviewModel()` 用上了 —— 把 `model:` 那一行
 * 写回 `process.env.WENLV_PROMPT_MODEL || 'qwen-max'`（纯文本模型）时，
 * 纯函数用例照样全绿，而生成路径要到 Task 13 才有测试。这正是
 * 「新增分支零覆盖时，把逻辑整个改回错写法一条测试都不会红」的形态。
 *
 * 用**手写的最小 Response 形状**（status / ok / text）而不是 `new Response(...)`：
 * `callLlmVision` 只用到这三个成员，手写对象既够用又不引 DOM/undici 的类型。
 */
describe('视觉调用（callLlmVision 发出去的请求）', () => {
  const mkRes = (status: number, raw: string) => ({
    status,
    ok: status >= 200 && status < 300,
    text: async () => raw,
  });

  it('request body：model 用 reviewModel()（**不是**纯文本的 WENLV_PROMPT_MODEL）、messages 是视觉块', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
    // 把纯文本模型显式设成一个**像默认值**的值：若实现回落它，这条立刻红。
    vi.stubEnv('WENLV_PROMPT_MODEL', 'qwen-max');
    // ⛔ 评审模型也必须**显式**换成一个非默认值：否则 `reviewModel()` 恰是默认的
    //    `qwen-vl-max`，把实现改成硬编码字面量 `model: 'qwen-vl-max'` 时
    //    下面三条 model 断言**全过**（等于没测）。
    vi.stubEnv('WENLV_REVIEW_MODEL', 'qwen-vl-plus');
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      sent.push(init);
      return mkRes(200, JSON.stringify({
        choices: [{ message: { content: '评审结论' } }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      }));
    }));

    const r = await callLlmVision('sys', '看图', ['https://oss/a.jpg']);

    expect(sent).toHaveLength(1);
    const body = JSON.parse(sent[0].body);
    expect(body.model).toBe('qwen-vl-plus');   // 硬的那条：env 值原样透传（非默认 ⇒ 字面量硬编码会红）
    expect(body.model).toBe(reviewModel());    // 有 stub 之后不再恒真
    expect(body.model).not.toBe('qwen-max');
    // 视觉块形状：content 是数组、末尾是 image_url（**不是** callLlm 那种字符串 content）
    expect(Array.isArray(body.messages[1].content)).toBe(true);
    expect(body.messages[1].content[1].image_url.url).toBe('https://oss/a.jpg');
    // 用量照常读回（证明复用一条 readUsage 线是通的）
    expect(r.text).toBe('评审结论');
    expect(r.inputTokens).toBe(5);
    expect(r.outputTokens).toBe(7);
  });

  it('非 2xx → 抛错文本带 `body=` 前缀（与 callLlm 同款排障手法）', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
    vi.stubGlobal('fetch', vi.fn(async () => mkRes(429, '{"error":{"message":"限流"}}')));

    const p = callLlmVision('s', 't', ['https://a/1.jpg']);
    await expect(p).rejects.toThrow('body=');
    await expect(p).rejects.toThrow('HTTP 429');
  });

  it('一张有效图都没有 → 发请求前抛错（含张数与原始入参），不滑成纯文本请求', async () => {
    vi.stubEnv('DASHSCOPE_API_KEY', 'sk-test');
    const sent: any[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url: any, init: any) => {
      sent.push(init);
      return mkRes(200, '{}');
    }));

    const p = callLlmVision('s', 't', ['', '  ', '']);
    await expect(p).rejects.toThrow('没有可用的图片 URL');
    await expect(p).rejects.toThrow('3');                 // 收到的张数
    await expect(p).rejects.toThrow('["","  ",""]');      // 原始入参（排障要能分清「传了空串」与「没传」）
    expect(sent).toHaveLength(0);                         // ⛔ 关键：一个请求都没发出去
  });
});
