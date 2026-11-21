/**
 * 文本完整性的**入口闸**：把「上游非致命解码」留下的坏字节变成一次响亮的 400。
 *
 * 机制：客户端送来的非 UTF-8 字节（典型是 Windows 控制台的 GBK 字节）被
 * `c.req.json()` 内部的 `TextDecoder` 按 UTF-8 做**非致命**解码 —— 非法字节被静默
 * 替换成 U+FFFD，不抛错、不打日志。PG 也不会拦（收到的已经是合法 UTF-8），于是脏值
 * 直接落库。**一旦落库就不可逆**：U+FFFD 只记「这儿有几个解不开的字节」，不记原字节
 * （实测三个不同 GBK 串 a1a1 / a3a1 / a1a3 的乱码完全相同）⇒ 原名再也无法机械还原。
 *
 * 生产实况：`pms_platform_users.name` 已有两行、`pms_bui_competitor_config` 已有 4 行
 * 这样坏掉。同源缺陷的另一处在另一服务的同一扇门，见
 * pms-platform-server/src/routes/users.ts 的 `noReplacementChar`。
 *
 * ⚠️ 这里**只**拒「已经损坏」的值，不碰任何合法输入：正常中文、emoji、空串一律放行。
 */

/** U+FFFD REPLACEMENT CHARACTER。
 *  用 `String.fromCharCode` 而不是字面字符或反斜杠转义：源码保持**纯 ASCII** ——
 *  这一整个缺陷说的就是「编码会静默吃掉东西」，闸自己的源码更不该留下可以被吃掉的字节。 */
export const REPLACEMENT_CHAR = String.fromCharCode(0xfffd);

/** 找出 `body` 里已损坏的**字符串**字段名（无损坏则空数组）。
 *
 *  - 只扫一层自有可枚举属性；非字符串（数字/布尔/null/嵌套对象/数组）一律不碰。
 *  - 空串**必须**放行：非必填文本字段前端就是送空串的。
 *  - 返回**全部**损坏字段，不是只报第一个 —— 一次改完比挤牙膏好。 */
/** 落库那条路径上会不会丢字符：`Buffer.from(str, 'utf8')` 把**孤立代理项**编成
 *  EF BF BD（U+FFFD）。与 `services/wenlv/asset-gen/enqueue.ts` 的 `fitName` 同一条
 *  口径 —— 那里靠按**码点**截断来「避免产生」孤立代理项，这里拦下已经从别处进来的。
 *  走代理对的 emoji 往返不变，不受影响。 */
function dropsOnEncode(value: string): boolean {
  return Buffer.from(value, 'utf8').toString('utf8') !== value;
}

export function findCorruptedTextFields(body: unknown): string[] {
  if (!body || typeof body !== 'object') return [];
  const corrupted: string[] = [];
  for (const [key, value] of Object.entries(body as Record<string, unknown>)) {
    if (typeof value !== 'string') continue;
    if (value.includes(REPLACEMENT_CHAR) || dropsOnEncode(value)) corrupted.push(key);
  }
  return corrupted;
}
