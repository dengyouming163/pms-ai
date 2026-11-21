import { describe, it, expect } from 'vitest';
import { buildImagePrompt, buildAnchorPrompt, buildScenePrompt, buildTtsText } from '../prompt-builder.js';
import type { WenlvStyleBible } from '../../../../db/schema/wenlv.js';

/**
 * 断言抛错。等价于 `expect(fn).toThrow()`。
 * ⚠️ 2026-09-19 更正：本行原称「类型桩未声明该 matcher」——已不成立，
 *    `toThrow` 自 d5a65359 起已在桩内。是否可用以 `src/types/vitest.d.ts` 为准。
 *    本 helper 保留是历史写法。
 */
function expectThrow(fn: () => unknown): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  expect(threw).toBe(true);
}

const bible: WenlvStyleBible = {
  artStyle: '水墨写意',
  palette: ['#2f4f4f', '#c8b89a'],
  era: '民国',
  brushwork: '宣纸洇染',
  mood: '苍凉',
  mustHave: ['古井'],
  forbidden: ['现代物件', '真人人脸'],
  notes: '不要出现文字',
};

describe('buildImagePrompt（纯函数）', () => {
  const scene = '黄昏的古镇街口，石板路反光，远处一座牌坊。';

  it('把基线整份注入 —— 每个禁用项都逐字出现', () => {
    // 这是防漂移的核心断言：只把基线当「参考」会让模型自由发挥，
    // 必须断言**逐字**出现，任何「摘要式」改写都会让这条测试变红。
    const p = buildImagePrompt({ bible, scene });
    expect(p).toContain('水墨写意');
    expect(p).toContain('民国');
    expect(p).toContain('宣纸洇染');
    expect(p).toContain('苍凉');
    expect(p).toContain('现代物件');
    expect(p).toContain('真人人脸');
    expect(p).toContain('#2f4f4f');
    expect(p).toContain('古井');
  });

  it('场景描述原样带上（不经任何改写）', () => {
    expect(buildImagePrompt({ bible, scene })).toContain(scene);
  });

  it('**确定性**：同样输入产出逐字节相同的提示词', () => {
    // 漂移的根因之一就是同一输入两次措辞不同。这一条把它钉死。
    expect(buildImagePrompt({ bible, scene })).toBe(buildImagePrompt({ bible, scene }));
  });

  it('**画面变、画风不变**：换场景描述时基线段逐字节相同', () => {
    const a = buildImagePrompt({ bible, scene });
    const b = buildImagePrompt({ bible, scene: '正午的码头，货船靠岸，麻绳堆在木桩旁。' });
    expect(a).not.toBe(b);
    // 用**固定分隔标记**切基线块，不能用「到下一个空行」—— notes 是 LLM 生成的，
    // 内部换行原样保留，含 \n\n 时那条切法只会比到一个前缀：测试照样绿，
    // 而它自称守住的「画风块整体稳定」已经没在守了（断言静默降级，不是假红）。
    const block = (s: string) => s.slice(0, s.indexOf('\n\n【画面】'));
    expect(block(a)).toBe(block(b));
    expect(block(a)).toContain('现代物件');
    // 顺便把线格式钉住 —— 上面那条切法依赖它
    expect(a).toContain('\n\n【画面】\n');
  });

  it('空场景描述抛错（不生成一张无内容的图，白花钱）', () => {
    expectThrow(() => buildImagePrompt({ bible, scene: '   ' }));
    // undefined / null 也要落在那句可定位的错误上，而不是一句
    // 「Cannot read properties of undefined」——后者在日志里无从定位
    expectThrow(() => buildImagePrompt({ bible, scene: null as unknown as string }));
  });

  it('**空基线拒绝出图** —— 本函数是基线的唯一注入点，必须在这儿挡', () => {
    // 少了这道守卫会产出「画风：（未指定）」的提示词继续出图：静默放弃防漂移，
    // 出的每一张都是漂移样本（spec §8）。与 style-bible.ts 的 artStyle 守卫同一条红线。
    expectThrow(() => buildImagePrompt({ bible: {}, scene: 'x' }));
    expectThrow(() => buildImagePrompt({ bible: { artStyle: '' }, scene: 'x' }));
  });

  it('**确定性不依赖对象键序**：等值但键序不同的基线产出相同提示词', () => {
    // 上一条传的是同一个 bible 引用。LLM 返回的 JSON 键序每次都可能不同，
    // 而 parseStyleBible 是固定顺序构造对象的 —— 这条把「靠字面量数组取值」钉死，
    // 防止后人改成 Object.keys / for...in 之类依赖键序的写法。
    const reordered: WenlvStyleBible = {
      notes: '不要出现文字',
      forbidden: ['现代物件', '真人人脸'],
      mustHave: ['古井'],
      mood: '苍凉',
      brushwork: '宣纸洇染',
      era: '民国',
      palette: ['#2f4f4f', '#c8b89a'],
      artStyle: '水墨写意',
    };
    expect(buildImagePrompt({ bible, scene })).toBe(buildImagePrompt({ bible: reordered, scene }));
  });
});

