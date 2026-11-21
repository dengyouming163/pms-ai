// 原子核验分派（spec §8.1）：按 ATOM_META.verify 语义把游客提交分派到 7 种核验。
// 答案归一**只复用** /answer 同款（isAnswerCorrect 的 trim 精确 / multiple 集合等值），不另造。
// 任何外部依赖（商户缺配、LLM 不可用）都回 pass=false + 说明文案，绝不抛 500；
// 唯一的「抛」是原子类型未注册/无 verify 语义 —— 由路由兜 400。
import { eq, and, asc } from 'drizzle-orm';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvMerchantPartners, pmsBuiWenlvProducts } from '../../../db/schema/index.js';
import type { WenlvAtom, WenlvAtomType, WenlvInteraction, WenlvState } from '../../../db/schema/wenlv.js';
import { isAnswerCorrect } from '../../wenlv-engine.js';
import { ATOM_META, type WenlvAtomVerify } from './registry.js';
import { HttpError } from '../../../lib/http-error.js';

/** 游客提交：code=口令/暗号/点位码；text=开放表述（observe/fragment 文本）；answer=题型答案（串/数组）。 */
export interface AtomVerifyBody {
  code?: string;
  text?: string;
  answer?: unknown;
}

export interface AtomVerifyContext {
  productId: string;
  state: WenlvState;
  /** code 原子 config.expectedCode 缺省时回退使用的绑定点位码（由路由按 /trigger 同款取法查传）。 */
  boundPointCode?: string | null;
}

export interface AtomVerdict {
  pass: boolean;
  /** fail 时给前端的中文可重试文案。 */
  message?: string;
  /** pass 后写 pms_bui_wenlv_events 的 gameplay 事件类型；null = 不单独写事件（auto）。 */
  trackType?: string | null;
  /** item-combine 通关回补的揭示文案（脱敏 DTO 已剥除 revealText，通关响应里回补）。 */
  revealText?: string;
}

/** 未注册原子类型 / 类型无核验语义：路由兜 400。message 是给前端看的中文文案，安全可直返。 */
export class AtomVerifyUnsupportedError extends HttpError {
  declare status: 400;
  constructor(message: string) {
    super(400, message);
    this.name = 'AtomVerifyUnsupportedError';
  }
}

/** 与 /answer 同款归一：只 trim、大小写/字符原样精确（isAnswerCorrect 同一口径，不另造）。 */
function norm(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function fail(message: string): AtomVerdict {
  return { pass: false, message };
}

/** 残缺配置统一 fail-closed 文案：绝不把「没配答案/目标」判成对。 */
const CONFIG_ERROR = '任务配置异常，请联系工作人员';

function isBlank(v: unknown): boolean {
  return typeof v !== 'string' || v.trim() === '';
}

// ── code：实体寻物核验码（config 优先，缺省回退绑定点位码）────────────────────
function verifyCode(cfg: Record<string, unknown>, body: AtomVerifyBody, ctx: AtomVerifyContext): AtomVerdict {
  const configured = typeof cfg.expectedCode === 'string' && cfg.expectedCode.trim() ? cfg.expectedCode.trim() : null;
  const expected = configured ?? (ctx.boundPointCode ? String(ctx.boundPointCode).trim() : null);
  // 配置码与点位回退码均空 ⇒ fail-closed：不得用空码比对通过。
  if (!expected) return fail(CONFIG_ERROR);
  if (!body.code) return fail('请输入现场核验码');
  return norm(body.code) === expected
    ? { pass: true, trackType: 'collect' }
    : fail('核验码不正确，再看看现场提示');
}

// ── cipher：商户暗号回执码（config 指定商户优先；缺省取产品场地首个 active 商户）──
async function verifyCipher(cfg: Record<string, unknown>, body: AtomVerifyBody, ctx: AtomVerifyContext): Promise<AtomVerdict> {
  let partner: { replyCode?: string | null } | null = null;
  // DB 异常 fail-closed：与 LLM 分支及文件头承诺一致 —— 回 pass=false 可重试文案，绝不抛 500。
  try {
    const explicitId = typeof cfg.merchantPartnerId === 'string' && cfg.merchantPartnerId.trim() ? cfg.merchantPartnerId.trim() : null;
    if (explicitId) {
      const [row] = await db.select().from(pmsBuiWenlvMerchantPartners)
        .where(eq(pmsBuiWenlvMerchantPartners.id, explicitId)).limit(1);
      partner = row ?? null;
    } else {
      const [product] = await db.select({ venueId: pmsBuiWenlvProducts.venueId })
        .from(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, ctx.productId)).limit(1);
      if (!product?.venueId) return fail('现场商户尚未就绪，可先体验其他环节');
      const rows = await db.select().from(pmsBuiWenlvMerchantPartners)
        .where(and(
          eq(pmsBuiWenlvMerchantPartners.venueId, product.venueId),
          eq(pmsBuiWenlvMerchantPartners.status, 'active'),
        ))
        .orderBy(asc(pmsBuiWenlvMerchantPartners.createdAt), asc(pmsBuiWenlvMerchantPartners.id))
        .limit(1);
      partner = rows[0] ?? null;
    }
  } catch {
    return fail('网络波动，请重试');
  }
  if (!partner) return fail('现场商户尚未就绪，可先体验其他环节');
  if (!partner.replyCode || !String(partner.replyCode).trim()) {
    return fail('商户暗号尚未配置，请联系工作人员');
  }
  if (!body.code) return fail('请对上接头暗号');
  return norm(body.code) === String(partner.replyCode).trim()
    ? { pass: true, trackType: 'cipher_redeemed' }
    : fail('暗号未对上，再试试');
}

