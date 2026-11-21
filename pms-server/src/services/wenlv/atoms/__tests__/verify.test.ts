// verifyAtom 七路核验分派单测（Task 4）：纯假库 + stub fetch，本机无 PG/无 LLM 可绿。
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

const { state } = vi.hoisted(() => ({
  state: {
    productRows: [] as any[],
    partnerRows: [] as any[],
    // M2：置 true 后任意 select.where 抛 DB 异常（cipher 分支须 fail-closed）。
    selectThrows: false,
  },
}));

vi.mock('../../../../db/index.js', () => {
  const tableName = (t: any) => t?._?.name ?? t?.[Symbol.for('drizzle:Name')] ?? '';
  const rowsFor = (table: unknown) => {
    const name = tableName(table);
    if (name === 'pms_bui_wenlv_products') return state.productRows;
    if (name === 'pms_bui_wenlv_merchant_partners') return state.partnerRows;
    return [];
  };
  const makeWhere = (table: unknown) => {
    if (state.selectThrows) throw new Error('db down');
    const w: any = {
      limit: async () => rowsFor(table),
      orderBy: () => w,
    };
    w.then = (onFulfilled: any, onRejected?: any) => Promise.resolve(rowsFor(table)).then(onFulfilled, onRejected);
    return w;
  };
  return { db: { select: () => ({ from: (table: unknown) => ({ where: () => makeWhere(table) }) }) } };
});

import { verifyAtom } from '../verify.js';
import type { WenlvAtom, WenlvState } from '../../../../db/schema/wenlv.js';

const atom = (type: WenlvAtom['type'], config: Record<string, unknown>, extra: Partial<WenlvAtom> = {}): WenlvAtom =>
  ({ id: 'x', type, config, ...extra });

const emptyState = (): WenlvState => ({ visited: {}, collected: {}, completed: {} });
const ctx = (over: Partial<{ state: WenlvState; boundPointCode: string | null }> = {}) => ({
  productId: 'p1',
  state: emptyState(),
  boundPointCode: null,
  ...over,
});

beforeEach(() => {
  state.productRows = [];
  state.partnerRows = [];
  state.selectThrows = false;
});
afterEach(() => vi.unstubAllGlobals());

describe('verify=code', () => {
  it('code 与 expectedCode（trim 归一）匹配 ⇒ pass + collect', async () => {
    const v = await verifyAtom(atom('physical-search', { prompt: 'p', expectedCode: ' ABC ' }), { code: 'ABC' }, ctx());
    expect(v.pass).toBe(true);
    expect(v.trackType).toBe('collect');
  });
  it('code 不匹配 ⇒ fail 有中文 message，不抛错', async () => {
    const v = await verifyAtom(atom('physical-search', { prompt: 'p', expectedCode: 'ABC' }), { code: 'ZZZ' }, ctx());
    expect(v.pass).toBe(false);
    expect(v.message).toBeTruthy();
  });
  it('expectedCode 缺省时回退绑定点位码', async () => {
    const v = await verifyAtom(
      atom('physical-search', { prompt: 'p' }),
      { code: 'PT-9' },
      ctx({ boundPointCode: 'PT-9' }),
    );
    expect(v.pass).toBe(true);
  });
  it('expectedCode 与点位码都缺失 ⇒ fail-closed 配置异常文案，不抛错', async () => {
    const v = await verifyAtom(atom('physical-search', { prompt: 'p' }), { code: 'X' }, ctx());
    expect(v.pass).toBe(false);
    expect(v.message).toContain('配置异常');
  });
  it('配置正常但提交空 code ⇒ fail 普通可重试文案（非配置异常）', async () => {
    const v = await verifyAtom(atom('physical-search', { prompt: 'p', expectedCode: 'ABC' }), { code: '' }, ctx());
    expect(v.pass).toBe(false);
    expect(v.message).not.toContain('配置异常');
  });
});

