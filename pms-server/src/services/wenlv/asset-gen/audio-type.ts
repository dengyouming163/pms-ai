/**
 * 音频格式嗅探（无 DB / 无 IO，可直接单测）。
 *
 * 与 image-type.ts 同源动机：**上游回的是什么格式，只有字节说了算。**
 *
 * 现场为什么需要它（2026-09-18 核实）：
 *   - `services/aliyun/voice.ts:149` 的 CosyVoice 分支显式发 `input.format: 'mp3'`；
 *   - 同文件 `:128-141` 的 qwen 分支（`voiceId.startsWith('qwen-tts-vc')`，判据在 :125）只发
 *     `{ voice, text, language }`，**不发 format** —— 上游回什么格式由它自己决定。
 *   `tts-provider.ts` 此前把 `.mp3` / `audio/mpeg` 写死，一旦上游回的是 ogg/wav，
 *   OSS 上就是一个「后缀与 Content-Type 双双说谎」的对象：**在线播放解码失败、下载下来又是好的** ——
 *   与 2026-09-14 图片那次（`.png` 装 JPEG，提交 a60c71ec）完全同型的事故。
 *
 * **只有两个分支真的改变输出**：`OggS → ogg` 与 `RIFF....WAVE → wav`。
 * ID3v2 头、MPEG 帧同步字、未知字节**一律走兜底**，与改动前唯一存在的行为（mp3）
 * 逐字段相同。所以它们不单列分支 —— 返回值与兜底相同的分支改不动任何输出，却会读成
 * 「这里做了校验」。曾经就这么写过，还配了一句「只认 ff fb / ff f3 / ff f2 这三种实际取值」
 * 的假精确措辞：`ff fa`（MPEG-1 Layer III, protection=0）与 `ff e2`/`ff e3`（MPEG-2.5
 * Layer III）同样是合法的帧同步字。将来真要收窄或放宽 mp3 的认定，那是**加一个返回值不同
 * 的分支**并且要改测试 —— 那时再加，而不是现在留一个空壳。
 *
 * **有意不带 `contentTypeHint` 参数**（与 sniffImageType 的唯一区别）：图片上游的响应头里有
 * Content-Type，而音频这条链路的 `synthesizeSpeech` 返回类型是 `Promise<Buffer>`
 * （voice.ts:116-121）—— **没有任何调用方能提供 hint**，加了就是一个恒为 undefined 的死分支。
 */

export interface AudioType { ext: string; mime: string; }

/** 兜底 = 改动前的历史行为。把爆炸半径限定在「真的嗅到别的格式」的那些调用上。 */
const FALLBACK: AudioType = { ext: 'mp3', mime: 'audio/mpeg' };

export function sniffAudioType(buf: Buffer): AudioType {
  const starts = (sig: number[], offset = 0) =>
    buf.length >= offset + sig.length && sig.every((b, i) => buf[offset + i] === b);

  // Ogg 容器头（OggS）
  if (starts([0x4f, 0x67, 0x67, 0x53])) return { ext: 'ogg', mime: 'audio/ogg' };
  // RIFF....WAVE（偏移 8 是 form type，必须是 WAVE —— 否则 AVI 也会被认成音频）
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x41, 0x56, 0x45], 8)) {
    return { ext: 'wav', mime: 'audio/wav' };
  }
  // 兜底。**必须是新对象**：`FALLBACK` 是模块级常量，直接把本体交出去的话，
  // 任何调用方一次 `r.ext = …` 就地改写就会污染本进程内后续**所有**兜底结果
  // （image-type.ts 的每个分支也都是返回新字面量）。
  return { ...FALLBACK };
}
