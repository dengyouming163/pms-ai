import type { WenlvDialogueMessage, WenlvNpcSecretLayer } from '../../../db/schema/wenlv.js';

const LLM_URL = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const MODEL = process.env.WENLV_DIALOGUE_MODEL || 'qwen-plus';
// 20s 硬超时：模型/网关挂起时由各调用方的既有 catch/兜底接住，不拖死对话请求。
// 与 services/wenlv/atoms/verify.ts 同款（Task 4 已立先例）。
const LLM_TIMEOUT_MS = 20_000;

export type Attitude = '抵触' | '中立' | '认同';

export type AttitudeResult = {
  passed: boolean;
  attitude: Attitude;
  reason: string;
};

/**
 * 文件内私有：对话类裁判共用的 chat-completions 调用。
 * env / 鉴权 / 温度与历史调用逐字同款；成功返回模型文本（已 trim），
 * 非 ok 响应、网络异常、超时、JSON 响应解析异常统一返回 null（不抛）。
 *
 * @param opts.jsonMode 传 true 时带 response_format=json_object（仅 JSON 类裁判使用；
 *   evaluateAttitude 输出裸单词，绝不能开）。
 */
async function callChatLlm(
  systemPrompt: string,
  userPrompt: string,
  opts?: { jsonMode?: boolean },
): Promise<string | null> {
  try {
    const resp = await fetch(`${LLM_URL}/chat/completions`, {
      method: 'POST',
      // 20s 硬超时（AbortSignal.timeout）：纯增强，原 evaluateAttitude 无超时。
      signal: AbortSignal.timeout(LLM_TIMEOUT_MS),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY || process.env.ARK_API_KEY || ''}`,
      },
      body: JSON.stringify({
        model: MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0,
        // 与 services/wenlv/atoms/verify.ts judgeByLlm 同款；默认不开（裸单词裁判不受影响）。
        ...(opts?.jsonMode ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!resp.ok) {
      // 只记 status，不打 prompt/key，避免机密与鉴权信息泄进日志。
      console.warn('[attitude-evaluator] llm call failed', { status: resp.status });
      return null;
    }

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    return (data.choices?.[0]?.message?.content || '').trim();
  } catch (err) {
    // AbortError 的 name 原样保留，便于区分超时与网络故障；message 可能为空。
    console.warn('[attitude-evaluator] llm call failed', {
      name: err instanceof Error ? err.name : undefined,
      message: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * 宽容提取 JSON 对象：模型可能用 ```json 围栏包裹或在 JSON 外加寒暄。
 * ①先对整段 raw 直解；②失败再做「尊重字符串字面量」的平衡花括号扫描
 * （扫描遇 `"` 跳过字符串内容并处理 `\"` 转义，字符串里的 {}/" 不参与平衡），
 * 取第一个平衡且可 parse 的对象；仍失败返回 null。
 */
function extractJsonObject(raw: string): Record<string, unknown> | null {
  const asObject = (parsed: unknown): Record<string, unknown> | null => (
    parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null
  );

  // ① 整段直解（模型最常见的干净输出）
  try {
    const direct = asObject(JSON.parse(raw));
    if (direct) return direct;
  } catch { /* 落到平衡扫描 */ }

  // ② 平衡花括号扫描：从每个 '{' 出发找第一个深度归零的 '}'，逐段尝试 parse
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let j = i; j < raw.length; j++) {
      const ch = raw[j];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) {
          try {
            const parsed = asObject(JSON.parse(raw.slice(i, j + 1)));
            if (parsed) return parsed;
          } catch { /* 该平衡段不合法，继续找下一个起点 */ }
          break;
        }
      }
    }
  }
  return null;
}

/** 字符串数组归一：非数组 → null（交给调用方兜底）；元素 String 化、trim、去空。 */
function normalizeStringList(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value.map((x) => (typeof x === 'string' ? x : String(x))).map((s) => s.trim()).filter(Boolean);
}

/**
 * 严格有限数解析（M-1 数值守卫）：仅接受
 *  - number 且有限（NaN/Infinity 拒绝），或
 *  - 非空白数字字符串（trim 后 Number 有限；'1e2' 这类数字形态也接受）。
 * 明确拒绝 null/undefined/true/false/''/[]/{} 等（Number() 会把 null/''/[] 静默转 0）。
 * 不合法返回 null，由调用方走各自兜底。
 */
function parseFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const s = value.trim();
    if (s === '') return null;
    const n = Number(s);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * 事实白名单归一 key：trim 后去空白与中英标点、转小写。
 * M-2 起出端只认归一后精确等值（不再做子串包含匹配，防 LLM 用长句套白名单短语蒙混）。
 */
