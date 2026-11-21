import { describe, it, expect } from 'vitest';
import { sniffAudioType } from '../audio-type.js';

describe('sniffAudioType（按魔数字节判音频格式，不看调用方声称的类型）', () => {
  it('OggS → ogg', () => {
    expect(sniffAudioType(Buffer.from([0x4f, 0x67, 0x67, 0x53, 0x00, 0x02, 0x00, 0x00]))).toEqual({ ext: 'ogg', mime: 'audio/ogg' });
  });

  it('RIFF....WAVE → wav', () => {
    const b = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('WAVE')]);
    expect(sniffAudioType(b)).toEqual({ ext: 'wav', mime: 'audio/wav' });
  });

  it('RIFF 但不是 WAVE（如 AVI）→ 兜底 mp3，不误判成 wav', () => {
    const b = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0, 0, 0, 0]), Buffer.from('AVI ')]);
    expect(sniffAudioType(b)).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
  });

  it('空 Buffer → 兜底 mp3（历史行为）', () => {
    expect(sniffAudioType(Buffer.alloc(0))).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
  });

  it('未知字节 → 兜底 mp3（历史行为，爆炸半径因此限定）', () => {
    expect(sniffAudioType(Buffer.from('audio:古镇夜色'))).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
  });

  // 契约：ID3 头与 MPEG 帧同步字**不单列分支**，产出与未知字节逐字段相同。
  // 这条对「将来有人给 ID3 加一个返回别的值的分支」有区分力 —— 那种改动一旦做出，
  // 它就不再与未知字节同值，而那是需要被看见的行为变更。
  // （反过来说：一条「ID3 → mp3」的独立断言在这里是**零区分力**的 ——
  //   实现收窄成只认 ID3、甚至删掉相关逻辑，它都照样绿，因为兜底本来就是 mp3。）
  it('ID3 头 / MPEG 帧同步字 / 未知字节三者产出完全相同', () => {
    const unknown = sniffAudioType(Buffer.from('audio:古镇夜色'));
    const id3 = sniffAudioType(Buffer.from([0x49, 0x44, 0x33, 0x03, 0x00, 0x00]));
    const ffSync = sniffAudioType(Buffer.from([0xff, 0xfb, 0x90, 0x00]));
    expect(unknown).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
    expect(id3).toEqual(unknown);
    expect(ffSync).toEqual(unknown);
  });

  // 兜底是**新对象**，不是模块级常量本体。共享单例被调用方就地改写会污染本进程内
  // 后续所有兜底结果 —— 一次误改，之后每次「认不出的输入」都返回被污染的值。
  it('兜底返回新对象：改一份不污染下一次', () => {
    const a = sniffAudioType(Buffer.from('未知输入-1'));
    a.ext = 'POLLUTED';
    a.mime = 'POLLUTED';
    expect(sniffAudioType(Buffer.from('未知输入-2'))).toEqual({ ext: 'mp3', mime: 'audio/mpeg' });
  });
});
