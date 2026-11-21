// theme.primaryColor 落库前的剥离。
// 为什么需要：primaryColor 有两条**绕过创作台表单**的写入路径 ——
//   ① pms-ai-crew/src/services/wenlv_persist.py 的 AI 建档（POST /products）；
//   ② pms-wenlv-web/src/components/wenlv-ai/refine-panel.tsx 的 AI 精修（PATCH /products/:id，
//      把 LLM 返回的 visual.colors.primary 直接塞进 theme.primaryColor）。
// 两者取的都是 LLM 输出，服务端剥离是它们唯一的共同兜底
// （创作台表单自己的失焦校验只护得住手输那一条路径）。

// 色值文法与 pms-nimi/src/utils/wenlv-theme.ts 的 safeColor 同口径：改一处必须同步另一处
// （跨模块禁止 import，故此处照抄那三个正则）。
// 为什么服务端比创作台宽（创作台只收纯 hex）：这层只兜「能不能渲染」，
// rgb()/hsl() 经 var() 注入能正常渲染，销毁它属于误伤；创作台更严是因为那里的值还要喂原生取色器。
// 为什么只处理 primaryColor：resolveProductTokens() 只读 theme.primaryColor 这一个字段，
// theme.colors 全仓零消费方（死字段），动它属于空转。

// 合法 hex 只有 3/4/6/8 位；5、7 位在 CSS 里是非法长度
// （只做字符白名单会漏过 `#12345` 这类「字符全合法但 CSS 非法」的值）
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
// rgb()/rgba()：必须给满 3 个分量（拦住 `rgb(1,2)` 这类残缺写法），可选 alpha（逗号或斜杠语法）
const RGB_COLOR = /^rgba?\(\s*\d{1,3}%?\s*[,\s]\s*\d{1,3}%?\s*[,\s]\s*\d{1,3}%?\s*(?:[,/]\s*\d*\.?\d+%?\s*)?\)$/i;
// hsl()/hsla()：色相可带角度单位，后接两个百分比分量，可选 alpha
const HSL_COLOR = /^hsla?\(\s*-?\d*\.?\d+(?:deg|grad|rad|turn)?\s*[,\s]\s*\d{1,3}%?\s*[,\s]\s*\d{1,3}%?\s*(?:[,/]\s*\d*\.?\d+%?\s*)?\)$/i;

/**
 * 是否为合法 CSS 颜色字面量（与 pms-nimi/src/utils/wenlv-theme.ts 的 safeColor 同口径）。
 * 只接受 #hex（3/4/6/8 位）与 rgb()/rgba()/hsl()/hsla() 函数形式（函数名大小写不敏感），长度 ≤64。
 * 有意**不接受**颜色关键字（如 `red`）：白名单外的一律拒绝，宁可回落 SCSS 兜底也不错染。
 */
export function isSafeCssColor(v: unknown): v is string {
  if (typeof v !== 'string') return false;
  const s = v.trim();
  if (s.length === 0 || s.length > 64) return false;
  return HEX_COLOR.test(s) || RGB_COLOR.test(s) || HSL_COLOR.test(s);
}

/** 普通对象判断：排除 null / 数组 / Date 等非普通对象（后两者原样返回，不炸也不改写） */
function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (typeof v !== 'object' || v === null) return false;
  const proto = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

/**
 * 剥离 theme 中非法的 primaryColor，其余字段一字不动。
 * 为什么剥离而非拒绝（400）：AI 建档/精修的色值来自 LLM 输出，
 * 改成 400 会让偶尔的脏值打断整条 AI 链路。剥离让脏值静默丢失、前端回落 SCSS，链路不中断。
 * 为什么只处理 primaryColor：resolveProductTokens() 只读这一个字段，
 * theme.colors 全仓无消费方（死字段），动它属于空转。
 *
 * ⚠️ TODO / @deprecated 风险 —— `theme.colors`：本函数**有意不校验** `theme.colors.*`，
 * 前提是它当前**没有消费方**（死字段，见 schema/wenlv.ts 的 WenlvTheme 注释）。
 * 一旦有人接上 `theme.colors.*` 的消费方，它会立刻变成**无守卫的注入口**
 * （`theme.colors.primary` 同样经 `var()` 进 `background`/`color`）。
 * **启用前必须先在此补同口径校验**（`isSafeCssColor` + 删键），否则不要启用该字段。
 *
 * 退出条件（冻结，勿扩展）：
 *  ① 入参不是普通对象 → 原样返回（不炸）；
 *  ② primaryColor 缺失 / null / 空串 / 非法 → 删除该键
 *     （空串经 var() 注入同样会触发 IACVT，不能留）；
 *  ③ primaryColor 是合法 CSS 颜色 → 原样保留。
 *
 * 其余字段（含未知键）一律保留：**拷贝后按需删键，而非白名单重建对象** ——
 * 白名单会静默丢掉未来新增的 theme 字段。
 */
export function sanitizeWenlvTheme<T>(theme: T): T | Record<string, unknown> {
  // ① 非普通对象（undefined / null / 字符串 / 数组…）原样返回：调用方沿用既有 z.any() 的宽口径，不额外收紧
  if (!isPlainObject(theme)) return theme;
  // ③ 合法色值：返回拷贝，保证调用方拿到的永远是新对象（避免就地改写入参）
  if (isSafeCssColor(theme.primaryColor)) return { ...theme };
  // ② 缺失 / null / 空串 / 非法：删键后返回
  const out = { ...theme };
  delete out.primaryColor;
  return out;
}