describe('buildTtsText（纯函数）', () => {
  it('旁白文本直接取自故事文本，不改写', () => {
    expect(buildTtsText({ storyText: '  你走进古镇。  ' })).toBe('你走进古镇。');
  });
  it('空文本抛错（不合成空音频）', () => {
    expectThrow(() => buildTtsText({ storyText: '   ' }));
    expectThrow(() => buildTtsText({ storyText: null }));
  });
});

describe('buildScenePrompt（纯函数）', () => {
  it('带上节点内容与世界设定，供 LLM 翻译成画面', () => {
    const p = buildScenePrompt({
      productName: '龙门镇谜案', worldSetting: { era: '民国' },
      nodeTitle: '古井', storyText: '井底沉着半枚铜钱', assetType: 'background',
    });
    expect(p).toContain('古井');
    expect(p).toContain('井底沉着半枚铜钱');
    expect(p).toContain('民国');
  });

  it('明确要求 LLM 不要描述画风（画风由模板层注入，不能经 LLM 转述）', () => {
    // 这是本设计的关键分工：LLM 只做「内容 → 画面」的翻译。
    // 若让 LLM 顺带描述画风，它每次用词都不同，漂移就回来了。
    const p = buildScenePrompt({
      productName: 'x', nodeTitle: '入镇', storyText: 'y', assetType: 'background',
    });
    expect(p).toContain('不要描述画风');
  });

  it('collectible 渲染成中文标签，绝不回落成英文类型名', () => {
    const p = buildScenePrompt({
      productName: '龙门镇武侠夜游', worldSetting: null,
      nodeTitle: '半枚残破铜钱', storyText: '沈砚随身携带。',
      assetType: 'collectible',
    });
    // 正向：素材行存在且是中文说明
    expect(p).toContain('（图鉴物件插画');
    // 负向：英文类型名不得出现在提示词里（这正是漏加 TYPE_LABEL 的症状）
    expect(p).not.toContain('（collectible）');
  });
});

/**
 * 空 / 缺 `storyText` 时「故事内容：」整行不得消失。
 *
 * ⚠️ **判据为什么必须钉「那一行」，不能钉「提示词含条目名」**：
 *    上面 `素材：${nodeTitle}（…）` 那一行**本身就含条目名**，而 scheduler 传来的
 *    `nodeTitle` 就是条目名（`wenlv-asset-gen-scheduler.ts` 的 `if (c?.name) nodeTitle = c.name`）
 *    ⇒ `expect(p).toContain(条目名)` 在**未修的代码上照样是绿的** —— 那是**空判据**，
 *    零回归防护力。只有钉 `\n故事内容：` 才可被证伪（未修时整行被 `.filter(Boolean)` 吃掉）。
 *    2026-09-20 实测：本组用例在未修的 prompt-builder.ts 上全部红，修后全绿。
 *
 * 影响面只有 collectible / reward / tier 三类（它们的 `sourceText` 来自实体 `description`）；
 * node 级 background 走节点自己的 `storyText`，本组用例不声称覆盖它。
 */
