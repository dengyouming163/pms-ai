/**
 * 风格基线（S3）：素材生成防漂移的锚点。
 *
 * 本文件是**纯函数**，不碰数据库、不调网络 —— 便于单测钉死输出形状。
 * 真正的 LLM 调用在 services/wenlv/asset-gen/generate.ts 的调用方里。
 */
import type { WenlvStyleBible } from '../../../db/schema/wenlv.js';

export const STYLE_BIBLE_SYSTEM = [
  '你是文旅沉浸式剧本的视觉总监。请基于给定的剧本信息，产出一份**可复用的画风规范**。',
  '这份规范会被用于生成该剧本的**全部**视觉素材（点位插画、印章、封面），',
  '所以它必须描述**通用于所有画面**的风格，而不是某一幅画的内容。',
  '',
  '必须输出 JSON，且**恰好**包含以下字段：',
  '  artStyle  string  画风（如：水墨、工笔重彩、赛博朋克、民国月份牌）',
  '  palette   string[] 主色序列（3-5 个十六进制色，第一个与剧本主色一致）',
  '  era       string  时代背景',
  '  brushwork string  笔触与质感（如：宣纸洇染、粗粝胶片颗粒、扁平矢量）',
  '  mood      string  氛围基调（如：苍凉、明快、悬疑）',
  '  mustHave  string[] 必须出现的视觉元素（场地标志物等）',
  '  forbidden string[] 禁止出现的视觉元素（现代物件、真人人脸、文字水印等）',
  '  notes     string  其他约束',
  '',
  '只输出 JSON，不要 markdown 围栏，不要解释。',
].join('\n');

/** 组装自举用的 user prompt。纯函数。 */
export function buildStyleBiblePrompt(input: {
  productName: string;
  subtitle?: string | null;
  theme?: unknown;
  config?: unknown;
  nodeTitles: string[];
  venuePointNames: string[];
}): string {
  const lines = [
    `剧本名称：${input.productName}`,
    input.subtitle ? `一句话定位：${input.subtitle}` : '',
    `设计主题：${JSON.stringify(input.theme ?? {})}`,
    `世界观与剧情：${JSON.stringify(input.config ?? {}).slice(0, 3000)}`,
    input.nodeTitles.length ? `章节标题：${input.nodeTitles.join('、')}` : '',
    input.venuePointNames.length
      ? `真实场地点位（画面里可能出现的地标）：${input.venuePointNames.join('、')}`
      : '',
  ];
  // 空行不能放进 lines 里再 filter(Boolean) —— 那会把分隔空行一并滤掉，
  // 上下文与指令糊成一段。收尾单独拼，保住这个空行。
  const head = lines.filter(Boolean).join('\n');
  return `${head}\n\n请输出该剧本的画风规范 JSON。`;
}

/** 只保留非空字符串，去重保序。 */
function strList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: string[] = [];
  for (const x of v) {
    if (typeof x !== 'string') continue;
    const s = x.trim();
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : undefined;
}

function str(v: unknown): string | undefined {
  if (typeof v !== 'string') return undefined;
  const s = v.trim();
  return s ? s : undefined;
}

/**
 * 容错解析基线 JSON。
 *
 * 与 pms-agent 的 LenientModel 同路数：先剥 markdown 围栏再 parse。
 * **解析失败必须抛错，绝不返回空对象** —— 空基线等于放弃防漂移，
 * 出一批风格漂移的图比不出更糟（spec §8）。
 */
export function parseStyleBible(raw: string): WenlvStyleBible {
  // 只剥**包裹整体**的围栏，不用全局 `replace(/```/g, '')` —— 那会把字符串值里
  // 出现的 ``` 一并抹掉：解析「成功」、内容却已被静默改动，与本函数
  // 「宁可抛错也不静默降级」的原则直接冲突。
  // 语言标注容忍大小写与空格：LLM 写 ```JSON 是常见写法，为此整批失败不值当。
  const stripped = String(raw ?? '')
    .replace(/^\s*```[a-zA-Z]*[ \t]*\r?\n/, '')
    .replace(/\r?\n?[ \t]*```[ \t]*$/, '')
    .trim();

  let obj: unknown;
  try {
    obj = JSON.parse(stripped);
  } catch {
    // 兜底：LLM 偶尔在 JSON 前加一句寒暄（「好的，这是规范：」）。取最外层花括号之间的内容。
    // **只做这一种修补** —— 更激进的修复会掩盖真实的结构错误（pms-agent 的教训）。
    const open = stripped.indexOf('{');
    const close = stripped.lastIndexOf('}');
    if (open >= 0 && close > open) {
      try { obj = JSON.parse(stripped.slice(open, close + 1)); } catch { /* 落到下面统一抛错 */ }
    }
    if (obj === undefined) {
      throw new Error(`风格基线不是合法 JSON：${stripped.slice(0, 200)}`);
    }
  }
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new Error('风格基线必须是 JSON 对象');
  }
  const o = obj as Record<string, unknown>;
  const bible: WenlvStyleBible = {
    artStyle: str(o.artStyle),
    palette: strList(o.palette),
    era: str(o.era),
    brushwork: str(o.brushwork),
    mood: str(o.mood),
    mustHave: strList(o.mustHave),
    forbidden: strList(o.forbidden),
    notes: str(o.notes),
  };
  if (!bible.artStyle) throw new Error('风格基线缺少 artStyle');
  return bible;
}