describe('verify=cipher', () => {
  it('config.merchantPartnerId 指定商户，reply_code 匹配 ⇒ pass + cipher_redeemed', async () => {
    state.partnerRows = [{ id: 'mp1', replyCode: '芝麻开门' }];
    const v = await verifyAtom(
      atom('cipher-contact', { cipherPhrase: '天王盖地虎', merchantPartnerId: 'mp1' }),
      { code: '芝麻开门' },
      ctx(),
    );
    expect(v.pass).toBe(true);
    expect(v.trackType).toBe('cipher_redeemed');
  });
  it('reply_code 不匹配 ⇒ fail 中文暗号文案', async () => {
    state.partnerRows = [{ id: 'mp1', replyCode: '芝麻开门' }];
    const v = await verifyAtom(
      atom('cipher-contact', { cipherPhrase: 'p', merchantPartnerId: 'mp1' }),
      { code: '错的' },
      ctx(),
    );
    expect(v.pass).toBe(false);
    expect(v.message).toContain('暗号');
  });
  it('指定商户不存在 ⇒ fail 不抛', async () => {
    const v = await verifyAtom(
      atom('cipher-contact', { cipherPhrase: 'p', merchantPartnerId: 'mp-x' }),
      { code: 'x' },
      ctx(),
    );
    expect(v.pass).toBe(false);
  });
  it('缺省取产品场地首商户（active）匹配 ⇒ pass', async () => {
    state.productRows = [{ id: 'p1', venueId: 'v1' }];
    state.partnerRows = [{ id: 'mp2', venueId: 'v1', status: 'active', replyCode: '0000' }];
    const v = await verifyAtom(atom('cipher-contact', { cipherPhrase: 'p' }), { code: '0000' }, ctx());
    expect(v.pass).toBe(true);
  });
  it('产品未绑场地 ⇒ fail 不抛', async () => {
    state.productRows = [{ id: 'p1', venueId: null }];
    const v = await verifyAtom(atom('cipher-contact', { cipherPhrase: 'p' }), { code: 'x' }, ctx());
    expect(v.pass).toBe(false);
  });
  it('商户 reply_code 未配置 ⇒ fail 说明性 message', async () => {
    state.partnerRows = [{ id: 'mp1', replyCode: null }];
    const v = await verifyAtom(
      atom('cipher-contact', { cipherPhrase: 'p', merchantPartnerId: 'mp1' }),
      { code: 'x' },
      ctx(),
    );
    expect(v.pass).toBe(false);
    expect(v.message).toContain('暗号');
  });
  it('M2 商户查询 DB 异常 ⇒ fail-closed「网络波动」，不抛 500', async () => {
    state.selectThrows = true;
    const v = await verifyAtom(
      atom('cipher-contact', { cipherPhrase: 'p', merchantPartnerId: 'mp1' }),
      { code: 'x' },
      ctx(),
    );
    expect(v.pass).toBe(false);
    expect(v.message).toContain('网络波动');
  });
});

describe('verify=answer', () => {
  it('single：复用 /answer 同款 trim 归一，对/错两路径', async () => {
    const a = atom('single', { question: 'q', options: ['a', 'b'], answer: 'B' });
    expect((await verifyAtom(a, { answer: ' B ' }, ctx())).pass).toBe(true);
    expect((await verifyAtom(a, { answer: 'C' }, ctx())).pass).toBe(false);
  });
  it('multiple：集合等值顺序无关', async () => {
    const a = atom('multiple', { question: 'q', options: ['a', 'b'], answer: ['a', 'b'] });
    expect((await verifyAtom(a, { answer: ['b', 'a'] }, ctx())).pass).toBe(true);
    expect((await verifyAtom(a, { answer: ['a'] }, ctx())).pass).toBe(false);
  });
  it('fragment-assembly：答案串 trim 比对', async () => {
    const a = atom('fragment-assembly', { pieces: [{ id: '1', text: '一' }, { id: '2', text: '二' }], answer: '一二' });
    expect((await verifyAtom(a, { text: ' 一二 ' }, ctx())).pass).toBe(true);
    expect((await verifyAtom(a, { text: '二一' }, ctx())).pass).toBe(false);
  });
  it('item-combine：选中 id 集合相等顺序无关 ⇒ pass 且回补 revealText', async () => {
    const a = atom('item-combine', { itemIds: ['i1', 'i2'], revealText: '机关开了' });
    const ok = await verifyAtom(a, { answer: ['i2', 'i1'] }, ctx());
    expect(ok.pass).toBe(true);
    expect(ok.revealText).toBe('机关开了');
    expect((await verifyAtom(a, { answer: ['i1'] }, ctx())).pass).toBe(false);
  });

  it('M4 残缺配置 fail-closed：single/input/judge 答案缺省/空白 ⇒ 配置异常，空提交也不通过', async () => {
    for (const type of ['single', 'input', 'judge'] as const) {
      for (const bad of [undefined, '', '   ']) {
        const v = await verifyAtom(atom(type, { question: 'q', answer: bad }), { answer: bad ?? '' }, ctx());
        expect(v.pass).toBe(false);
        expect(v.message).toContain('配置异常');
      }
    }
  });

  it('M4 multiple：空数组/非数组/缺位（空白项）⇒ 配置异常', async () => {
    const submitOk = { answer: ['a', 'b'] };
    expect((await verifyAtom(atom('multiple', { question: 'q', options: ['a', 'b'], answer: [] }), submitOk, ctx())).message).toContain('配置异常');
    expect((await verifyAtom(atom('multiple', { question: 'q', options: ['a', 'b'] }), submitOk, ctx())).message).toContain('配置异常');
    expect((await verifyAtom(atom('multiple', { question: 'q', options: ['a', 'b'], answer: ['a', '  '] }), submitOk, ctx())).message).toContain('配置异常');
  });

  it('M4 fragment-assembly 答案空 / item-combine itemIds 空 ⇒ 配置异常', async () => {
    const frag = await verifyAtom(
      atom('fragment-assembly', { pieces: [], answer: '' }),
      { text: '一二' },
      ctx(),
    );
    expect(frag.pass).toBe(false);
    expect(frag.message).toContain('配置异常');
    const combine = await verifyAtom(atom('item-combine', { itemIds: [] }), { answer: ['i1'] }, ctx());
    expect(combine.pass).toBe(false);
    expect(combine.message).toContain('配置异常');
  });

  it('M4 配置正常时空提交 ⇒ 普通判错（不走配置异常）', async () => {
    const v = await verifyAtom(
      atom('single', { question: 'q', options: ['a', 'b'], answer: 'B' }),
      { answer: '' },
      ctx(),
    );
    expect(v.pass).toBe(false);
    expect(v.message).not.toContain('配置异常');
  });
});

