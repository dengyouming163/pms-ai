/**
 * 阿里云 OSS 上传服务
 * 使用 REST API + HMAC-SHA1 签名，无需额外 SDK 依赖
 */
import crypto from 'crypto';

const OSS_REGION = process.env.OSS_REGION || 'oss-cn-beijing';
const OSS_BUCKET = process.env.OSS_BUCKET || 'pms-zhisu';
const ACCESS_KEY = process.env.ALIYUN_ACCESS_KEY_ID || '';
const SECRET = process.env.ALIYUN_ACCESS_KEY_SECRET || '';

function getOSSConfig() {
  if (!ACCESS_KEY || !SECRET) throw new Error('未配置 ALIYUN_ACCESS_KEY_ID / ALIYUN_ACCESS_KEY_SECRET');
  return { region: OSS_REGION, bucket: OSS_BUCKET, accessKey: ACCESS_KEY, secret: SECRET };
}

function hmacSha1(key: string, data: string): Buffer {
  return crypto.createHmac('sha1', key).update(data).digest();
}

/** 生成 OSS 签名 */
function generateSignature(
  method: string,
  bucket: string,
  objectKey: string,
  headers: Record<string, string>,
  expires: number,
): string {
  const date = new Date().toUTCString();
  const contentType = headers['Content-Type'] || 'application/octet-stream';
  const stringToSign = [
    method,
    '',
    contentType,
    date,
    `/${bucket}/${objectKey}`,
  ].join('\n');
  return crypto.createHmac('sha1', SECRET).update(stringToSign).digest('base64');
}

/** 创建 Bucket（如果不存在） */
async function ensureBucket() {
  const { region, bucket, accessKey } = getOSSConfig();
  const host = `${bucket}.${region}.aliyuncs.com`;
  const date = new Date().toUTCString();
  const signStr = `PUT\n\n\n${date}\n/${bucket}/`;
  const signature = crypto.createHmac('sha1', SECRET).update(signStr).digest('base64');
  try {
    const res = await fetch(`https://${host}/`, {
      method: 'PUT',
      headers: { 'Date': date, 'Authorization': `OSS ${accessKey}:${signature}`, 'Content-Type': 'application/xml' },
      body: '<CreateBucketConfiguration><StorageClass>Standard</StorageClass></CreateBucketConfiguration>',
    });
    if (res.status === 409) return; // AlreadyExists
    if (res.ok || res.status === 409) {
      console.log('[OSS] Bucket 就绪:', bucket);
    } else {
      const text = await res.text();
      if (!text.includes('BucketAlreadyExists')) console.error('[OSS] 创建Bucket失败:', text.substring(0, 200));
    }
  } catch (e: any) {
    console.error('[OSS] 创建Bucket异常:', e.message);
  }
}

/**
 * `uploadToOSS` 单次转存的**挂起上限**（毫秒）。
 *
 * ⚠️ **这是一个判断值，不是实测值。** 没有任何针对生产 payload 的时延测量（本仓无从取得），
 * 取值来自下面这段定性取舍，不来自 benchmark：
 *
 * - 定性：这不是延迟 SLA，而是**挂起断路器** —— 目标是给「一个永不返回的 fetch」封顶，
 *   把「无界」变成「有界」，而不是给正常上传设一个性能目标。
 * - 该函数最重的合法用户是两条 `.mp4` 视频转存（`routes/video-promo.ts` 的视频备份、
 *   `services/mediakit/client.ts` 的成片），payload 量级与音频/图片相差数个数量级。
 * - **取值过小的代价可能比原缺陷更糟**：大文件在慢链路上被我们自己掐断 ⇒ 原本能成功的
 *   上传开始失败，那是**引入**一个新的失败模式。
 * - 取值过大则挂起迟迟不解 ⇒ 仍有界（优于 ∞），但断路器迟钝。
 *
 * 5 分钟是这两端之间的取舍。要改它，请先拿出这两条 `.mp4` 路径的**实测**时延分布，
 * 而不是在这里拍第二个数。
 *
 * 导出是为了让调用方按需覆盖（第 4 个参数）：测试注入短值，免去 5 分钟的真等待。
 */
export const OSS_UPLOAD_TIMEOUT_MS = 300_000;

