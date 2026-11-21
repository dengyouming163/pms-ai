/**
 * 素材提示词生成器（S3）。
 *
 * **纯函数**：不碰 DB、不调网络。防漂移的全部执行逻辑就在这里 ——
 * buildImagePrompt 把风格基线**整份**注入产物，测试逐字断言，
 * 任何「摘要式」改写都会让 prompt-builder.test.ts 变红。
 */
import type { WenlvStyleBible } from '../../../db/schema/wenlv.js';
import { ASSET_TYPES, ALL_ASSET_TYPES, type JobAssetType } from './asset-types.js';

/**
 * 素材类型 → 给 LLM 看的一句话说明（不影响画风，只影响画什么）。
 *
 * **唯一真源在 asset-types.ts 的注册表**（`promptLabel`）—— 本文件只做投影，不再另写一份：
 * 两处各写一份的代价是加类型时静默漏一处，漏掉的那一处会以「prompt 里出现英文类型名」
 * 的形式出现（见 `__tests__/prompt-builder.test.ts` 的负向断言）。
 *
 * ⚠️ 取的是 `promptLabel`（长说明），**不是 `label`**（短名）—— 后者是 job 名用的。
 *    取错了会改掉每一张图的提示词，且 `prompt-builder.test.ts` 会红。
 */
export const TYPE_LABEL = Object.fromEntries(
  ALL_ASSET_TYPES.map(t => [t, ASSET_TYPES[t].promptLabel]),
) as Record<JobAssetType, string>;

/**
 * 查表 + 回落成原字符串。**`buildScenePrompt` 只能走这里，不许直接 `TYPE_LABEL[k]`。**
 *
 * ⚠️ 这不是「顺手包的糖」，是 ts-check 的硬要求。`buildScenePrompt` 的 `assetType` 形参是
 *    **`string`**（DB 行上 `asset_type` 是 varchar ⇒ drizzle 推出来的就是 `string`；
 *    `scheduler:423` 传的是 `job.assetType`）。而 `TYPE_LABEL` 收窄成了
 *    `Record<JobAssetType, string>` —— 用 `string` 去索引它，在 `strict: true` 下是
 *    **TS7053**（"expression of type 'string' can't be used to index type
 *    'Record<JobAssetType, string>'"）。**已实测复现**。
 *    `vitest` 不做类型检查，所以本 Task 的测试**全绿也照样红 ts-check** ——
 *    这就是 Step 4 必须把 `pnpm ts-check` 一起跑的原因。
 *
 * ⚠️ 回落值用 `?? assetType`（原样返回英文类型名）是**有意**的：注册表外取值意味着
 *    上游漏了白名单，此处静默吞掉会让「prompt 里有英文类型名」这个症状消失，
 *    而那正是 `prompt-builder.test.ts` 的负向断言在抓的东西。让它原样透出去。
 */
export function promptLabelFor(assetType: string): string {
  return (TYPE_LABEL as Record<string, string>)[assetType] ?? assetType;
}

/** 把基线序列化成提示词的固定段落。**不裁剪、不摘要**。 */
function bibleBlock(b: WenlvStyleBible): string {
  const lines = [
    '【画风规范 · 必须严格遵守】',
    `画风：${b.artStyle ?? '（未指定）'}`,
    b.palette?.length ? `主色序列：${b.palette.join(' / ')}` : '',
    b.era ? `时代背景：${b.era}` : '',
    b.brushwork ? `笔触质感：${b.brushwork}` : '',
    b.mood ? `氛围基调：${b.mood}` : '',
    b.mustHave?.length ? `必须出现：${b.mustHave.join('、')}` : '',
    b.forbidden?.length ? `禁止出现：${b.forbidden.join('、')}` : '',
    b.notes ? `补充要求：${b.notes}` : '',
  ];
  return lines.filter(Boolean).join('\n');
}

/**
 * 拼装最终提示词：**基线（模板，确定性）+ 画面描述（来自 LLM）**。
 *
 * ⚠️ 这个函数是基线的**唯一注入点**，且它不接受任何 `previousPrompt` / `guidance` ——
 * 迭代反馈走 buildScenePrompt（喂给 LLM 当输入），不走这里。
 * 若有人把反馈重新塞进本函数，它就从「确定性模板」又变回了「可被自由发挥的提示词」，
 * 下面那条「同样输入逐字节相同」的测试会变红。
 */
export function buildImagePrompt(input: { bible: WenlvStyleBible; scene: string }): string {
  // 空基线守卫：与 style-bible.ts 的 `if (!bible.artStyle) throw` 同一条红线。
  // 少了它，bible 为 {} 时会产出「画风：（未指定）」的提示词继续出图 ——
  // 那是**静默放弃防漂移**，出的每一张都是漂移样本（spec §8）。
  // 本函数是基线的唯一注入点，这道守卫必须在这儿，不能指望上游。
  if (!input.bible?.artStyle) throw new Error('风格基线缺少 artStyle，拒绝出图（防漂移）');
  const scene = (input.scene ?? '').trim();
  if (!scene) throw new Error('画面描述为空，拒绝生成');
  return [bibleBlock(input.bible), '', '【画面】', scene].join('\n');
}

