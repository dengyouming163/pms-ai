import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.hoisted 已在 src/types/vitest.d.ts 有正式声明；这里沿用既有 (vi as any) 写法，不做批量替换。
const { chatMock, anchorMock, reviewMock } = (vi as any).hoisted(() => ({
  chatMock: vi.fn(),
  anchorMock: vi.fn(),
  reviewMock: vi.fn(),
}));

vi.mock('../llm-client.js', () => ({ chatJsonObject: (o: any) => chatMock(o) }));
// 部分 mock：沿用仓内惯例（工厂整体 as any + importOriginal 形参取真模块），保留真实导出仅覆盖 buildRefineAnchor。
vi.mock('../anchor-builder.js', (async (importOriginal: any) => ({
  ...(await importOriginal()),
  buildRefineAnchor: (...a: any[]) => anchorMock(...a),
})) as any);
vi.mock('../reviewer.js', () => ({ reviewDraft: (...a: any[]) => reviewMock(...a) }));

import { refineNode } from '../index.js';

const anchor = {
  product: { id: 'p1', name: '将军令', subtitle: null, theme: {}, config: {}, styleBible: null },
  node: { id: 'n1', nodeType: 'scene', title: '村口' }, venuePointName: null,
  whitelist: { collectibles: [{ id: 'c1', name: '铜钱', type: 'clue' }], npcs: [{ id: 'npc1', name: '老周' }], characters: [], nodes: [{ id: 'n1', title: '村口', nodeType: 'scene' }] },
  neighbors: { prev: [], next: [] },
};

const sceneDraft = { targetType: 'scene', title: '村口', storyText: '夜深。', puzzle: null, grants: [], requires: null, chapterGoal: null, openingLine: null, arDialogue: null, npcId: null, newNpc: null, notes: '' };

beforeEach(() => { vi.clearAllMocks(); anchorMock.mockResolvedValue(anchor); reviewMock.mockResolvedValue({ ok: true, comment: '' }); });

