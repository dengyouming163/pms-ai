/**
 * 旁白 TTS provider（S3）：包装 pms-server 既有的 synthesizeSpeech。
 *
 * 既有能力已完整（services/aliyun/voice.ts），本文件只做三件事：
 *   1. 补默认音色 —— synthesizeSpeech 的 voiceId **无默认值**，必须调用方传
 *   2. 合成完转存 OSS —— synthesizeSpeech 返回 Buffer，不是 URL
 *   3. 返回字符数供记账
 *
 * ⚠️ 前置环境变量：DASHSCOPE_API_KEY **与** BAILIAN_WORKSPACE_ID 两个都要有，
 *    缺任一 checkConfig() 直接抛（见 voice.ts:33-36）。
 */
import { synthesizeSpeech } from '../../aliyun/voice.js';
import { uploadToOSS } from '../../aliyun/oss.js';
import { sniffAudioType } from './audio-type.js';

/**
 * 默认音色。与 routes/voice.ts:447 既有用法一致（那里写死 longxing_v3）。
 *
 * 刻意**不做** env 覆盖：规格只要求默认音色是 longxing_v3，没有任何调用方传
 * WENLV_TTS_VOICE_ID。曾经写过 `process.env.WENLV_TTS_VOICE_ID || 'longxing_v3'`，
 * 那既超出规格，又会让「部署/CI 恰好设了这个变量」时测试莫名其妙变红。
 */
const DEFAULT_VOICE_ID = 'longxing_v3';

/**
 * 火山 voice_id（NPC 台词 TTS 用，6 种按性别/年龄的友好名）→ DashScope CosyVoice 音色。
 *
 * NPC 节点旁白（storyText）走 DashScope 管线，而 NPC 台词走火山管线、用 npc.voice_id。
 * 为让旁白也贴合 NPC 特色，按性别/年龄段映射到最接近的 DashScope 音色。
 * 音色性别依据见 pms-web fastcut-panel.tsx 的 option 文案。
 * 映射不到（含空 voice_id）回落 DEFAULT_VOICE_ID。
 */
const VOLCANO_TO_DASHSCOPE_VOICE: Record<string, string> = {
  male_young: 'longfeifei_v3',     // 磁性男声
  male_middle: 'longshu_v3',       // 新闻男声（沉稳）
  male_elder: 'longanxuan_v3',     // 经典直播（成熟）
  female_young: 'longhua_v3',      // 元气女声
  female_middle: 'longwan_v3',     // 温柔女声
  female_elder: 'longjing_v3',     // 沉稳女声
};

export function mapNpcVoiceToDashScope(volcanoVoiceId: string | null | undefined): string {
  if (!volcanoVoiceId) return DEFAULT_VOICE_ID;
  return VOLCANO_TO_DASHSCOPE_VOICE[volcanoVoiceId] ?? DEFAULT_VOICE_ID;
}

/** qwen 克隆音色的模型名。与 voice.ts:131 的 `model: 'qwen3-tts-vc-2026-01-22'` 逐字一致。 */
const QWEN_VOICE_MODEL = 'qwen3-tts-vc-2026-01-22';

/**
 * CosyVoice 分支的模型名。**与 voice.ts:14 的 `TARGET_MODEL` 同样在模块加载时读一次**，
 * 不是调用时读 —— 这是刻意的。voice.ts 捕获在 import 期，本文件若改成调用时读，
 * 运行中改了 env 就会出现「请求实际用的是旧模型、而 model 列记的是新模型」，
 * 而 model 列存在的唯一意义就是如实记录**实际**用的模型。
 * 默认值 'cosyvoice-v3-plus' 也与 voice.ts:14 逐字一致。
 */
const TARGET_MODEL = (process.env.BAILIAN_TTS_MODEL || 'cosyvoice-v3-plus').trim();

/**
 * 如实回报**实际**用的模型。
 *
 * synthesizeSpeech 按 voiceId 前缀分叉（`const isQwenVoice` 在 voice.ts:125、分支在 :128）：qwen-tts-vc* 走 qwen3-tts-vc，
 * 其余走 BAILIAN_TTS_MODEL（默认 cosyvoice-v3-plus，voice.ts:14）。
 * 恒写一个默认值会让用克隆音色的那批 job 在 model 列上记错型号 ——
 * 而 model 列正是「这批钱花在哪个模型上」的唯一依据。
 * 分支判断在这里重复了一次；若 voice.ts 改了分叉条件，这里要跟着改。
 */
function resolveModel(voiceId: string): string {
  if (voiceId.startsWith('qwen-tts-vc')) return QWEN_VOICE_MODEL;
  return TARGET_MODEL;
}