/**
 * 判定 fetch 的失败是否来自 `AbortSignal.timeout`。
 *
 * Node 超时中止时抛 `DOMException`，其 `name` 为 `'TimeoutError'`（个别运行时表现为
 * `'AbortError'`）。本函数**只**认这两个名字：其余网络错误（DNS / 连接被拒 / TLS）必须
 * 原样上抛，不能被归成「超时」—— 那会把故障类别诊断错。
 */
function isTimeoutAbort(e: unknown): boolean {
  const name = (e as { name?: unknown } | null | undefined)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** 上传文件到 OSS。超时上限见 `OSS_UPLOAD_TIMEOUT_MS`。 */
export async function uploadToOSS(
  buffer: Buffer,
  filename: string,
  mimeType: string = 'application/octet-stream',
  // 可选 + 带默认值 ⇒ **既有 11 处调用点一处都不用改**（routes/upload.ts、routes/voice.ts ×3、
  // routes/video-promo.ts ×3、routes/mediakit-batch.ts、services/mediakit/client.ts、
  // services/wenlv-asset-gen-scheduler.ts、services/wenlv/asset-gen/tts-provider.ts）。
  // 测试靠它注入短值。
  timeoutMs: number = OSS_UPLOAD_TIMEOUT_MS,
): Promise<string> {
  const { region, bucket, accessKey } = getOSSConfig();
  const host = `${bucket}.${region}.aliyuncs.com`;
  const date = new Date().toUTCString();
  const objectKey = filename;

  // 计算 Content-MD5（OSS V1 签名要求带 body 时必须提供）
  const contentMD5 = crypto.createHash('md5').update(buffer).digest('base64');

  const signStr = `PUT\n${contentMD5}\n${mimeType}\n${date}\n/${bucket}/${objectKey}`;
  const signature = crypto.createHmac('sha1', SECRET).update(signStr).digest('base64');

  const url = `https://${host}/${objectKey}`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': mimeType,
        'Content-MD5': contentMD5,
        'Date': date,
        'Authorization': `OSS ${accessKey}:${signature}`,
      },
      // Buffer 转 Blob：Blob 明确属于 fetch BodyInit 联合类型（Buffer<ArrayBufferLike> 不在其内）
      body: new Blob([buffer.buffer as ArrayBuffer]),
      // 给这一跳封顶：此前本文件 `timeout|AbortSignal|signal` 全篇零命中，没有 signal 时
      // 一个卡住的连接会让上面这个 await 永不返回（无界）。**这一跳的类型**：注意图片生成侧
      // 本来就有超时（`wenlv/asset-gen/image-provider.ts` 的 `TIMEOUT_MS`），无界的只有 OSS 转存。
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    // 超时**不得被吞**：包一层让「是超时」一眼可见（含毫秒数），并保留原错（`cause`）。
    // 非超时的网络错误**原样重抛** —— 不在这里改变它们的形态，也不动「缺凭据早失败」
    // 的语义（那条路径由 `getOSSConfig()` 在 fetch 之前抛出，根本走不到这里）。
    if (isTimeoutAbort(e)) {
      throw new Error(`OSS上传超时: 超过 ${timeoutMs}ms 未完成（${url}）`, { cause: e });
    }
    throw e;
  }

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`OSS上传失败: ${res.status} ${text}`);
  }

  return `https://${host}/${filename}`;
}

/**
 * OSS 公开访问前缀：`https://{bucket}.{region}.aliyuncs.com`。
 *
 * **刻意不校验凭据。** 拼一个公开 URL 不需要 AK/SK，而上面那个 `getOSSConfig()` 在缺凭据时
 * **抛错** —— 用它会让「只想拼个 BGM 地址」的纯读路径在没配 OSS 凭据的环境（本地 / CI）
 * 直接崩掉。上传路径仍然走 `getOSSConfig()`，凭据缺失照旧早失败，安全性不变。
 */
export function getOSSBaseUrl(): string {
  // 与文件头的 OSS_REGION / OSS_BUCKET 同源（同一份 env 与同一组默认值）
  return `https://${OSS_BUCKET}.${OSS_REGION}.aliyuncs.com`;
}

/** 获取 OSS 公开访问 URL */
export function getOSSUrl(filename: string): string {
  return `${getOSSBaseUrl()}/${filename}`;
}
