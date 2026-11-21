import { db } from '../../../db/index.js';
import { pmsBuiWenlvNpcs } from '../../../db/schema/index.js';
import { eq, sql } from 'drizzle-orm';
import type { WenlvNpcMention } from '../../../db/schema/wenlv.js';

/**
 * 把一次 NPC 提及写入目标 NPC 的 pending_mentions 队列。
 * 用 jsonb_concat 追加（不覆盖已有队列），原子操作避免并发丢失。
 */
export async function queueMention(opts: {
  targetNpcId: string;
  fromNpcId: string;
  fromNpcName: string;
  context: string;
}): Promise<void> {
  const mention: WenlvNpcMention = {
    fromNpcId: opts.fromNpcId,
    fromNpcName: opts.fromNpcName,
    context: opts.context,
    ts: Date.now(),
  };
  // jsonb_concat：'||=' 等价于 jsonb 末尾追加
  await db.update(pmsBuiWenlvNpcs)
    .set({ pendingMentions: sql`COALESCE(${pmsBuiWenlvNpcs.pendingMentions}, '[]'::jsonb) || ${JSON.stringify([mention])}::jsonb` })
    .where(eq(pmsBuiWenlvNpcs.id, opts.targetNpcId));
}

/**
 * 读取并清空目标 NPC 的 pending_mentions 队列。
 * 章节开始时调用，把队列内容注入 prompt，然后清空（避免下次还重复注入）。
 */
export async function drainMentions(npcId: string): Promise<WenlvNpcMention[]> {
  const [npc] = await db.select({ pendingMentions: pmsBuiWenlvNpcs.pendingMentions })
    .from(pmsBuiWenlvNpcs)
    .where(eq(pmsBuiWenlvNpcs.id, npcId))
    .limit(1);
  if (!npc || !npc.pendingMentions?.length) return [];
  // 清空队列
  await db.update(pmsBuiWenlvNpcs)
    .set({ pendingMentions: [] })
    .where(eq(pmsBuiWenlvNpcs.id, npcId));
  return npc.pendingMentions;
}