function factKey(s: string): string {
  return s.trim().toLowerCase().replace(/[\s，,。.!！?？;；:："'“”‘’「」【】（）()]/g, '');
}

/**
 * convince 类型章节的态度判定。
 * 让 LLM 读本轮对话，对 NPC 当前对玩家的态度三选一。
 * 只有「认同」才算章节完成。
 * 失败时安全默认「抵触」+ 不通过，避免章节被错误推进。
 *
 * @deprecated Task 7 起，每轮多维评分改走 {@link evaluateMove}（态度 + 情感意图 + 事实运用）。
 * 本函数仍被 goal-checker.checkGoalReached 的 convince 通关闸门使用，保留一个发布周期观察回退/对比，
 * 一个发布周期后删（连同 goal-checker 的调用一起切到 evaluateMove.attitude）。
 */
export async function evaluateAttitude(opts: {
  messages: WenlvDialogueMessage[];
  goal: string;
}): Promise<AttitudeResult> {
  const { messages, goal } = opts;

  const systemPrompt = [
    '你是叙事裁判。读完本轮 NPC 与玩家的对话后，判定 NPC 当前对玩家的态度。',
    '只输出三个值之一：抵触 / 中立 / 认同。',
    '不要带任何解释、标点或前缀，只输出这三个词之一。',
  ].join('\n');

  const userPrompt = `章节目标：${goal}\n\n对话记录：\n${
    messages.map((m) => `[${m.role}] ${m.content}`).join('\n')
  }`;

  const raw = await callChatLlm(systemPrompt, userPrompt);
  if (raw === null) return { passed: false, attitude: '抵触', reason: 'LLM 不可用' };

  if (raw === '认同') return { passed: true, attitude: '认同', reason: 'NPC 已认同玩家，章节完成' };
  if (raw === '中立') return { passed: false, attitude: '中立', reason: 'NPC 仍持中立态度，需继续说服' };
  return { passed: false, attitude: '抵触', reason: 'NPC 仍抵触玩家，需继续说服' };
}

/**
 * Task 7（演员升级②）：emotive-persuade 单轮多维评分。
 * - attitude：NPC 被说服档位（抵触/中立/认同），口径同 evaluateAttitude；
 * - emotiveScore：情感意图 0-100——真诚入戏、证据推理给高分；逐字复述提示词/套话/乞给答案给低分；
 * - usedFacts：玩家本轮实际运用的白名单事实（secretLayer.knows ∪ answerCriteria 表述），出端强约束；
 * - hitCriteriaIndices：命中的 answerCriteria 下标（0 基整数），小数/越界/重复在出端清洗。
 *
 * 返回语义（二者必须区分，调用方不得把 null 当成「中立 50」的真实评分）：
 * - null：本次评分整体不可用——callChatLlm 失败（非 ok/网络/超时）或返回内容抽不出可解析 JSON。
 *   调用方应维持上一档缓存原样，不覆盖。
 * - MoveVerdict：模型返回了可解析 JSON；仅个别字段脏时走字段级兜底（attitude→中立、
 *   emotiveScore→50、usedFacts→白名单精确过滤、hitCriteria→下标清洗），不升级为 null。
 * 本函数自身不抛。
 */
export interface MoveVerdict {
  attitude: Attitude;
  /** 情感意图得分 0-100：是否真诚投入角色情境，而非复述提示词套话。 */
  emotiveScore: number;
  /** 玩家实际运用的白名单事实（canonical 原文，来自 knows ∪ answerCriteria 的精确命中）。 */
  usedFacts: string[];
  /** 命中的判据下标；仅接受整数（数字或数字字符串），非整数（含小数）直接丢弃。 */
  hitCriteriaIndices: number[];
}

export async function evaluateMove(input: {
  goalDescription: string;
  answerCriteria: string[];
  /** 节点下发给 NPC 的脱敏引导提示：作为「玩家照念不得分」的反套话上下文。严禁传入 answerCriteria 原文。 */
  criteriaHints?: string[];
  playerText: string;
  secretLayer?: WenlvNpcSecretLayer;
}): Promise<MoveVerdict | null> {
  const { goalDescription, answerCriteria, criteriaHints, playerText, secretLayer } = input;

  const systemPrompt = [
    '你是实景解密体验的叙事裁判。根据玩家本轮发言，评估玩家是否真诚扮演角色、用证据推进对话。',
    '只输出一个 JSON 对象，不要输出 JSON 以外的任何解释、Markdown 或代码块，格式：',
    '{"attitude":"抵触|中立|认同","emotiveScore":0到100的整数,"usedFacts":[字符串],"hitCriteria":[整数下标]}',
    '评分规则：',
    '1. emotiveScore（玩家的真诚投入度）、hitCriteria（判据命中）、attitude（NPC 态度）是三条互相独立的轴，不得互相推导：',
    '   - 玩家照念提示词，即使语义碰巧触及判据：hitCriteria 可以命中，emotiveScore 仍须给低分；',
    '   - 玩家真诚举证但没有触及任何判据：emotiveScore 可以给高分，hitCriteria 给空数组；',
    '   - 玩家演得再真诚，NPC 也可以仍抵触：attitude 只看 NPC 此刻被说服的程度。',
    '2. emotiveScore 分数锚点：90-100 引用具体证据、或基于角色立场推理，明显是在扮演而非背稿；60-89 方向正确但偏空泛；31-59 沾边但主要靠套话；0-30 逐字复述系统提示词、照念引导提示、乞求 NPC 给答案或出戏。复述提示词不算举证。',
    '3. attitude 描述 NPC 此刻被说服的程度，三选一：抵触 / 中立 / 认同。',
    '4. usedFacts 只能逐字取自下方「事实白名单」与「通关判据」中出现的事实，不得编造白名单以外的内容；没有运用事实给空数组。',
    '5. hitCriteria 是玩家本轮语义命中的通关判据下标（从 0 开始的整数）；玩家无需逐字念判据原文，语义触及核心即算命中；没有命中给空数组。',
  ].join('\n');

  const userParts: string[] = [];
  userParts.push(`【章节目标】${goalDescription}`);
  userParts.push(
    answerCriteria.length
      ? `【通关判据】（下标从 0 开始）\n${answerCriteria.map((c, i) => `${i}. ${c}`).join('\n')}`
      : '【通关判据】（本章节无逐条判据，hitCriteria 必须给空数组）',
  );

  // 防剧透纪律：criteriaHints 是脱敏引导文案，只能作为反套话上下文；这里绝不放 answerCriteria 以外的机密。
  const hints = normalizeStringList(criteriaHints) ?? [];
  if (hints.length) {
    userParts.push(
      '【玩家可能照念的提示词】以下是系统下发给 NPC 的脱敏引导提示。'
      + '玩家若逐字复述或换皮套说这些话，属于套话而非举证，emotiveScore 必须压到低分：\n'
      + hints.map((h) => `- ${h}`).join('\n'),
    );
  }

  // 仅注入 knows 白名单（usedFacts 的取值域）；never/loosensWhen 与本轮评分无关，不扩大机密暴露面。
  const knows = normalizeStringList(secretLayer?.knows) ?? [];
  if (knows.length) {
    userParts.push(
      '【事实白名单】usedFacts 只能从以下事实中逐字选取（外加上面通关判据中表述的事实）：\n'
      + knows.map((k) => `- ${k}`).join('\n'),
    );
  }

  userParts.push(`【玩家本轮发言】\n${playerText}`);

  // JSON 类裁判：开 json_object（evaluateAttitude 的裸单词输出不受影响）。
  const raw = await callChatLlm(systemPrompt, userParts.join('\n\n'), { jsonMode: true });
  // 整体不可用（非 ok/网络/超时）→ null：调用方维持上一档，严禁伪装成中立/50。
  if (raw === null) return null;

  const obj = extractJsonObject(raw);
  // 抽不出任何可解析 JSON 对象 → null（模型回了寒暄/裸文本等同整体失败）。
  if (!obj) return null;

  // 以下为字段级兜底：JSON 可解析但个别字段脏，不升级为整体 null。

  // attitude：非法值兜底中立
  const attitude: Attitude = obj.attitude === '抵触' || obj.attitude === '中立' || obj.attitude === '认同'
    ? obj.attitude
    : '中立';

  // emotiveScore：严格有限数守卫（拒绝 null/true/false/''/[]/{}）→ 50；越界 clamp 0-100。
  let emotiveScore = 50;
  const scoreNum = parseFiniteNumber(obj.emotiveScore);
  if (scoreNum !== null) {
    emotiveScore = Math.min(100, Math.max(0, scoreNum));
  }

  // usedFacts：非数组 → []；元素 trim 去空。
  const facts = normalizeStringList(obj.usedFacts) ?? [];
  // 白名单 canonical 精确映射：归一 key → canonical 原文（knows 已 trim，判据正文 trim 后入表）。
  const allowedFacts = new Map<string, string>();
  for (const canonicalRaw of [...knows, ...answerCriteria.map((c) => c.trim()).filter(Boolean)]) {
    const canonical = canonicalRaw.trim();
    const key = factKey(canonical);
    if (key !== '' && !allowedFacts.has(key)) allowedFacts.set(key, canonical);
  }
  // 归一后精确等值命中才保留，输出 Map 中的 canonical 原文（不回显 LLM 文本）；
  // 归一后为空串（纯标点）丢弃；白名单为空 → fail-closed 全部丢弃。
  const usedFacts: string[] = [];
  for (const f of facts) {
    const key = factKey(f);
    if (key === '') continue;
    const canonical = allowedFacts.get(key);
    if (canonical !== undefined && !usedFacts.includes(canonical)) usedFacts.push(canonical);
  }

  // hitCriteria：非数组 → []；严格有限数守卫后必须为整数（小数直接丢弃，不做 Math.round），
  // 且在 answerCriteria 下标范围内；去重升序。
  let hitCriteriaIndices: number[] = [];
  if (Array.isArray(obj.hitCriteria)) {
    const seen = new Set<number>();
    for (const item of obj.hitCriteria) {
      const n = parseFiniteNumber(item);
      if (n === null || !Number.isInteger(n) || n < 0 || n >= answerCriteria.length) continue;
      seen.add(n);
    }
    hitCriteriaIndices = Array.from(seen).sort((a, b) => a - b);
  }

  return { attitude, emotiveScore, usedFacts, hitCriteriaIndices };
}
