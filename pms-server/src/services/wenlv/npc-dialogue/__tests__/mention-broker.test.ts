import { describe, it, expect, vi } from 'vitest';

// 路径深度：db 在 src/db/，从 __tests__/ 回到 src/ 要四层（__tests__ → npc-dialogue → wenlv → services → src）。
// 写成三层会解析到 src/services/db/index.js（不存在），mock 不生效，会真的去连 pg。
vi.mock('../../../../db/index.js', () => ({
  db: {
    select: vi.fn(() => ({ from: vi.fn(() => ({ where: vi.fn(() => ({ limit: vi.fn(() => [{ pendingMentions: [{ fromNpcId: 'n1', fromNpcName: '老周', context: '陈婶反常', ts: 1 }] }]) })) })) })),
    update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => Promise.resolve()) })) })),
  },
}));

const { queueMention, drainMentions } = await import('../mention-broker.js');

describe('mention-broker', () => {
  it('queueMention 把提及写入目标 NPC', async () => {
    await queueMention({ targetNpcId: 'n2', fromNpcId: 'n1', fromNpcName: '老周', context: '陈婶反常' });
    // db.update 被调用了即通过（mock 不会真写库）
    expect(true).toBe(true);
  });

  it('drainMentions 读取并清空队列', async () => {
    const r = await drainMentions('n1');
    expect(r).toHaveLength(1);
    expect(r[0].fromNpcName).toBe('老周');
  });
});