describe('buildScenePrompt：storyText 空/缺时「故事内容：」整行不得消失', () => {
  const base = {
    productName: '龙门镇谜案',
    worldSetting: null,
    nodeTitle: '半枚残破铜钱',
    assetType: 'collectible',
  };

  it('空串 storyText 仍必须渲染出「故事内容：」行（正向判据，修前必红）', () => {
    const p = buildScenePrompt({ ...base, storyText: '' });
    expect(p).toContain('\n故事内容：');
    // 且**只出现一次** —— 既防丢行，也防「用 while 拼出两行」式的过度修复
    expect((p.match(/故事内容：/g) ?? []).length).toBe(1);
  });

  it('null / 缺省 storyText 同样不得丢行（? : 判 falsy，两种取值同效）', () => {
    expect(buildScenePrompt({ ...base, storyText: null })).toContain('\n故事内容：');
    expect(buildScenePrompt({ ...base, storyText: undefined })).toContain('\n故事内容：');
  });

  it('空 storyText 时该行回落到条目名（给 LLM 内容线索，而不是空值）', () => {
    const p = buildScenePrompt({ ...base, storyText: '' });
    const line = p.split('\n').find((l) => l.startsWith('故事内容：'));
    expect(line).toBe('故事内容：半枚残破铜钱');
  });

  it('对照：非空 storyText 时该行内容 = storyText 本身，**不是**条目名', () => {
    // 少了这条对照，「把该行恒写成 nodeTitle」的坏实现也会全绿。
    const p = buildScenePrompt({ ...base, storyText: '边缘残破，字迹模糊。' });
    const line = p.split('\n').find((l) => l.startsWith('故事内容：'));
    expect(line).toBe('故事内容：边缘残破，字迹模糊。');
    expect(line).not.toContain('半枚残破铜钱');
  });

  it('`素材：` 那一行逐字节不变（回落不得挤掉或改写它）', () => {
    const p = buildScenePrompt({ ...base, storyText: '' });
    expect(p).toContain('素材：半枚残破铜钱（图鉴物件插画');
  });
});

describe('buildAnchorPrompt（纯函数）', () => {
  it('整份注入基线 —— 锚图是基线的视觉化身，必须带全', () => {
    // 锚图的全部意义就是「把基线画出来」。它要是丢了 forbidden，
    // 它自己就违规，然后所有参考它的图跟着违规 —— 误差源头。
    const p = buildAnchorPrompt(bible);
    expect(p).toContain('水墨写意');
    expect(p).toContain('民国');
    expect(p).toContain('现代物件');
    expect(p).toContain('#2f4f4f');
  });

  it('标明是定调图，且把 mustHave 当氛围元素而非主角', () => {
    const p = buildAnchorPrompt(bible);
    expect(p).toContain('定调');
    expect(p).toContain('anchor');
    expect(p).toContain('画风样张');
    // 原来这里写的是 `expect(p).not.toContain('入镇')` —— 那是条**恒真断言**：
    // buildAnchorPrompt 只收 bible，而 bible 里根本没有「入镇」，任何实现都过得去，
    // 零回归防护力却看起来像在守着「锚图不含点位内容」。
    // 换成可证伪的两条：mustHave 必须带上（它是「这个剧本长什么样」的一部分），
    // 且提示词必须明确要求它不作主角。
    expect(p).toContain('古井');
    expect(p).toContain('不要以某一个具体点位为主角');
    // 「锚图不接受点位」由**签名**保证（只收 bible），这是比断言更强的保障。
    // 若日后有人把签名改成 buildAnchorPrompt(bible, node)，这条注释是唯一提示点。
  });
});