describe('refineNode', () => {
  it('首轮合法直接返回', async () => {
    chatMock.mockResolvedValueOnce(sceneDraft);
    const out = await refineNode('p1', 'n1', 'keep');
    expect(out.draft.title).toBe('村口');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
  it('校验不过带错重试，第二轮通过', async () => {
    chatMock
      .mockResolvedValueOnce({ ...sceneDraft, grants: ['ghost'] })
      .mockResolvedValueOnce(sceneDraft);
    const out = await refineNode('p1', 'n1', 'keep');
    expect(out.draft.grants).toEqual([]);
    expect(chatMock).toHaveBeenCalledTimes(2);
    expect(chatMock.mock.calls[1][0].user).toContain('上一轮需要修正');
  });
  it('两轮仍非法则抛错', async () => {
    chatMock.mockResolvedValue({ ...sceneDraft, grants: ['ghost'] });
    await expect(refineNode('p1', 'n1', 'keep')).rejects.toThrow(/校验/);
    // 钉死 VALIDATE_ATTEMPTS=2：mock 对所有调用恒返回非法稿，调用次数必须恰为 2，防止轮数被改成 3
    expect(chatMock).toHaveBeenCalledTimes(2);
  });
  it('评审不通过触发一次重生', async () => {
    chatMock.mockResolvedValueOnce(sceneDraft).mockResolvedValueOnce({ ...sceneDraft, storyText: '修正后' });
    reviewMock.mockResolvedValueOnce({ ok: false, comment: '文风出戏' }).mockResolvedValueOnce({ ok: true, comment: '' });
    const out = await refineNode('p1', 'n1', 'keep');
    expect(out.draft.storyText).toBe('修正后');
  });
  it('评审不通过但重生稿确定性校验失败时保留原合格稿', async () => {
    // vitest 的 clearAllMocks 只清调用记录、不清 once 实现队列，前一用例残留会插队，先 reset 保证队列干净
    chatMock.mockReset();
    reviewMock.mockReset();
    // 首轮原稿结构 + 确定性校验均通过；评审打回后的重生稿 grants 越权（ghost 不在白名单）
    chatMock
      .mockResolvedValueOnce(sceneDraft)
      .mockResolvedValueOnce({ ...sceneDraft, grants: ['ghost'] });
    // 干净队列上只覆盖首次评审为不通过（不应发生第二次评审）
    reviewMock.mockResolvedValueOnce({ ok: false, comment: '文风出戏' });
    const out = await refineNode('p1', 'n1', 'keep');
    // 安全降级：重生稿不合格则保留原稿（确定性校验优先于语义偏好）
    expect(out.draft.grants).toEqual([]);
    expect(out.draft.storyText).toBe('夜深。');
    expect(chatMock).toHaveBeenCalledTimes(2);
    // 重生后不再二次评审
    expect(reviewMock).toHaveBeenCalledTimes(1);
  });
  it('首轮 schema 结构不合法时带结构错误反馈重试，第二轮通过', async () => {
    // 同上：先 reset 清掉前序用例未消费完的 once 队列
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // title 空串违反 z.string().min(1)；实现只强制覆盖 targetType，触碰不到 title，safeParse 必然失败
    chatMock
      .mockResolvedValueOnce({ ...sceneDraft, title: '' })
      .mockResolvedValueOnce(sceneDraft);
    const out = await refineNode('p1', 'n1', 'keep');
    expect(out.draft.title).toBe('村口');
    expect(chatMock).toHaveBeenCalledTimes(2);
    // 第二轮 prompt 必须带结构错误反馈段及出错字段路径
    const secondUser = chatMock.mock.calls[1][0].user;
    expect(secondUser).toContain('上一轮需要修正的问题');
    expect(secondUser).toContain('title');
    // 第二轮合格进入评审且评审通过，不再重生
    expect(reviewMock).toHaveBeenCalledTimes(1);
  });
  it('显式 targetType 与 linkNpcId 透传到 prompt', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    const npcDraft = {
      targetType: 'npc',
      title: '村口',
      storyText: '夜深。',
      puzzle: null,
      grants: [],
      requires: null,
      chapterGoal: { type: 'reveal', description: 'd', answerCriteria: [], minTurns: 2 },
      openingLine: '嗨',
      arDialogue: null,
      npcId: 'npc1',
      newNpc: null,
      notes: '',
    };
    chatMock.mockResolvedValueOnce(npcDraft);
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    const firstUser = chatMock.mock.calls[0][0].user;
    expect(firstUser).toContain('【本次目标类型】npc');
    expect(firstUser).not.toContain('保持现类型');
    expect(firstUser).toContain('【必须绑定的 NPC】npc1');
    expect(reviewMock).toHaveBeenCalledTimes(1);
    expect(out.draft.npcId).toBe('npc1');
  });
  it('LLM 返回的 targetType 漂移时强制为用户意图 effectiveType', async () => {
    // 排在文件末尾：clearAllMocks 不清 once 队列，先 reset 防前序残留，再重设评审默认通过
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // 内容本身是合法 npc 稿（npc1 在白名单、chapterGoal/openingLine 齐全、puzzle=null），
    // 但 targetType 被 LLM 漂移写成 scene
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'scene',
      npcId: 'npc1',
      chapterGoal: { type: 'reveal', description: 'd', answerCriteria: [], minTurns: 2 },
      openingLine: '嗨',
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    // 漂移被强制纠正为用户意图 npc；首轮确定性校验即通过，不发生重试/重生
    expect(out.draft.targetType).toBe('npc');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });
});

// 生产 2026-10-05 实测的两大失败模式回归（pms_bui_wenlv_npc_jobs error 列取证）：
//  ① 7/8 条失败：chapterGoal 缺 description（LLM 写成 desc/goal 等同义词）两轮校验全灭；
//  ② keep 模式：0074 落平的历史 npc 行（scene + 残留 chapterGoal/openingLine/npcId），
//     现状被喂进 prompt 后 LLM 逐字抄回，触发「普通剧情不应携带…」死循环。
describe('refineNode 生产故障回归', () => {
  it('chapterGoal.description 写成 desc/goal 同义词时归一映射，首轮即通过', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // LLM 把 description 写成 desc（生产实测 LLM 高频失误）
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc',
      npcId: 'npc1',
      openingLine: '客官里边请。',
      chapterGoal: { type: 'reveal', desc: '问出暗号', answerCriteria: ['明月'], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    expect(out.draft.chapterGoal?.description).toBe('问出暗号');
    // 归一命中后首轮即合格，不消耗重试轮次
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('已有合法 description 的稿子不被归一逻辑改写', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc',
      npcId: 'npc1',
      openingLine: '客官里边请。',
      chapterGoal: { type: 'reveal', description: '问出暗号', desc: '另一套描述', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    expect(out.draft.chapterGoal?.description).toBe('问出暗号');
  });

  it('keep 模式：0074 落平的历史 npc 行（scene+残留三件套）现状不喂 npc 专属字段，防抄回死循环', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // 锚点换成「落平后的历史 npc 行」：nodeType=scene 但残留 chapterGoal/openingLine/npcId
    anchorMock.mockResolvedValue({
      ...anchor,
      node: {
        id: 'n1', nodeType: 'scene', title: '村口',
        npcId: 'npc1', openingLine: '旧开场白',
        chapterGoal: { type: 'puzzle', description: '旧目标', answerCriteria: [], minTurns: 1 },
      },
    });
    chatMock.mockResolvedValueOnce(sceneDraft);
    await refineNode('p1', 'n1', 'keep');
    const user = chatMock.mock.calls[0][0].user;
    const current = user.split('【本节点现状】')[1]?.split('【本次目标类型】')[0] ?? '';
    // 现状里必须没有 npc 三件套（否则 LLM 抄回 → 校验死循环，生产实测全灭）
    expect(current).not.toContain('chapterGoal');
    expect(current).not.toContain('openingLine');
    expect(current).not.toContain('npcId');
    // 其余内容字段照常喂（id/title 还在）
    expect(current).toContain('村口');
  });

  it('npc 目标时现状保留 puzzle（供 answerCriteria 取材），场景目标才过滤', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    anchorMock.mockResolvedValue({
      ...anchor,
      node: { ...anchor.node, puzzle: { type: 'input', question: '口令？', answer: '明月' } },
    });
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc', npcId: 'npc1', openingLine: '嗨',
      chapterGoal: { type: 'reveal', description: '问出口令', answerCriteria: ['明月'], minTurns: 1 },
    });
    await refineNode('p1', 'n1', 'npc', 'npc1');
    const user = chatMock.mock.calls[0][0].user;
    expect(user).toContain('口令？');
  });

  it('prompt 硬约束钉死 chapterGoal 必填子字段清单（防 description 再被省略）', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    chatMock.mockResolvedValueOnce(sceneDraft);
    await refineNode('p1', 'n1', 'keep');
    const system = chatMock.mock.calls[0][0].system;
    expect(system).toContain('description');
    expect(system).toContain('minTurns');
    expect(system).toContain('answerCriteria');
  });

  it('chapterGoal.type 漂移出枚举时同义词映射/兜底 reveal，不整稿作废', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // LLM 把 type 写成 'interview'（生产 2026-10-05 实测漂移）
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc', npcId: 'npc1', openingLine: '嗨',
      chapterGoal: { type: 'interview', description: '问出暗号', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    expect(out.draft.chapterGoal?.type).toBe('convince');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('chapterGoal.type 完全不识别时兜底 reveal', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc', npcId: 'npc1', openingLine: '嗨',
      chapterGoal: { type: 'chatting', description: '聊聊', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    expect(out.draft.chapterGoal?.type).toBe('reveal');
  });

  it('chapterGoal 连 type 键都没有（goalType 别名）时归一为合法枚举', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc', npcId: 'npc1', openingLine: '嗨',
      chapterGoal: { goalType: 'interview', description: '聊聊', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    expect(out.draft.chapterGoal?.type).toBe('convince');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('chapterGoal 完全缺 type 键时兜底 reveal', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc', npcId: 'npc1', openingLine: '嗨',
      chapterGoal: { description: '聊聊', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc1');
    expect(out.draft.chapterGoal?.type).toBe('reveal');
  });

  // 生产 2026-10-05 实测：AI 偶发编造白名单外 NPC id（~8%），两轮带错重试不收敛。
  // 兜底策略：节点已有合法绑定时回退到当前绑定（而不是整稿作废）。
  it('npcId 编造白名单外 id 时回退到节点当前绑定（不整稿作废）', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // 节点当前绑定了 npc1（白名单内）
    anchorMock.mockResolvedValue({
      ...anchor,
      node: { ...anchor.node, npcId: 'npc1' },
    });
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc', npcId: 'NPC_FAKE_999', openingLine: '嗨',
      chapterGoal: { type: 'reveal', description: '问出暗号', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc');
    // npcId 被兜底回退到 npc1，首轮即通过，不消耗重试
    expect(out.draft.npcId).toBe('npc1');
    expect(chatMock).toHaveBeenCalledTimes(1);
  });

  it('linkNpcId 显式指定时，兜底优先回退到 linkNpcId 而非节点当前绑定', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // 节点当前绑定了 npc1，但用户显式指定 linkNpcId='npc2'
    anchorMock.mockResolvedValue({
      ...anchor,
      whitelist: { ...anchor.whitelist, npcs: [{ id: 'npc1', name: '韦婆婆' }, { id: 'npc2', name: '阿岩' }] },
      node: { ...anchor.node, npcId: 'npc1' },
    });
    chatMock.mockResolvedValueOnce({
      ...sceneDraft,
      targetType: 'npc', npcId: 'NPC_FAKE_999', openingLine: '嗨',
      chapterGoal: { type: 'reveal', description: '问出暗号', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc', 'npc2');
    expect(out.draft.npcId).toBe('npc2');
  });

  it('节点无当前绑定时不做兜底，交给校验器带错重试', async () => {
    chatMock.mockReset();
    reviewMock.mockReset();
    reviewMock.mockResolvedValue({ ok: true, comment: '' });
    // 节点从未绑定过 NPC
    anchorMock.mockResolvedValue({ ...anchor, node: { ...anchor.node, npcId: null } });
    // 第一轮：编造 npcId
    chatMock.mockResolvedValueOnce({
      ...sceneDraft, targetType: 'npc', npcId: 'NPC_FAKE_999', openingLine: '嗨',
      chapterGoal: { type: 'reveal', description: '问出暗号', answerCriteria: [], minTurns: 1 },
    });
    // 第二轮：给出合法 newNpc（persona 对象不可缺，schema 要求）
    chatMock.mockResolvedValueOnce({
      ...sceneDraft, targetType: 'npc', npcId: null,
      newNpc: { name: '新NPC', persona: { personality: ['冷酷'], appearance: ['黑衣'], motives: [], dialogueStyle: { tone: '冷', vocabulary: [], typicalPhrases: [] } } },
      openingLine: '嗨',
      chapterGoal: { type: 'reveal', description: '问出暗号', answerCriteria: [], minTurns: 1 },
    });
    const out = await refineNode('p1', 'n1', 'npc');
    expect(out.draft.newNpc?.name).toBe('新NPC');
    expect(chatMock).toHaveBeenCalledTimes(2);
  });
});
