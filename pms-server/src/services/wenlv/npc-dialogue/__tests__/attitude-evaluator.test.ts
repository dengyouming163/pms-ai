import { describe, it, expect, vi, afterEach } from 'vitest';
import { evaluateAttitude, evaluateMove } from '../attitude-evaluator.js';
import type { WenlvDialogueMessage } from '../../../../db/schema/wenlv.js';

// ── fetch mock 样板：stubLlm 返回 LLM 文本；init.reject 模拟网络/超时故障，init.ok/status 模拟非 ok ──
function stubLlm(content?: string, init?: { ok?: boolean; status?: number; reject?: unknown }) {
  const fetchMock = init?.reject !== undefined
    ? vi.fn().mockRejectedValue(init.reject)
    : vi.fn().mockResolvedValue({
      ok: init?.ok ?? true,
      status: init?.status ?? 200,
      json: async () => ({ choices: [{ message: { content: content ?? '' } }] }),
    });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

/** 取最近一次 fetch 请求的 JSON body。 */
function lastRequestBody(fetchMock: ReturnType<typeof vi.fn>) {
  return JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string) as {
    messages?: Array<{ content: string }>;
    response_format?: { type: string };
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('evaluateAttitude', () => {
  const messages: WenlvDialogueMessage[] = [
    { role: 'user', content: '我求你帮帮我们', ts: 1 },
    { role: 'assistant', content: '我凭什么信你', ts: 2 },
    { role: 'user', content: '因为我们都没有别的选择', ts: 3 },
  ];

  it('LLM 返回认同时通过', async () => {
    stubLlm('认同');
    const r = await evaluateAttitude({ messages, goal: '说服老周帮助玩家' });
    expect(r.passed).toBe(true);
    expect(r.attitude).toBe('认同');
  });

  it('LLM 返回中立时不通过', async () => {
    stubLlm('中立');
    const r = await evaluateAttitude({ messages, goal: '说服老周帮助玩家' });
    expect(r.passed).toBe(false);
  });

  it('LLM 返回异常内容时默认不通过', async () => {
    stubLlm('乱七八糟');
    const r = await evaluateAttitude({ messages, goal: '说服老周帮助玩家' });
    expect(r.passed).toBe(false);
    expect(r.attitude).toBe('抵触');
  });

  it('LLM 失败时返回安全默认值（不通过）', async () => {
    stubLlm(undefined, { reject: new Error('net') });
    const r = await evaluateAttitude({ messages, goal: '说服老周帮助玩家' });
    expect(r.passed).toBe(false);
  });

  it('LLM 调用带 20s 超时 signal（AbortSignal.timeout，纯增强）', async () => {
    const fetchMock = stubLlm('中立');
    await evaluateAttitude({ messages, goal: '说服老周帮助玩家' });
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });

  it('输出是裸单词裁判：不得带 response_format=json_object（M-5）', async () => {
    const fetchMock = stubLlm('中立');
    await evaluateAttitude({ messages, goal: '说服老周帮助玩家' });
    expect(lastRequestBody(fetchMock).response_format).toBeUndefined();
  });
});

// ── Task 7：emotive-persuade 多维评分 ─────────────────────────────────────────
describe('evaluateMove 多维评分', () => {
  const baseInput = {
    goalDescription: '说服老周相信玩家是自己人并放行进入码头',
    answerCriteria: ['说出码头暗号', '出示铜鱼符'],
    // 脱敏引导提示：NPC 手里有、玩家可能照念的套话来源
    criteriaHints: ['聊聊夜里码头挂灯的动静'],
    playerText: '昨夜码头挂的是三盏红灯，暗号对得上——这是铜鱼符，你看一眼。',
    secretLayer: { knows: ['码头暗号', '铜鱼符'], never: ['私货仓位'], loosensWhen: '认出铜鱼符' },
  };

  const verdictJson = (patch: Record<string, unknown>) => JSON.stringify({
    attitude: '认同',
    emotiveScore: 82,
    usedFacts: ['码头暗号'],
    hitCriteria: [0],
    ...patch,
  });

  it('返回 attitude + emotiveScore(0-100) + usedFacts + hitCriteriaIndices 四字段', async () => {
    stubLlm(verdictJson({ attitude: '认同', emotiveScore: 82, usedFacts: ['码头暗号'], hitCriteria: [0] }));
    const v = await evaluateMove(baseInput);
    expect(v).not.toBeNull();
    expect(v!.attitude).toBe('认同');
    expect(v!.emotiveScore).toBe(82);
    expect(v!.usedFacts).toEqual(['码头暗号']);
    expect(v!.hitCriteriaIndices).toEqual([0]);
  });

  it('prompt 含目标/判据/反套话指令/hints/knows；声明三轴互相独立；never 与 loosensWhen 机密不入 prompt', async () => {
    const fetchMock = stubLlm(verdictJson({ attitude: '中立', emotiveScore: 20, usedFacts: [], hitCriteria: [] }));

    // 玩家几乎逐字复述下发的引导提示 —— 语义命中也不该给情感高分
    const v = await evaluateMove({ ...baseInput, playerText: '那个……夜里码头挂灯的动静是怎么回事啊？' });
    expect(v!.emotiveScore).toBe(20);
    expect(v!.attitude).toBe('中立');

    const body = lastRequestBody(fetchMock);
    const prompt = body.messages!.map((m) => m.content).join('\n');
    // 目标与判据原文必须在
    expect(prompt).toContain(baseInput.goalDescription);
    expect(prompt).toContain('说出码头暗号');
    expect(prompt).toContain('出示铜鱼符');
    // 反套话：明确点出「复述 / 套话」不给高分，且 hints 作为「照念不得分」上下文传入
    expect(prompt).toContain('复述');
    expect(prompt).toContain('套话');
    expect(prompt).toContain('聊聊夜里码头挂灯的动静');
    // 事实白名单写进 prompt
    expect(prompt).toContain('码头暗号');
    expect(prompt).toContain('铜鱼符');
    // I-3：三条轴互相独立的校准声明
    expect(prompt).toContain('互相独立');
    // M-7 负向断言：never / loosensWhen 的值绝不进评分 prompt（机密暴露面不扩大）
    expect(prompt).not.toContain('私货仓位');
    expect(prompt).not.toContain('认出铜鱼符');
  });

  it('usedFacts 只保留白名单事实（knows ∪ answerCriteria 表述），LLM 编造的事实出端滤掉', async () => {
    stubLlm(verdictJson({ usedFacts: ['码头暗号', '铜鱼符', '玩家随口编的天外秘闻'], hitCriteria: [0, 1] }));
    const v = await evaluateMove(baseInput);
    expect(v!.usedFacts.sort()).toEqual(['码头暗号', '铜鱼符']);
    expect(v!.hitCriteriaIndices).toEqual([0, 1]);
  });

  it('LLM 输出缺字段（空 JSON）⇒ 字段级兜底 attitude=中立、emotiveScore=50、空数组（仍返回对象，不是 null）', async () => {
    stubLlm('{}');
    const v = await evaluateMove(baseInput);
    expect(v).toEqual({ attitude: '中立', emotiveScore: 50, usedFacts: [], hitCriteriaIndices: [] });
  });

  it('LLM 非 ok / 网络异常 / 超时 abort / 无 JSON 文本 ⇒ 一律返回 null（故障档不伪装中立 50）', async () => {
    // 无 JSON 对象的裸文本
    stubLlm('我觉得玩家说得还行吧');
    expect(await evaluateMove(baseInput)).toBeNull();

    // 网络异常
    stubLlm(undefined, { reject: new Error('net') });
    expect(await evaluateMove(baseInput)).toBeNull();

    // 超时 abort
    stubLlm(undefined, { reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
    expect(await evaluateMove(baseInput)).toBeNull();

    // 非 ok 响应
    stubLlm('error', { ok: false, status: 500 });
    expect(await evaluateMove(baseInput)).toBeNull();
  });

  it('LLM 在 JSON 外加寒暄文字 ⇒ 宽容截取对象解析，字段级结果照常返回', async () => {
    stubLlm(`裁判结果如下：\n${verdictJson({ attitude: '认同', emotiveScore: 77 })}\n请查收。`);
    const parsed = await evaluateMove(baseInput);
    expect(parsed).not.toBeNull();
    expect(parsed!.attitude).toBe('认同');
    expect(parsed!.emotiveScore).toBe(77);
  });

  it('```json 围栏包裹 ⇒ 平衡扫描解出（M-3）', async () => {
    stubLlm(`\`\`\`json\n${verdictJson({ attitude: '抵触', emotiveScore: 40 })}\n\`\`\``);
    const v = await evaluateMove(baseInput);
    expect(v!.attitude).toBe('抵触');
    expect(v!.emotiveScore).toBe(40);
  });

  it('前置文字 + 对象，且字符串值内含花括号 ⇒ 字符串感知扫描不被字面量内括号误导（M-3）', async () => {
    stubLlm(`结果是：\n{"attitude":"中立","emotiveScore":20,"usedFacts":["}奇怪{"],"hitCriteria":[]}`);
    const v = await evaluateMove(baseInput);
    expect(v!.attitude).toBe('中立');
    expect(v!.emotiveScore).toBe(20);
    // '}奇怪{' 不在白名单 ⇒ 出端滤掉
    expect(v!.usedFacts).toEqual([]);
  });

  it('fetch 调用带 20s 超时 signal + response_format=json_object（M-5，与 atoms/verify 同款）', async () => {
    const fetchMock = stubLlm(verdictJson({}));
    await evaluateMove(baseInput);
    const body = lastRequestBody(fetchMock);
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(body.response_format).toEqual({ type: 'json_object' });
  });

  it('故障时 console.warn 诊断日志：非 ok 带 status、AbortError 保留 name（M-4），且不打 prompt/key', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    stubLlm('error', { ok: false, status: 503 });
    await evaluateMove(baseInput);
    expect(warn).toHaveBeenCalledWith('[attitude-evaluator] llm call failed', { status: 503 });

    stubLlm(undefined, { reject: Object.assign(new Error('aborted'), { name: 'AbortError' }) });
    await evaluateMove(baseInput);
    expect(warn).toHaveBeenCalledWith(
      '[attitude-evaluator] llm call failed',
      { name: 'AbortError', message: 'aborted' },
    );

    // 日志负载里不得出现 prompt 文本或 Authorization
    for (const call of warn.mock.calls) {
      expect(JSON.stringify(call)).not.toContain('码头暗号');
      expect(JSON.stringify(call)).not.toContain('Bearer');
    }
    warn.mockRestore();
  });

  it('emotiveScore 越界（120 / -5）夹取到 0-100；非法值严格守卫兜底 50（M-1）', async () => {
    const scoreWith = async (raw: unknown) => {
      stubLlm(verdictJson({ emotiveScore: raw }));
      return (await evaluateMove(baseInput))!.emotiveScore;
    };
    expect(await scoreWith(120)).toBe(100);
    expect(await scoreWith(-5)).toBe(0);
    expect(await scoreWith('高')).toBe(50);
    expect(await scoreWith('82')).toBe(82); // 数字字符串仍接纳
    expect(await scoreWith(2)).toBe(2);
    expect(await scoreWith('2')).toBe(2);
    // 明确拒绝 Number() 静默转换的伪数字
    expect(await scoreWith(null)).toBe(50);
    expect(await scoreWith(true)).toBe(50);
    expect(await scoreWith(false)).toBe(50);
    expect(await scoreWith('')).toBe(50);
    expect(await scoreWith([])).toBe(50);
    expect(await scoreWith({})).toBe(50);
  });

  it('hitCriteria 越界/重复/非整数/脏值 ⇒ 严格守卫过滤、去重排序（M-1）', async () => {
    stubLlm(verdictJson({ hitCriteria: ['0', 1, 1, 5, -1, 1.5] }));
    const v = await evaluateMove(baseInput); // 仅 2 条判据：合法下标 0/1
    expect(v!.hitCriteriaIndices).toEqual([0, 1]);
  });

  it('hitCriteria 脏批次（null/布尔/空串/数组/对象）⇒ 全部丢弃；数字 2 与字符串 "2" 正常接纳（M-1）', async () => {
    stubLlm(verdictJson({ hitCriteria: [null, true, false, '', [], { x: 1 }] }));
    expect((await evaluateMove(baseInput))!.hitCriteriaIndices).toEqual([]);

    const threeCriteria = { ...baseInput, answerCriteria: ['第一条', '第二条', '第三条'] };
    stubLlm(verdictJson({ hitCriteria: [2, '2'] }));
    expect((await evaluateMove(threeCriteria))!.hitCriteriaIndices).toEqual([2]);
  });

  it('hitCriteria 非数组 ⇒ 兜底 []', async () => {
    stubLlm(verdictJson({ hitCriteria: '0,1' }));
    const v = await evaluateMove(baseInput);
    expect(v!.hitCriteriaIndices).toEqual([]);
  });

  it('usedFacts 非数组 ⇒ 兜底 []；元素 trim 去空，输出 canonical 原文', async () => {
    stubLlm(verdictJson({ usedFacts: '码头暗号' }));
    expect((await evaluateMove(baseInput))!.usedFacts).toEqual([]);

    stubLlm(verdictJson({ usedFacts: ['  码头暗号  ', '   ', 22] }));
    // '22' 不在白名单 ⇒ 滤掉；空白丢弃；命中输出 canonical（不带 LLM 回显的空格）
    expect((await evaluateMove(baseInput))!.usedFacts).toEqual(['码头暗号']);
  });

  it('usedFacts 精确等值映射：子串/长句/纯标点/近形改写一律滤掉（M-2）', async () => {
    // 'aaaaa' 对 knows=['a']：旧子串匹配会放行，精确映射必须滤掉
    stubLlm(verdictJson({ usedFacts: ['aaaaa'] }));
    const v1 = await evaluateMove({
      ...baseInput,
      answerCriteria: [],
      secretLayer: { knows: ['a'], never: [] },
    });
    expect(v1!.usedFacts).toEqual([]);

    // 编造长句含白名单子串 ⇒ 滤掉
    stubLlm(verdictJson({ usedFacts: ['我听说铜鱼符能打开码头的后门'] }));
    expect((await evaluateMove(baseInput))!.usedFacts).toEqual([]);

    // 纯标点（归一后为空串）⇒ 丢弃
    stubLlm(verdictJson({ usedFacts: ['，，！！', '???'] }));
    expect((await evaluateMove(baseInput))!.usedFacts).toEqual([]);

    // knows 带空白时 canonical 为 trim 后原文；LLM 回显带空格也归一命中、输出 canonical
    stubLlm(verdictJson({ usedFacts: [' 码头暗号 '] }));
    const v4 = await evaluateMove({
      ...baseInput,
      secretLayer: { knows: ['  码头暗号  '], never: [], loosensWhen: '' },
    });
    expect(v4!.usedFacts).toEqual(['码头暗号']);
  });

  it('usedFacts 两源各一条命中：knows 与 answerCriteria 正文都可作白名单（M-2）', async () => {
    stubLlm(verdictJson({ usedFacts: ['铜鱼符', '说出码头暗号', '编的'] }));
    const v = await evaluateMove({ ...baseInput, secretLayer: { knows: ['铜鱼符'], never: [] } });
    expect(v!.usedFacts.sort()).toEqual(['说出码头暗号', '铜鱼符']);
  });

  it('attitude 非法值 ⇒ 兜底中立', async () => {
    stubLlm(verdictJson({ attitude: '生气' }));
    expect((await evaluateMove(baseInput))!.attitude).toBe('中立');
  });

  it('无 secretLayer 时 usedFacts 仍按 answerCriteria 正文精确过滤；knows 与判据皆空 ⇒ fail-closed 全丢弃（M-2）', async () => {
    stubLlm(verdictJson({ usedFacts: ['说出码头暗号', '编的'] }));
    const v = await evaluateMove({ ...baseInput, secretLayer: undefined });
    expect(v!.usedFacts).toEqual(['说出码头暗号']);

    // 旧行为 fail-open 放行；M-2 起没有白名单就不存在「白名单事实」⇒ 全部丢弃
    stubLlm(verdictJson({ usedFacts: ['任意事实'], hitCriteria: [9] }));
    const closed = await evaluateMove({ goalDescription: 'g', answerCriteria: [], playerText: 't' });
    expect(closed!.usedFacts).toEqual([]);
    expect(closed!.hitCriteriaIndices).toEqual([]);
  });
});
