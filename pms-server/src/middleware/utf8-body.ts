/**
 * UTF-8 请求体闸：把「客户端送来的**非 UTF-8 字节**」变成一次响亮的 400。
 *
 * 与 `src/lib/text-integrity.ts` 的分工（两者互补，不相取代）：
 *  - 那份是**字段级**闸：打进已解析的 JSON 对象、看值里含不含 U+FFFD。
 *    只能盖到它被接线的那些端点，且只能识别「已经损坏」的结果。
 *  - 本份是**字节级**闸：读原始 body 做**致命**解码。
 *    一处接线盖住本服务的**全部**端点，且拦在损坏**发生之前**。
 *
 * 为什么必须致命解码：`c.req.json()`（HonoRequest）内部走 `raw.text()`，而 `text()` 用的是
 * `TextDecoder` 的**非致命**模式 —— 非法字节被静默替换成 U+FFFD，不抛错、不记日志，
 * 于是脏值直接落库。PG 也不拦（收到的已经是合法 UTF-8），**且一旦落库就不可逆**：
 * U+FFFD 只记「这儿有几个解不开的字节」，不记原字节。
 * 同一份字节交给 `TextDecoder('utf-8', { fatal: true })` 会抛错 —— 那就是我们要的信号。
 *
 * ⚠️ **绝不能扩到 multipart/form-data**：文件字节本来就是任意二进制，
 * 对它做致命解码会把正常上传全部打成 400。故只对 JSON 体生效。
 *
 * ⚠️ 也不能因为 Content-Type 里声明了非 utf-8 的 charset 就一律拒：纯 ASCII 的 JSON
 * 在两种字符集下都合法、且不会损坏。所以 charset 只用来**改进报错文案**，不作拒绝依据。
 */
import type { MiddlewareHandler } from 'hono';

/** 只对 JSON 体做字节检查（含 `application/xxx+json` 这类结构化后缀）。 */
const JSON_CONTENT_TYPE = /^application\/(?:[a-z0-9.+-]*\+)?json\b/i;

/** 从 Content-Type 里取 charset（容忍引号与大小写）；没声明则 null。 */
function declaredCharset(contentType: string): string | null {
  const m = /;\s*charset\s*=\s*"?([^";]+)"?/i.exec(contentType);
  return m ? m[1].trim().toLowerCase() : null;
}

export const utf8BodyMiddleware: MiddlewareHandler = async (c, next) => {
  const contentType = c.req.header('content-type') ?? '';
  if (!JSON_CONTENT_TYPE.test(contentType)) return next();

  // 读原始**字节**。Hono 会把它缓存进 `bodyCache.arrayBuffer`，下游 `c.req.json()`
  // 走 `#cachedBody('text')` 时从**同一份缓存**派生（hono@4.12.18 的 `#cachedBody`
  // 是跨键派生的）⇒ 不会二次读网络、也不会把 body 读空。故**无需 clone**。
  const bytes = await c.req.arrayBuffer();
  if (bytes.byteLength === 0) return next();

  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    const charset = declaredCharset(contentType);
    const hint = charset && charset !== 'utf-8' && charset !== 'utf8'
      ? `请求体声明的字符集是 ${charset}`
      : '客户端很可能用 GBK 等本地编码发送了中文';
    return c.json(
      { success: false, error: `请求体不是合法的 UTF-8（${hint}），请以 UTF-8 编码重新提交` },
      400,
    );
  }

  return next();
};
