/**
 * 视觉 LLM 调用（子项目① 评价层）。
 *
 * 与 `wenlv-asset-gen-scheduler.ts` 的 `callLlm` 是**兄弟**而不是替代：
 * `callLlm` 的 `content` 是字符串，用于「内容 → 画面描述」与风格基线自举；
 * 本函数收多模态 content，用于「看图打分」。两者共用同一个端点与 key
 * —— 端点与传输骨架在 `dashscope.ts`（本文件不持有 URL：那本就不是 vision 专属）。
 *
 * 走 DashScope **兼容模式**（OpenAI 形状）⇒ 只需换 content 形状，**不换供应商**。
 */

export type VisionContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/**
 * system 消息的 content 是**字符串**，user 消息的 content 是**parts 数组**。
 *
 * 刻意拆成两个类型再联合，而不是一个 `content: string | VisionContentPart[]`：
 * 后者允许 `{ role: 'system', content: [...] }` / `{ role: 'user', content: '文本' }`
 * 这类非法组合。
 *
 * ⚠️ 别把这次拆分读成「读 `content[i].image_url` 就不用窄化了」—— **不成立**，
 *    实测仍报 TS2339（`VisionContentPart` 自身是 `text | image_url` 的联合，
 *    取 part 属性一律要先窄化/整块比对）。拆分解决的是**角色与 content 形状的搭配**，
 *    不是 part 层的联合。
 */
export type VisionSystemMessage = { role: 'system'; content: string };
export type VisionUserMessage = { role: 'user'; content: VisionContentPart[] };
export type VisionMessage = VisionSystemMessage | VisionUserMessage;

/**
 * 评审模型。
 *
 * ⚠️ 此前这条注释写「绝不能回落到 `WENLV_PROMPT_MODEL`（兜底 `qwen-max`）」——
 *    **与实现不符**：本函数**根本没有** `WENLV_PROMPT_MODEL` 这条回落路径，
 *    空值兜底是 `qwen-vl-max`（**视觉**模型）。故「静默回落到纯文本」是
 *    **注释性风险**（仅在运维**显式**把 `WENLV_REVIEW_MODEL` 设成纯文本模型时才成立），
 *    不是代码里可达的路径。
 *    但显式误设仍是危险的：给纯文本模型发图不会报错，只会让打分变成
 *    **基于瞎猜的自信输出** —— 部署时别把 `WENLV_REVIEW_MODEL` 指到纯文本模型上。
 *    （对应账本 `BK-B4`，与 `BK-I2` 的记录合并：兜底实为视觉模型。）
 */
export function reviewModel(): string {
  const raw = (process.env.WENLV_REVIEW_MODEL ?? '').trim();
  return raw === '' ? 'qwen-vl-max' : raw;
}

/**
 * 文本块在前、图片块在后。顺序对兼容模式没有语义要求，但固定顺序便于快照比对。
 *
 * 返回**元组**（不是 `VisionMessage[]`）：调用方由此知道 `[0]` 恒为 system、`[1]` 恒为 user，
 * 不必先窄化**消息**类型。但 `content[i]` 仍是 `VisionContentPart` 联合，
 * 想读 `image_url.url` 还得再窄化（或整块比对）。
 *
 * ⚠️ 空 / 空白 URL **静默跳过**（不产出 `image_url: { url: '' }` 的畸形请求）。
 *    这带来一个对调用方**不可见**的风险：全部入参都是空串时，这里会安静地
 *    构造出一条**纯文本**请求。故 `callLlmVision` 在发请求前另行拒绝「一张都没有」。
 */
export function buildVisionMessages(
  system: string, userText: string, imageUrls: string[],
): [VisionSystemMessage, VisionUserMessage] {
  const parts: VisionContentPart[] = [{ type: 'text', text: userText }];
  for (const u of imageUrls) {
    const url = u.trim();
    if (url) parts.push({ type: 'image_url', image_url: { url } });
  }
  return [
    { role: 'system', content: system },
    { role: 'user', content: parts },
  ];
}
