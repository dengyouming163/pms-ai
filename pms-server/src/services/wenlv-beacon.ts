// 信标设备台账的**纯函数层**：归一化与校验。无 DB 依赖，可穷尽单测。
//
// 为什么必须归一化 —— 这是本项目最容易**静默失效**的一处：
//   触发端是**精确相等比对**，而 UUID 的大小写未必在整条链路上保持不变
//   ——「安卓回小写、iOS 回大写」这个说法**未实测**（spec §7 第 2 项待确认），
//   别把它当既成事实用。但**无论实测结果如何**，比对前归一化一次都是对的，
//   本实现因此不依赖该结论。不归一化则失败是静默的：表现是「走到那儿没反应」，
//   日志里什么都不报。MAC 同理：贴纸的写法、BeaconSET 的显示、安卓 BLE 的
//   deviceId 三处格式未必一致。

const MAC_PLAIN = /^[0-9a-fA-F]{12}$/;
// ⚠️ 分隔符必须用**反向引用 `\1`** 钉成同一个，不能写成 `([0-9a-fA-F]{2}[:-]){5}`
//    —— 后者是**逐组独立**选分隔符，会把 `AA:BB-CC:DD-EE:FF` 这种混合串静默收成
//    合法 MAC，与本文件「只接受两种严格形态」的声明、以及测试里那条
//    `expect(normalizeMac('AA:BB-CC:DD-EE:FF')).toBeNull()` **直接矛盾**
//    （原稿正是那个写法 ⇒ 把它改回去，本测试文件里 `normalizeMac('AA:BB-CC:DD-EE:FF')`
//      那条会红，其余不受影响）。
const MAC_GROUPED = /^[0-9a-fA-F]{2}([:-])[0-9a-fA-F]{2}(?:\1[0-9a-fA-F]{2}){4}$/;

/** MAC 归一化：转大写、去分隔符。接受两种严格形态：
 *    ① 裸 12 位十六进制           `aabbccddeeff`
 *    ② 6 组 2 位、统一用 `:` 或 `-` 分隔  `AA:BB:CC:DD:EE:FF`
 *
 *  **有意不做「抽掉所有非十六进制字符」的宽松清洗** —— 那会把
 *  `ZZ:AA:BB:CC:DD:EE:FF` 这类垃圾串静默收成一个合法 MAC，
 *  于是现场登记时把设备身份写错还不报错。
 *
 *  非法输入一律返回 null ⇒ 调用方**必须**据此返 400，不要把 null 当合法值往下传
 *  （`mac` 是非空列，null 根本落不了库）。 */
export function normalizeMac(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim();
  if (MAC_PLAIN.test(s)) return s.toUpperCase();
  if (MAC_GROUPED.test(s)) return s.replace(/[:-]/g, '').toUpperCase();
  return null;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** iBeacon UUID 归一化：转小写。必须是 8-4-4-4-12 的十六进制。
 *  MAC 与 UUID 是两样东西（见 schema 注释），**不要互相复用**。
 *
 *  ⚠️ 本函数**不区分**「没传」与「非法」—— 两者都回 null（返回类型要保持 `| null`，
 *  它是有用的约束）。这个区分在写库那层是有意义的：`uuid` 是**可空列**，清空帧是
 *  合法操作。所以要写**结构性**的形态：让 `.nullable().optional()` 留在**最外层**，
 *  把「没传」和「显式 null」都交给 zod 自己短路，而**不要**写成内联的
 *  `v == null || …` 守卫 —— 内联写法必须额外保证 `.optional()` 不在里面，
 *  两件事只做一半就是一个静默注入。正确的链是：
 *  `.refine((v) => normalizeUuid(v) !== null, …)`
 *  + `.transform((v) => normalizeUuid(v)!)` + `.nullable().optional()`。
 *  ⚠️ 别把 `.optional()` 夹在 refine/transform **里面** —— 那样 refine 与 transform 对
 *  `undefined` 也会执行，`v == null ? null : …` 遂把「没传」折成 null，等价于
 *  `.default(null)`。（2026-09-21 在 zod 4.4.3 上实测：`{major:10001}` 会出来
 *  `{uuid:null}`。）同形的 major/minor 本来就是 `.optional()` 在最外层，只有 uuid 中招。
 *  写成 `patch.uuid = normalizeUuid(body.uuid)` 会把「这个字段没传」静默变成「清空帧」。 */
export function normalizeUuid(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const s = raw.trim().toLowerCase();
  return UUID_RE.test(s) ? s : null;
}

/** Major / Minor 的合法域：0..65535 的整数。
 *  依据是 iBeacon 广播帧的字段宽度：major/minor 各占 2 字节无符号
 *  （上限 2^16−1 = 65535），不是我们另挑的阈值。 */
export function isValidBeaconNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n) && n >= 0 && n <= 65535;
}
