import { getOSSBaseUrl } from './aliyun/oss.js';

/**
 * BGM 曲库 —— **单一来源**：短名 → 文件名 的映射与 URL 拼接只此一处。
 *
 * 两条入口：
 * - 短名直取 {@link buildBgmUrl} / {@link buildBgmUrlOrNull}（视频合成按短名指定，未命中即不配 BGM）
 * - 风格标签归一 {@link resolveBgmUrl}（把创作台的 soundStyle 中文标签映射成短名，未命中落默认）
 */
export const BGM_MAP: Record<string, string> = {
  relaxing: 'bgm-relaxing',
  dynamic: 'bgm-dynamic',
  cuisine: 'bgm-cuisine',
  chinese: 'bgm-chinese-style',
  romantic: 'bgm-romantic',
  upbeat: 'bgm-upbeat',
  quirky: 'bgm-quirky',
  beauty: 'bgm-beauty',
};

/**
 * 创作台 `designTokens.soundStyle`（**中文标签**）→ {@link BGM_MAP} 的短名。
 *
 * ⚠️ 这两套取值**不是同一套**：`soundStyle` 落库的是 `db/wenlv-design-builtin.ts:45/59/74`
 * 里的中文标签，而 `BGM_MAP` 的键是英文短名。少这一层，每个产品都会静默落到默认曲。
 * 新增内置模板风格时**必须同时在这里补一行**。
 */
export const SOUND_STYLE_ALIAS: Record<string, string> = {
  '东方古韵': 'chinese',
  '空灵古琴': 'relaxing',
  '电子脉冲': 'dynamic',
};

/** 未匹配时的兜底风格。历史题材默认古风。 */
export const DEFAULT_BGM_KEY = 'chinese';

/** 按短名拼公开访问地址。**不校验** key 是否存在于 BGM_MAP，调用方自行保证。 */
export function buildBgmUrl(key: string): string {
  return `${getOSSBaseUrl()}/pms/bgm/${BGM_MAP[key]}.mp3`;
}

/**
 * 与 {@link buildBgmUrl} 相同，但 **key 未匹配时返回 `null`**（而不是拼出 `.../undefined.mp3`）。
 *
 * 视频合成用它：它的既有语义是「没指定 / 不认识这个风格就**不配 BGM**」。
 * 判空收在这里而不是散在调用方，重复才真的被消灭。
 *
 * 用 `Object.hasOwn` 而非 `BGM_MAP[key]` 真值判断：后者会被原型链上的
 * `constructor` / `toString` 等假键穿过，拼出 `.../function Object() {...}.mp3`。
 */
export function buildBgmUrlOrNull(key: string | null | undefined): string | null {
  if (typeof key !== 'string' || !Object.hasOwn(BGM_MAP, key)) return null;
  return buildBgmUrl(key);
}

/** 把任意输入归一成 {@link BGM_MAP} 里的一个键；不认识就落 {@link DEFAULT_BGM_KEY}。 */
function normalizeSoundStyle(v: string | null | undefined): string {
  if (typeof v !== 'string' || !v) return DEFAULT_BGM_KEY;
  if (Object.hasOwn(BGM_MAP, v)) return v;              // 已经是短名（兼容旧数据/直调）
  if (Object.hasOwn(SOUND_STYLE_ALIAS, v)) return SOUND_STYLE_ALIAS[v]!;  // 中文标签
  return DEFAULT_BGM_KEY;
}

/**
 * 把创作台的 soundStyle 解析成可播地址。
 * `undefined` / `''` / 未匹配一律落到 {@link DEFAULT_BGM_KEY} —— **永不返回 undefined**，
 * 调用方无需再判空（详情页要么有曲子、要么整段不渲染）。
 */
export function resolveBgmUrl(soundStyle: string | null | undefined): string {
  return buildBgmUrl(normalizeSoundStyle(soundStyle));
}