describe('verify=llm-text', () => {
  it('LLM 判定 pass=true ⇒ 通过', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"pass":true,"reason":"观察到位"}' } }] }),
    }));
    const v = await verifyAtom(atom('observe', { prompt: 'p', criteria: '发现划痕' }), { text: '门框有新划痕' }, ctx());
    expect(v.pass).toBe(true);
  });
  it('LLM 网络异常 ⇒ fail + 网络波动文案，不抛错', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('net')));
    const v = await verifyAtom(atom('observe', { prompt: 'p', criteria: 'c' }), { text: 't' }, ctx());
    expect(v.pass).toBe(false);
    expect(v.message).toContain('网络');
  });
  it('LLM 判定 false ⇒ fail', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"pass":false,"reason":"没提到关键物"}' } }] }),
    }));
    const v = await verifyAtom(atom('observe', { prompt: 'p', criteria: 'c' }), { text: '无关内容' }, ctx());
    expect(v.pass).toBe(false);
  });

  it('M3 fetch 调用带 20s 超时 signal（AbortSignal.timeout）', async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '{"pass":true,"reason":"ok"}' } }] }),
    });
    vi.stubGlobal('fetch', fetchMock);
    await verifyAtom(atom('observe', { prompt: 'p', criteria: 'c' }), { text: 't' }, ctx());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const opts = fetchMock.mock.calls[0][1] as RequestInit;
    // 仅断言 options 挂了 signal（20s 由 AbortSignal.timeout(20000) 给出，不真等超时）。
    expect(opts.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('verify=collectibles / attest / auto', () => {
  it('cross-place：collected 覆盖全部 collectibleIds ⇒ pass', async () => {
    const a = atom('cross-place', { collectibleIds: ['c1', 'c2'] });
    const s = emptyState();
    s.collected = { c1: true, c2: true };
    expect((await verifyAtom(a, {}, ctx({ state: s }))).pass).toBe(true);
  });
  it('未集齐 ⇒ fail，message 提示还差份数', async () => {
    const a = atom('cross-place', { collectibleIds: ['c1', 'c2', 'c3'] });
    const s = emptyState();
    s.collected = { c1: true };
    const v = await verifyAtom(a, {}, ctx({ state: s }));
    expect(v.pass).toBe(false);
    expect(v.message).toContain('2');
  });
  it('M4 collectibleIds 非数组/空数组 ⇒ fail-closed 配置异常（空目标不判集齐）', async () => {
    const s = emptyState();
    const v1 = await verifyAtom(atom('cross-place', {}), {}, ctx({ state: s }));
    expect(v1.pass).toBe(false);
    expect(v1.message).toContain('配置异常');
    const v2 = await verifyAtom(atom('cross-place', { collectibleIds: [] }), {}, ctx({ state: s }));
    expect(v2.pass).toBe(false);
    expect(v2.message).toContain('配置异常');
  });
  it('attest（human-quest）⇒ 恒 pass + task_grant', async () => {
    const v = await verifyAtom(atom('human-quest', { questBrief: '帮跑腿' }), {}, ctx());
    expect(v.pass).toBe(true);
    expect(v.trackType).toBe('task_grant');
  });
  it('auto（ar-echo）⇒ 恒 pass 且无埋点', async () => {
    const v = await verifyAtom(atom('ar-echo', { assetUrl: 'u' }), {}, ctx());
    expect(v.pass).toBe(true);
    expect(v.trackType ?? null).toBeNull();
  });
});
