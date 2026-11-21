import { describe, it, expect } from 'vitest';
import { sniffImageType } from '../image-type.js';

/** 真实魔数前缀（取自生产实测：Seedream 返回的是 JPEG，此前却被写死成 .png）。 */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46]);
const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00]);
const WEBP = Buffer.concat([
  Buffer.from([0x52, 0x49, 0x46, 0x46]),          // "RIFF"
  Buffer.from([0x24, 0x00, 0x00, 0x00]),          // 长度
  Buffer.from([0x57, 0x45, 0x42, 0x50]),          // "WEBP"
]);

describe('sniffImageType', () => {
  it('JPEG 魔数 → jpg / image/jpeg', () => {
    expect(sniffImageType(JPEG)).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
  });

  it('PNG 魔数 → png / image/png', () => {
    expect(sniffImageType(PNG)).toEqual({ ext: 'png', mime: 'image/png' });
  });

  it('WEBP 魔数（RIFF....WEBP）→ webp / image/webp', () => {
    expect(sniffImageType(WEBP)).toEqual({ ext: 'webp', mime: 'image/webp' });
  });

  it('字节优先于 content-type 提示：JPEG 字节 + hint=image/png 仍判 jpg', () => {
    expect(sniffImageType(JPEG, 'image/png')).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
  });

  it('字节认不出时用 content-type 提示', () => {
    const unknown = Buffer.from([0x00, 0x01, 0x02, 0x03]);
    expect(sniffImageType(unknown, 'image/jpeg')).toEqual({ ext: 'jpg', mime: 'image/jpeg' });
    expect(sniffImageType(unknown, 'image/png; charset=binary')).toEqual({ ext: 'png', mime: 'image/png' });
  });

  it('字节与提示都认不出 → 退回历史行为（png），不是崩溃也不是空扩展名', () => {
    expect(sniffImageType(Buffer.from([0x00, 0x01]))).toEqual({ ext: 'png', mime: 'image/png' });
    expect(sniffImageType(Buffer.alloc(0), 'application/octet-stream')).toEqual({ ext: 'png', mime: 'image/png' });
  });

  it('太短的 buffer 不越界（只比前缀长度）', () => {
    // 不写 `expect(() => …).not.toThrow()`：下面这条断言已完整覆盖「不抛」——
    // 真抛了，用例会以抛出失败而非断言失败。功能上等价，这里只是不引入多余的调用。
    // ⚠️ 2026-09-19 更正：此注释原先给的理由（「桩未声明同步版 toThrow」）已不成立 ——
    //    该 matcher 自 d5a65359 起已在桩内。
    expect(sniffImageType(Buffer.from([0xff]))).toEqual({ ext: 'png', mime: 'image/png' });
  });
});