/**
 * 旁白音频的 OSS 对象键。**必须导出** —— 测试要单独钉住它（`uploadToOSS` 被 mock 掉了，
 * 不单独断言的话「键落到哪个前缀下」就没有任何防线）。
 *
 * 前缀沿用本仓既有惯例（`pms/tts/…`、`pms/voice/…`、`pms/mediakit/…`），
 * 归到 `pms/wenlv/narration/` 便于按业务线清理与配 CDN 规则。
 *
 * `ext` **无默认值**：它必须由调用方从 `sniffAudioType` 的结果传入。
 * 曾经写过 `ext = 'mp3'`，那是个静默陷阱 —— 对一份已嗅出 ogg 的字节写
 * `buildNarrationObjectKey(id)` 不报错、不红，静默产出后缀为 `.mp3` 的对象键，
 * 把 A1 的全部意义原样复现。且与 A2 自相矛盾：「编译期强制优于运行时兜底」
 * 的正确性不该只在 jobId 上成立。
 * （`FALLBACK` 兜底的是「字节认不出」，默认参数兜底的是「调用方已经知道 ext 却漏传」——
 * 后者没有兜底价值，只有掩盖价值。）
 */
export function buildNarrationObjectKey(jobId: string, ext: string): string {
  return `pms/wenlv/narration/${jobId}.${ext}`;
}

export async function synthesizeNarration(input: {
  text: string;
  voiceId?: string;
  /**
   * **必填**（原为可选 + `|| String(Date.now())` 兜底，2026-09-18 改成编译期强制）。
   * 理由见下方对象键处的注记。
   */
  jobId: string;
  /**
   * 合成返回后、**转存之前**调用。调用方必须在这里把费用落库。
   *
   * ⚠️ 为什么必须有这个钩子：`uploadToOSS` 在**本函数内部**，而记账此前写在
   *    `synthesizeNarration` 的**返回值之后** —— 转存一抛错，本函数就 throw，
   *    那句记账语句永远不执行，于是一笔**已经花掉**的 TTS 费在账面上消失
   *    （违反 S3 交付判据「知道花了多少钱」）。
   *    图路径本来就是对的顺序（`getImageProvider().generate()` 一返回就记账，
   *    转存的失败不抹掉它，见 wenlv-asset-gen-scheduler.ts）。这里给旁白补上同一个时刻。
   *
   * 调用时机刻意放在**空 Buffer 检查之前**：上游返回了（哪怕内容是空的）就按
   * 「已经调用并计费」处理 —— 与图路径「上游返回即已计费」同一条口径。
   */
  onSynthesized?: (info: { charCount: number; provider: string; model: string }) => Promise<void>;
}): Promise<{ url: string; charCount: number; provider: string; model: string }> {
  const charCount = input.text.length;
  const voiceId = input.voiceId || DEFAULT_VOICE_ID;
  const model = resolveModel(voiceId);
  const buf = await synthesizeSpeech(input.text, voiceId, 1.0, 50);
  // 钱到这里已经花了。记账**先于**下面任何可能抛错的步骤。
  await input.onSynthesized?.({ charCount, provider: 'dashscope-tts', model });
  if (!buf || buf.length === 0) {
    // 空 Buffer 说明上游返回了但没内容 —— 落库会得到一个 0 字节音频
    throw new Error('TTS 合成结果为空');
  }
  // `jobId` 已是**必填**（2026-09-18，A2）：此前它可选、缺省时用 `String(Date.now())` 兜底，
  // 于是每次重试都生成一个新对象名，而仓内没有任何清理路径（没有 OSS 删除调用、没有 TTL 规则），
  // 每次都留下一个不可回收的 OSS 孤儿对象。改成必填是**编译期强制优于运行时抛错** ——
  // 唯一的生产调用方（wenlv-asset-gen-scheduler.ts 的 generateNarrationJob）本来就传 job.id。
  //
  // 扩展名与 MIME 由**实际字节**决定，不写死 —— 理由见 audio-type.ts 文件头：
  // CosyVoice 分支发了 `input.format: 'mp3'`（voice.ts:149），而 **qwen 克隆分支不发 format**
  // （voice.ts:128-141），上游回什么格式由它自己决定。此前把 `.mp3` / `audio/mpeg` 写死，
  // 一旦上游回 ogg/wav，OSS 上就是一个后缀与 Content-Type 双双说谎的对象。
  // TTS 结果为空已在上一行拦下，故此处 buf 非空，嗅探不会落到「空 Buffer」那条。
  const { ext, mime } = sniffAudioType(buf);
  const key = buildNarrationObjectKey(input.jobId, ext);
  const url = await uploadToOSS(buf, key, mime);
  return { url, charCount, provider: 'dashscope-tts', model };
}
