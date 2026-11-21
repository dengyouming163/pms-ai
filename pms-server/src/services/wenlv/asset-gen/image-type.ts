/**
 * 由**字节魔数**判定图片类型。
 *
 * 为什么需要它：`wenlv-asset-gen-scheduler` 落 OSS 时曾把扩展名与 Content-Type
 * **写死**成 `.png` / `image/png`（计划原文如此），但字节 Seedream 实际返回的是 **JPEG**
 * —— 生产实测魔数为 `ff d8 ff e0`，而 OSS 上那个对象的 key 与 Content-Type 都说自己是 PNG。
 *
 * 后果不是「图裂」：浏览器与小程序都会嗅探字节，所以能正常显示。真正的代价是**元数据说谎** ——
 * 下载得到扩展名骗人的文件，将来任何按 Content-Type 分派的图像处理都会踩。
 * 这类错在前端永远看不见，也没有任何测试会红（provider 被 mock），只能靠对生产字节取证发现。
 *
 * 判定顺序（**字节优先**）：魔数 → `contentTypeHint` → 历史行为的 `png` 兜底。
 * 之所以最后退回 `png` 而不是 `bin`：那是本函数引入前**唯一**存在的行为，
 * 让「认不出的输入」与改动前逐位一致，把本次改动的爆炸半径限制在「认得出的格式」上。
 */
export function sniffImageType(
  buf: Buffer,
  contentTypeHint?: string | null,
): { ext: string; mime: string } {
  // 只比前缀：buffer 可能比魔数短（镜像源返回空体、被截断的响应），
  // `buf.subarray(0, n)` 对过短输入返回整段而非抛错，故这里天然不越界。
  const starts = (sig: number[], offset = 0) =>
    buf.length >= offset + sig.length &&
    sig.every((b, i) => buf[offset + i] === b);

  if (starts([0xff, 0xd8, 0xff])) return { ext: 'jpg', mime: 'image/jpeg' };
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: 'png', mime: 'image/png' };
  // WEBP 是容器：RIFF 开头、第 8 字节起为 "WEBP"（中间 4 字节是长度）。
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) {
    return { ext: 'webp', mime: 'image/webp' };
  }

  // 字节认不出时看上游声明的类型（有的源返回 octet-stream，但多数会说实话）。
  // 带参数的要剥掉（`image/png; charset=binary`）。
  const hint = (contentTypeHint ?? '').split(';')[0].trim().toLowerCase();
  if (hint === 'image/jpeg' || hint === 'image/jpg') return { ext: 'jpg', mime: 'image/jpeg' };
  if (hint === 'image/png') return { ext: 'png', mime: 'image/png' };
  if (hint === 'image/webp') return { ext: 'webp', mime: 'image/webp' };

  return { ext: 'png', mime: 'image/png' };
}