// ── answer：quiz 题型复用 isAnswerCorrect；碎片拼合比答案串；道具组合比 id 集合 ──
// 只取判定器实际读取的两个字段（精确 Pick）：残缺配置在进入判定器**之前**挡住，
// 不再用 as never 把任意对象塞进 WenlvInteraction。
type QuizPuzzle = Pick<
  Extract<WenlvInteraction, { type: 'single' | 'input' | 'judge' | 'multiple' }>,
  'type' | 'answer'
>;

function verifyAnswer(type: WenlvAtomType, cfg: Record<string, unknown>, body: AtomVerifyBody): AtomVerdict {
  const submitted = body.answer !== undefined ? body.answer : body.text;
  switch (type) {
    case 'single':
    case 'input':
    case 'judge': {
      // answer 缺省/空串/纯空白 ⇒ fail-closed，不允许空答案通过。
      if (isBlank(cfg.answer)) return fail(CONFIG_ERROR);
      const puzzle: QuizPuzzle = { type, answer: String(cfg.answer).trim() };
      // 直接喂 /answer 同款判定器：single/input/judge trim 精确（question/options 判定器不读）。
      const ok = isAnswerCorrect(puzzle as WenlvInteraction, submitted);
      return ok ? { pass: true, trackType: 'answer' } : fail('回答不正确，再想想');
    }
    case 'multiple': {
      // 空数组/非数组/缺位（含非串或空白项）⇒ fail-closed：isAnswerCorrect 本就把空集判错，
      // 但缺位数组说明配置已损坏，必须报配置异常而非普通答错。
      const ans = Array.isArray(cfg.answer) ? cfg.answer : null;
      if (!ans || ans.length === 0 || ans.some((x) => isBlank(x))) return fail(CONFIG_ERROR);
      const puzzle: QuizPuzzle = { type, answer: ans.map((x) => String(x).trim()) };
      const ok = isAnswerCorrect(puzzle as WenlvInteraction, submitted);
      return ok ? { pass: true, trackType: 'answer' } : fail('回答不正确，再想想');
    }
    case 'fragment-assembly': {
      const want = norm(cfg.answer);
      // 拼合目标答案为空 ⇒ 配置损坏，fail-closed。
      if (!want) return fail(CONFIG_ERROR);
      return norm(submitted) === want ? { pass: true, trackType: 'answer' } : fail('拼合结果不对，再调整下顺序');
    }
    case 'item-combine': {
      const rawIds = Array.isArray(cfg.itemIds) ? cfg.itemIds : null;
      // itemIds 非数组/空数组 ⇒ fail-closed（与其余 answer 路同款配置异常文案）。
      if (!rawIds || rawIds.length === 0) return fail(CONFIG_ERROR);
      const want = new Set(rawIds.map((x) => String(x).trim()).filter(Boolean));
      if (want.size === 0) return fail(CONFIG_ERROR);
      const got = new Set(
        Array.isArray(submitted) ? submitted.filter((v) => typeof v === 'string').map((v) => String(v).trim()) : [],
      );
      const ok = want.size === got.size && [...want].every((id) => got.has(id));
      return ok
        ? { pass: true, trackType: 'answer', revealText: typeof cfg.revealText === 'string' ? cfg.revealText : '' }
        : fail('组合不对，再试试这些道具');
    }
    // photo/meditate 在原子契约里不做服务端文本判定（现场动作，走 attest/trigger 通道）。
    default:
      return fail('该任务需要在现场完成');
  }
}

