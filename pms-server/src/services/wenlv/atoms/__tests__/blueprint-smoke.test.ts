// 《客栈旧信》五章样板蓝图冒烟（spec §3，Task 18）。
// 纯内存 fixture，不连 DB：钉死「主线 100% 免费可达」红线的读/写/投影三条接缝。
import { describe, it, expect } from 'vitest';
import type { WenlvAtom, WenlvInteraction } from '../../../../db/schema/wenlv.js';
import { checkFreeBypass } from '../../node-graph/integrity.js';
import { normalizeNodeAtoms, puzzleToAtom } from '../project.js';
import { requiredAtomIds } from '../registry.js';

// —— ⑤ 章（终章·客栈天井）原子表：3 商业原子（均带免费旁路）+ 2 免费必做原子 ——
// 语义说明：商业原子 required=false —— requiredAtomIds 只收必做原子，
// 免费玩家不消费也能完成节点；商业消费是加分/定制体验，不卡主线。
const ch5Atoms: WenlvAtom[] = [
  {
    id: 'cipher_neighbor',
    type: 'cipher-contact',
    title: '与茶馆掌柜对暗号',
    required: false,
    config: {
      cipherPhrase: '月黑风高',
      replyHint: '掌柜回「隔壁柴房」',
      // 免费旁路：不对暗号（不消费）也能从邻桌茶客闲谈听到同一线索
      bypass: { how: '邻桌旁听' },
    },
  },
  {
    id: 'redeem_token',
    type: 'token-redeem',
    title: '信物兑换隐藏支线道具',
    required: false,
    config: {
      rewardId: 'rw_old_key',
      sourceCollectibleIds: ['col_half_token'],
      bypass: { how: '不兑换也可通关，道具仅解锁番外对白' },
    },
  },
  {
    id: 'paid_ending',
    type: 'paid-customization',
    title: '定制专属结局信物',
    required: false,
    config: {
      fields: [{ key: 'name', label: '刻字落款', placeholder: '留名于旧信' }],
      bypass: { how: '不定制即走标准结局，主线结局照常播放' },
    },
  },
  // 免费必做原子（required 缺省 = true）
  { id: 'observe_courtyard', type: 'observe', config: { prompt: '观察天井石阶', criteria: '找到松动石板下的信笺' } },
  { id: 'search_letterbox', type: 'physical-search', config: { prompt: '在老邮筒里寻找最后一封信', expectedCode: 'XIN-05' } },
];

// —— ③ 章（碎片语义题）：老剧本 input puzzle，模拟 fragment 语义问答 ——
const ch3Puzzle: WenlvInteraction = {
  type: 'input',
  question: '把三页残信上的圈字连成一句话，填入落款：__旧__来',
  answer: '人',
  hint: '残信提到「故人归来」',
};

// 五章节点（checkFreeBypass 只读 id/title/atoms）
function buildNodes(ch5: WenlvAtom[] = ch5Atoms) {
  return [
    { id: 'ch1', title: '第一章·入镇', atoms: [] },
    { id: 'ch2', title: '第二章·客栈', atoms: [] },
    { id: 'ch3', title: '第三章·残信', atoms: [] },
    { id: 'ch4', title: '第四章·夜访', atoms: [] },
    { id: 'ch5', title: '第五章·天明', atoms: ch5 },
  ];
}

describe('客栈旧信五章蓝图冒烟（纯内存，不连 DB）', () => {
  it('断言1 R10：全部商业原子声明免费旁路时 checkFreeBypass 返回空错误数组', () => {
    const errs = checkFreeBypass(buildNodes());
    expect(errs).toEqual([]);
  });

  it('断言2：normalizeNodeAtoms 接受 ch5 原子表，且 requiredAtomIds 不含三个商业原子（免费玩家可完成全部必做步骤）', () => {
    // 写端守门员：类型上架 + config schema + id 唯一，不抛错即通过；原样返回数组
    const normalized = normalizeNodeAtoms(ch5Atoms);
    expect(Array.isArray(normalized)).toBe(true);
    expect(normalized).toHaveLength(ch5Atoms.length);

    const required = requiredAtomIds(ch5Atoms);
    expect(required).not.toContain('cipher_neighbor');
    expect(required).not.toContain('redeem_token');
    expect(required).not.toContain('paid_ending');
    // 免费必做原子仍在必做集合里，主线步骤不空转
    expect(required).toContain('observe_courtyard');
    expect(required).toContain('search_letterbox');
  });

  it('断言3：puzzleToAtom 投影老 ch3 的 input 语义题，老节点渲染路径不回归', () => {
    const atom = puzzleToAtom(ch3Puzzle);
    expect(atom).not.toBeNull();
    expect(atom!.id).toBe('quiz_main');
    expect(atom!.type).toBe('input');
    expect((atom!.config as WenlvInteraction).question).toContain('旧');
  });

  it('反向断言：ch5 任一商业原子缺少 config.bypass.how 时 checkFreeBypass 必须报错', () => {
    const broken = ch5Atoms.map((a) =>
      a.id === 'redeem_token'
        ? { ...a, config: { rewardId: 'rw_old_key', sourceCollectibleIds: ['col_half_token'] } }
        : a,
    );
    const errs = checkFreeBypass(buildNodes(broken));
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).toMatch(/R10/);
  });
});
