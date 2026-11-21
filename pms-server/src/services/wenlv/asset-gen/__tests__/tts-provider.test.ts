import { describe, it, expect, vi, beforeEach } from 'vitest';

// ⚠️ 路径深度：本测试在 `src/services/wenlv/asset-gen/__tests__/`，
// 要回到 `src/services/` 需要**三个** `../`（`__tests__` → `asset-gen` → `wenlv` → `services`）。
// 写成 `../../aliyun/...` 会指向 `src/services/wenlv/aliyun/` —— 那个目录不存在，
// mock 静默不生效、真 `synthesizeSpeech` 被调用（缺 DASHSCOPE_API_KEY 直接抛）。
// 注意与 `tts-provider.ts` 区分：它在 `asset-gen/` 里，只需**两个** `../`。
vi.mock('../../../aliyun/voice.js', () => ({
  synthesizeSpeech: vi.fn(async (text: string) => Buffer.from(`audio:${text}`)),
}));
vi.mock('../../../aliyun/oss.js', () => ({
  uploadToOSS: vi.fn(async (buf: Buffer, filename: string) => `https://oss.example.com/${filename}`),
}));

// 两个 mock 是**模块级共享**的，`toHaveBeenCalledWith` 匹配的是全量调用历史 ⇒
// 不逐用例清历史，将来任何 `toHaveBeenCalledTimes(1)` / `not.toHaveBeenCalled()` 都会
// 读到前序用例的调用而**假绿**。用 `clearAllMocks`（**不是** `resetAllMocks`：
// clear 只清调用历史与实例，保留 `vi.fn` 的基础桩实现）。
// 下面各用例里逐条写的 `mockClear` 今天**是装饰性的**（实测删掉两处仍 10/10），
// 保留是为了让「这条用例依赖干净的调用历史」在阅读时看得见。
beforeEach(() => {
  vi.clearAllMocks();
});