// ── llm-text：一次性开放判定，网关/模型/env 与 attitude-evaluator 同款 ─────────
const LLM_URL = (process.env.ARK_BASE_URL || 'https://dashscope.aliyuncs.com/compatible-mode/v1').replace(/\/+$/, '');
const LLM_MODEL = process.env.WENLV_DIALOGUE_MODEL || 'qwen-plus';

async function judgeByLlm(criteria: string, text: string): Promise<{ pass: boolean; reason: string }> {
  const systemPrompt = [
    '你是实景游戏的观察裁判。根据「判定标准」判断玩家提交的「现场观察」是否达成。',
    '只输出 JSON：{"pass":boolean,"reason":string}，不要输出 JSON 以外的任何内容。',
  ].join('\n');
  const userPrompt = `判定标准：${criteria}\n\n玩家的现场观察：${text}`;
  const resp = await fetch(`${LLM_URL}/chat/completions`, {
    method: 'POST',
    // 20s 硬超时：模型/网关挂起时由既有 catch 兜成 pass=false「网络波动，请重试」，不拖死请求。
    signal: AbortSignal.timeout(20000),
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.DASHSCOPE_API_KEY || process.env.ARK_API_KEY || ''}`,
    },
    body: JSON.stringify({
      model: LLM_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0,
      response_format: { type: 'json_object' },
    }),
  });
  if (!resp.ok) throw new Error(`llm ${resp.status}`);
  const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
  const raw = (data.choices?.[0]?.message?.content || '').trim();
  // 容错：模型偶尔会在 JSON 外加字 —— 截取首个 { 到末个 }。
  const jsonText = raw.startsWith('{') ? raw : raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1);
  const parsed = JSON.parse(jsonText) as { pass?: unknown; reason?: unknown };
  return { pass: parsed.pass === true, reason: typeof parsed.reason === 'string' ? parsed.reason : '' };
}

async function verifyLlmText(cfg: Record<string, unknown>, body: AtomVerifyBody): Promise<AtomVerdict> {
  const criteria = typeof cfg.criteria === 'string' ? cfg.criteria : '';
  const text = norm(body.text);
  if (!text) return fail('请先提交你的现场观察');
  try {
    const r = await judgeByLlm(criteria, text);
    return r.pass
      ? { pass: true, trackType: 'answer' }
      : fail(r.reason || '观察还不够，换个角度再看看');
  } catch {
    // LLM 异常/超时/坏响应：可重试，不抛 500。
    return fail('网络波动，请重试');
  }
}

// ── collectibles：跨店拼图，state.collected 覆盖配置全集 ──────────────────────
function verifyCollectibles(cfg: Record<string, unknown>, ctx: AtomVerifyContext): AtomVerdict {
  // collectibleIds 非数组/空数组 ⇒ 配置损坏，fail-closed（空目标不得判集齐）。
  if (!Array.isArray(cfg.collectibleIds) || cfg.collectibleIds.length === 0) return fail(CONFIG_ERROR);
  const need = cfg.collectibleIds.map((x) => String(x));
  const missing = need.filter((id) => !ctx.state.collected?.[id]);
  if (missing.length === 0) return { pass: true, trackType: null };
  return fail(`线索还没集齐，还差 ${missing.length} 份`);
}

/** 按原子契约的 verify 语义分派。未注册/未知 verify ⇒ AtomVerifyUnsupportedError（路由 400）。 */
export async function verifyAtom(
  atom: WenlvAtom,
  body: AtomVerifyBody,
  ctx: AtomVerifyContext,
): Promise<AtomVerdict> {
  const meta = ATOM_META[atom.type as WenlvAtomType];
  if (!meta) throw new AtomVerifyUnsupportedError(`未注册原子类型: ${String(atom.type)}`);
  const kind: WenlvAtomVerify = meta.verify;
  const cfg = atom.config ?? {};
  switch (kind) {
    case 'code':
      return verifyCode(cfg, body, ctx);
    case 'cipher':
      return verifyCipher(cfg, body, ctx);
    case 'answer':
      return verifyAnswer(atom.type, cfg, body);
    case 'llm-text':
      return verifyLlmText(cfg, body);
    case 'collectibles':
      return verifyCollectibles(cfg, ctx);
    case 'attest':
      // 真人委托/实体惊喜/商业随赠等：现场工作人员或本人确认即完成。
      return { pass: true, trackType: 'task_grant' };
    case 'auto':
      // ar-echo/ambient/night：到达即完成，无单独埋点。
      return { pass: true, trackType: null };
    default:
      throw new AtomVerifyUnsupportedError(`原子类型 ${String(atom.type)} 无核验语义`);
  }
}