/**
 * 场景描述提示词（S3）：让 LLM 把**内容**翻译成画面描述。
 *
 * ⚠️ 分工是本设计的关键：**LLM 只做「内容 → 画面」的翻译，不碰画风。**
 * 风格由 buildImagePrompt 在**模板层确定性**拼上去。
 * 若让 LLM 顺带描述画风，它每次用词都有细微不同 —— 漂移就是这么来的。
 * 这也就是为什么「防漂移靠纯函数测试钉死」是成立的：基线根本不经过 LLM 的判断。
 */
export function buildScenePrompt(input: {
  productName: string;
  worldSetting?: unknown;
  nodeTitle: string;
  storyText?: string | null;
  assetType: string;
}): string {
  // 「故事内容：」整行**不得因 storyText 为空而消失**（收尾迭代片④ Task 8，账本 SP-collectible-13）。
  // 影响面是 collectible / reward / tier 三类 —— 它们的 `sourceText` 来自实体 `description`；
  // 描述为空串/缺省时旧写法整行被下面的 `.filter(Boolean)` 吃掉，LLM 只拿到
  // 「素材：<条目名>（类型）」这一行，**没有任何内容线索** ⇒ 出图质量下降。
  // 回落 `nodeTitle` 是当时**唯一就手**的内容线索（scheduler 已把它解析成条目真名）。
  //
  // ⚠️ **回落放在这儿（渲染层），不在 enqueue 改 `sourceText`**：`job.sourceText` 另有消费方
  //    （评审上下文 `reviewer.ts` 的「内容上下文：」、迭代行的原样继承 `enqueue.ts` 的
  //    `sourceText: parent.sourceText`、以及落库快照本身），改它等于改**快照语义**；
  //    而这条回落只影响渲染出的提示词，不碰落库数据。
  //
  // ⚠️ **与 `素材：` 那一行有意重复**：名字会同时出现在「素材：」与「故事内容：」两行。
  //    不去重 —— 去重要么改「素材：」行（它逐字节受 `prompt-builder-label.test.ts` 约束），
  //    要么让内容行变成空串，两条都比重复更坏（重复对 LLM 只是轻微冗余）。
  const storyLine = input.storyText || input.nodeTitle;
  const head = [
    `剧本：${input.productName}`,
    input.worldSetting ? `世界观：${JSON.stringify(input.worldSetting).slice(0, 1500)}` : '',
    `素材：${input.nodeTitle}（${promptLabelFor(input.assetType)}）`,
    storyLine ? `故事内容：${storyLine}` : '',
  ].filter(Boolean).join('\n');
  // 分隔空行不能丢进数组里被 filter(Boolean) 吃掉，否则上下文与指令糊成一段。
  return [
    head,
    '',
    '请把上述内容翻译成一段**画面描述**：写清场景、构图、主体、光线与氛围，1–2 句，具体可画。',
    '⚠️ 不要描述画风、色调、笔触或时代美术特征 —— 这些由统一规范指定，你不要提。',
    '不要解释，直接输出画面描述。',
  ].join('\n');
}

/**
 * 锚图提示词（S3）：只依据风格基线，**不含任何具体点位内容**。
 *
 * 它就是「这个剧本长什么样」的视觉定义 —— 因为它要被复用为**全部**素材的参考图，
 * 一旦带上某个点位的内容，它就从「画风样张」退化成「那一张的插图」，
 * 再拿它当参考会把全部素材拽向那个点位。
 */
export function buildAnchorPrompt(bible: WenlvStyleBible): string {
  return [
    bibleBlock(bible),
    '',
    '【本次素材】风格定调图（anchor）',
    '这是一张**画风样张**：只表现该剧本的世界观氛围与质感。',
    // 原来这里写的是「不要出现具体人物、具体故事情节或可辨认的地标」，
    // 但它与 bibleBlock 注入的 mustHave（定义就是「必须出现的视觉元素（场地标志物等）」）
    // 直接打架：同一段提示词既说「必须出现：古井」又说「不要出现可辨认的地标」。
    // 正确的区分不是「有没有地标」，而是「地标是氛围的一部分，还是画面的主角」——
    // 前者正是锚图要的，后者才会把它退化成「某一个点位的插图」。
    '不要描绘具体的故事情节或人物。上述「必须出现」的元素只作为氛围的一部分出现，',
    '不要以某一个具体点位为主角 —— 这张图会被复用为该剧本全部素材的视觉参考。',
    '',
    '只输出一段可直接用于文生图的中文描述，不要解释。',
  ].join('\n');
}

/** 旁白文本：直接取故事文本，不改写（AI 写的词不该被二次加工）。 */
export function buildTtsText(input: { storyText?: string | null }): string {
  const t = (input.storyText ?? '').trim();
  if (!t) throw new Error('旁白文本为空，拒绝合成空音频');
  return t;
}