describe('TTS provider', () => {
  it('合成后转存 OSS，返回 URL', async () => {
    const { synthesizeNarration } = await import('../tts-provider.js');
    // `jobId` 自 2026-09-18 起是**必填**（A2）—— 本文件既有用例在此只补这一个字段，
    // 断言与桩一字未动。
    const r = await synthesizeNarration({ text: '你走进古镇。', jobId: 'job-basic' });
    expect(r.url).toContain('https://oss.example.com/');
    expect(r.url).toMatch(/\.mp3$/);
    expect(r.provider).toBe('dashscope-tts');
  });

  it('objectKey 落在 pms/wenlv/ 前缀下', async () => {
    const { buildNarrationObjectKey } = await import('../tts-provider.js');
    // ext 无默认值（2026-09-18 修）：必须由调用方从 sniffAudioType 的结果传入。
    expect(buildNarrationObjectKey('job-1', 'mp3')).toBe('pms/wenlv/narration/job-1.mp3');
  });

  it('合成返回空 Buffer 时抛错（不落一个坏 URL）', async () => {
    const { synthesizeSpeech } = await import('../../../aliyun/voice.js');
    (synthesizeSpeech as any).mockResolvedValueOnce(Buffer.alloc(0));
    const { synthesizeNarration } = await import('../tts-provider.js');
    await expect(synthesizeNarration({ text: 'x', jobId: 'job-empty' })).rejects.toThrow('合成结果为空');
  });

  it('字符数按传入文本长度计（供记账）', async () => {
    const { synthesizeNarration } = await import('../tts-provider.js');
    const r = await synthesizeNarration({ text: '一二三四五', jobId: 'job-charcount' });
    expect(r.charCount).toBe(5);
  });

  it('model 字段如实反映**实际**用的模型，不是恒写一个默认值', async () => {
    // synthesizeSpeech 内部按 voiceId 前缀分叉：qwen-tts-vc* 走 qwen3-tts-vc，
    // 其余走 BAILIAN_TTS_MODEL（默认 cosyvoice-v3-plus，判据在 voice.ts:125、分支在 :128）。
    // 恒写 cosyvoice-v3-plus 会让「用克隆音色」的那批 job 在 model 列上记错型号 ——
    // 而 model 列正是查「这批钱花在哪个模型上」的依据。
    const { synthesizeNarration } = await import('../tts-provider.js');
    const r = await synthesizeNarration({ text: 'x', voiceId: 'qwen-tts-vc-abc', jobId: 'job-qwen-a' });
    expect(r.model).toContain('qwen3-tts-vc');
  });

  // M5 补测：下面三个值原本没有任何防线，改掉后 5/5 依然全绿。
  it('默认音色、jobId、OSS mimeType 都如实透传（改掉不会被发现）', async () => {
    const { synthesizeSpeech } = await import('../../../aliyun/voice.js');
    const { uploadToOSS } = await import('../../../aliyun/oss.js');
    (synthesizeSpeech as any).mockClear();
    (uploadToOSS as any).mockClear();
    const { synthesizeNarration } = await import('../tts-provider.js');
    const r = await synthesizeNarration({ text: '古镇夜色', jobId: 'job-42' });
    // 1) 默认音色是既有约定值（routes/voice.ts:447 同样写死 longxing_v3），不能被静默换掉
    expect(synthesizeSpeech).toHaveBeenCalledWith('古镇夜色', 'longxing_v3', 1.0, 50);
    // 2) jobId 必须真的进到 OSS 键里，否则旁白 URL 与 job 脱钩（每次都变成时间戳）
    //    3) mimeType 必须是 audio/mpeg —— 键是 .mp3，OSS 侧靠它回 Content-Type
    expect(uploadToOSS).toHaveBeenCalledWith(
      Buffer.from('audio:古镇夜色'),
      'pms/wenlv/narration/job-42.mp3',
      'audio/mpeg',
    );
    expect(r.url).toContain('job-42.mp3');
  });

  // 下面两条钉住 model 记账列的分支**边界**。它们是两个存活变异体的杀手：
  //   M-J 把 TARGET_MODEL 默认值改成 'cosyvoice-v2'  → 第 1 条红
  //   M-K 把 qwen 前缀放宽成 'qwen-tts'              → 第 2 条红
  // 少了它们，「非克隆音色」那批（绝大多数）job 的 model 列无人看守。
  it('非 qwen 音色的 model 记 cosyvoice-v3-plus（默认值被改掉会红）', async () => {
    const { synthesizeNarration } = await import('../tts-provider.js');
    // 1) 不传 voiceId ⇒ 走默认音色 longxing_v3（非 qwen 前缀）⇒ CosyVoice 分支
    const rDefault = await synthesizeNarration({ text: 'x', jobId: 'job-default' });
    expect(rDefault.model).toBe('cosyvoice-v3-plus');
    // 2) 显式传非 qwen 前缀的音色，同样落在 CosyVoice 分支
    const rExplicit = await synthesizeNarration({ text: 'x', voiceId: 'longxing_v3', jobId: 'job-explicit' });
    expect(rExplicit.model).toBe('cosyvoice-v3-plus');
  });

  it('qwen 前缀判据严格是 `qwen-tts-vc`：近邻 `qwen-tts` 不落入 qwen 分支', async () => {
    const { synthesizeNarration } = await import('../tts-provider.js');
    // 1) 恰好以 qwen-tts-vc 开头 ⇒ qwen 克隆分支（与 voice.ts:125 的判据对齐）
    const rQwen = await synthesizeNarration({ text: 'x', voiceId: 'qwen-tts-vc-abc', jobId: 'job-qwen-b' });
    expect(rQwen.model).toContain('qwen3-tts-vc');
    // 2) 近邻但不匹配：'qwen-tts' 不带 -vc 后缀 ⇒ 必须走 CosyVoice 分支。
    //    若有人把前缀放宽成 'qwen-tts'，这条会红 —— 那意味着真正的克隆音色
    //    （qwen-tts-vc-*）虽仍走 qwen，但别的东西被误判进 qwen 分支、记错 model。
    const rNear = await synthesizeNarration({ text: 'x', voiceId: 'qwen-tts', jobId: 'job-near' });
    expect(rNear.model).toBe('cosyvoice-v3-plus');
  });

  // A1 音频格式嗅探。上面 5 条既有用例的桩返回 `audio:${text}`（无任何音频魔数）
  // ⇒ 落在嗅探的兜底分支，产出与改动前逐位一致 —— 那是本 Task 的回归判据。
  // 下面两条钉住嗅探的两侧：**认不出**的（ID3 头）走兜底仍是 mp3、**认出**的（OggS）改判 ogg。
  // 上面 5 条既有用例只覆盖「桩返回 `audio:${text}`」这一种兜底输入。
  it('上游回 ID3 头 → 对象键仍是 .mp3、MIME 仍是 audio/mpeg', async () => {
    // 实现里 ID3 **没有分支**，走的就是兜底；这条断言的是「兜底在端到端链路上确实生效」。
    // 它与 audio-type.test.ts 里「ID3 / MPEG 同步字 / 未知字节三者同值」那条契约测试**同强**：
    // 谁给 ID3 加一个返回别的格式的分支，两条都会红。
    // （单写一条独立的「ID3 → mp3」断言则是零区分力：兜底本来就是 mp3，删掉 ID3 逻辑它照样绿。）
    const { synthesizeSpeech } = await import('../../../aliyun/voice.js');
    const { uploadToOSS } = await import('../../../aliyun/oss.js');
    (synthesizeSpeech as any).mockClear();
    (uploadToOSS as any).mockClear();
    const id3 = Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00, 0x00, 0x00]);
    (synthesizeSpeech as any).mockResolvedValueOnce(id3);
    const { synthesizeNarration } = await import('../tts-provider.js');
    const r = await synthesizeNarration({ text: '古镇夜色', jobId: 'job-id3' });
    expect(uploadToOSS).toHaveBeenCalledWith(id3, 'pms/wenlv/narration/job-id3.mp3', 'audio/mpeg');
    expect(r.url).toContain('job-id3.mp3');
  });

  it('上游回 OggS 头 → 对象键尾缀 .ogg、MIME audio/ogg', async () => {
    // 这条是 A1 的核心判据：qwen 克隆分支**不发 input.format**（voice.ts:128-141），
    // 上游回 ogg 时旧实现会把它存成 `.mp3` + audio/mpeg（后缀与 Content-Type 双双说谎）。
    const { synthesizeSpeech } = await import('../../../aliyun/voice.js');
    const { uploadToOSS } = await import('../../../aliyun/oss.js');
    (synthesizeSpeech as any).mockClear();
    (uploadToOSS as any).mockClear();
    const ogg = Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]);
    (synthesizeSpeech as any).mockResolvedValueOnce(ogg);
    const { synthesizeNarration } = await import('../tts-provider.js');
    const r = await synthesizeNarration({ text: '古镇夜色', jobId: 'job-ogg' });
    expect(uploadToOSS).toHaveBeenCalledWith(ogg, 'pms/wenlv/narration/job-ogg.ogg', 'audio/ogg');
    expect(r.url).toMatch(/\.ogg$/);
  });

  it('mapNpcVoiceToDashScope：6 种火山 voice_id 映射到对应 DashScope 音色', async () => {
    const { mapNpcVoiceToDashScope } = await import('../tts-provider.js');
    expect(mapNpcVoiceToDashScope('male_young')).toBe('longfeifei_v3');
    expect(mapNpcVoiceToDashScope('male_middle')).toBe('longshu_v3');
    expect(mapNpcVoiceToDashScope('male_elder')).toBe('longanxuan_v3');
    expect(mapNpcVoiceToDashScope('female_young')).toBe('longhua_v3');
    expect(mapNpcVoiceToDashScope('female_middle')).toBe('longwan_v3');
    expect(mapNpcVoiceToDashScope('female_elder')).toBe('longjing_v3');
  });

  it('mapNpcVoiceToDashScope：空值/未知值回落默认 longxing_v3', async () => {
    const { mapNpcVoiceToDashScope } = await import('../tts-provider.js');
    expect(mapNpcVoiceToDashScope(null)).toBe('longxing_v3');
    expect(mapNpcVoiceToDashScope(undefined)).toBe('longxing_v3');
    expect(mapNpcVoiceToDashScope('')).toBe('longxing_v3');
    expect(mapNpcVoiceToDashScope('unknown_voice')).toBe('longxing_v3');
  });
});
