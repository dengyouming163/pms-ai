// /api/mini/wenlv/dialogue/tts（H3）：非 DB 单测 —— parseMiniToken 纯 JWT 校验不触库；
// TTS/OSS 三个下游服务一律 vi.mock 桩掉（不真合成、不真上传）。
process.env.MINI_JWT_SECRET = process.env.MINI_JWT_SECRET || 'unit-test-mini-secret';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import jwt from 'jsonwebtoken';
import dialogueRoute from '../wenlv-dialogue.js';
import { mapNpcVoiceToDashScope } from '../../../services/wenlv/asset-gen/tts-provider.js';
import { synthesizeSpeech } from '../../../services/aliyun/voice.js';
import { uploadToOSS } from '../../../services/aliyun/oss.js';

vi.mock('../../../services/wenlv/asset-gen/tts-provider.js', () => ({
  mapNpcVoiceToDashScope: vi.fn((v: string | null | undefined) => `dash-${v ?? 'none'}`),
}));
vi.mock('../../../services/aliyun/voice.js', () => ({
  synthesizeSpeech: vi.fn(),
}));
vi.mock('../../../services/aliyun/oss.js', () => ({
  uploadToOSS: vi.fn(),
}));

const signMini = (id: string) =>
  jwt.sign({ miniUserId: id, openid: 'o_' + id }, process.env.MINI_JWT_SECRET!, { audience: 'mini', expiresIn: '1h' });

const post = (body: unknown, token?: string) =>
  dialogueRoute.request('/tts', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  vi.clearAllMocks();
  // 本仓 vitest 类型定义无 vi.mocked（运行时有），按仓内惯例用 `as any` 取 mock 能力。
  (synthesizeSpeech as any).mockResolvedValue(Buffer.from('mp3-bytes'));
  (uploadToOSS as any).mockResolvedValue('https://oss.test/tts.mp3');
});

describe('POST /api/mini/wenlv/dialogue/tts', () => {
  it('未登录 ⇒ 401', async () => {
    const res = await post({ text: '你好' });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: '未登录' });
  });

  it('缺 text ⇒ 400', async () => {
    const res = await post({ voiceId: 'male_young' }, signMini('u-tts-1'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: '缺少文本' });
  });

  it('成功 ⇒ voiceId 走 DashScope 映射，合成并上传，返回 audioUrl', async () => {
    const res = await post({ text: '客栈掌柜抬头看你。', voiceId: 'male_young' }, signMini('u-tts-2'));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, audioUrl: 'https://oss.test/tts.mp3' });
    expect(mapNpcVoiceToDashScope).toHaveBeenCalledWith('male_young');
    expect(synthesizeSpeech).toHaveBeenCalledWith('客栈掌柜抬头看你。', 'dash-male_young', 1.0, 50);
    expect(uploadToOSS).toHaveBeenCalledTimes(1);
    expect(String((uploadToOSS as any).mock.calls[0][1])).toContain('dialogue-tts/');
    expect((uploadToOSS as any).mock.calls[0][2]).toBe('audio/mpeg');
  });

  it('voiceId 缺省 ⇒ 仍必须走映射兜底（mapNpcVoiceToDashScope(undefined)）', async () => {
    await post({ text: '默认音色' }, signMini('u-tts-3'));
    expect(mapNpcVoiceToDashScope).toHaveBeenCalledWith(undefined);
  });

  it('伪造 token ⇒ 401', async () => {
    const res = await post({ text: '你好' }, 'garbage-token');
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ success: false, error: '未登录' });
  });

  it('超长文本 ⇒ 400 文本过长（>2000 字拒绝，不触发合成）', async () => {
    const res = await post({ text: 'a'.repeat(2001) }, signMini('u-tts-5'));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: '文本过长' });
    expect(synthesizeSpeech).not.toHaveBeenCalled();
  });

  it('合成抛错 ⇒ 500 + 固定文案不泄漏原始 message', async () => {
    // 500 回固定文案（no-raw-error-leak 守卫：err.message 不得直返 HTTP 响应），
    // 原始错误只进服务端日志。
    (synthesizeSpeech as any).mockRejectedValue(new Error('TTS 上游挂了'));
    const res = await post({ text: '触发失败' }, signMini('u-tts-4'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ success: false, error: 'TTS 合成失败，请稍后重试' });
    expect(JSON.stringify(body)).not.toContain('TTS 上游挂了');
  });
});
