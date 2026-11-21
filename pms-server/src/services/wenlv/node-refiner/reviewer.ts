// 第三层：AI 语义评审（spec §6.2）。只评风格/世界观/连贯性；任何失败都降级放行。
import { chatJsonObject } from './llm-client.js';
import type { RefineAnchor } from './anchor-builder.js';
import type { RefineDraft } from './schema.js';

export interface ReviewResult { ok: boolean; comment: string }

export async function reviewDraft(anchor: RefineAnchor, draft: RefineDraft): Promise<ReviewResult> {
  try {
    const system = '你是剧本杀主编审。只检查节点内容与剧本世界观的年代/文风/称谓一致性、与前后节点的连贯性。输出 JSON：{"ok":boolean,"comment":string}。';
    const user = `剧本：《${anchor.product.name}》世界观 ${JSON.stringify(anchor.product.theme)}\n节点草稿：${JSON.stringify(draft)}\n前驱：${JSON.stringify(anchor.neighbors.prev)}\n后继：${JSON.stringify(anchor.neighbors.next)}`;
    const r = await chatJsonObject({ system, user, temperature: 0.2 }) as any;
    return { ok: r?.ok !== false, comment: typeof r?.comment === 'string' ? r.comment : '' };
  } catch (e) {
    // 评审是增强而非门禁：失败不阻断，错误由调用方记录
    return { ok: true, comment: `review skipped: ${(e as Error).message}` };
  }
}
