import { describe, it, expect } from 'vitest';
import { buildReviewPrompt, parseReview, verdictOf } from '../reviewer.js';

const bible = {
  artStyle: '水墨淡彩', palette: ['靛青', '暖赭'], mustHave: ['渡口石阶'], forbidden: ['霓虹灯'], mood: '静',
};
const base = {
  assetType: 'ending' as const, assetName: '结局一', productName: '雨夜渡口',
  bible, contextText: '主角在渡口与故人作别',
};

/**
 * 判据行 = 形如 `1. 构图完整…` 的编号行（`buildReviewPrompt` 用 `${i + 1}. ${c}` 逐条输出）。
 * 断言一律绑到判据行上：整段 `toContain` 会被末尾的输出 schema 行蒙混过关
 * （那行里就写着「构图」「JSON」，判据整段删掉也照样通过）。
 */
const criteriaLines = (p: string) => p.split('\n').filter((l) => /^\d+\.\s/.test(l));

describe('评价提示词合成', () => {
  it('palette / mustHave / forbidden 各自绑到承载它的那一条判据行', () => {
    const lines = criteriaLines(buildReviewPrompt(base));
    expect(lines.some((l) => l.includes('色板内') && l.includes('靛青'))).toBe(true);
    expect(lines.some((l) => l.includes('地标') && l.includes('渡口石阶'))).toBe(true);
    expect(lines.some((l) => l.includes('不得') && l.includes('霓虹灯'))).toBe(true);
    // 两项必须分属**不同**判据行：把 forbidden 的值并进 palette 那句会在此红
    expect(lines.find((l) => l.includes('靛青'))).not.toBe(lines.find((l) => l.includes('霓虹灯')));
  });

  it('包含类型专属判据（ending 的情绪收束感）', () => {
    expect(criteriaLines(buildReviewPrompt(base)).some((l) => l.includes('情绪收束感'))).toBe(true);
  });

  it('不含类型专属判据的类型只给通用项（background 不带 ending 的判据）', () => {
    const lines = criteriaLines(buildReviewPrompt({ ...base, assetType: 'background' }));
    expect(lines.some((l) => l.includes('情绪收束感'))).toBe(false);
    // 绑到判据行：删掉 UNIVERSAL 整段后，输出 schema 行不再能顶替这条断言
    expect(lines.some((l) => l.includes('构图'))).toBe(true);
  });

  it('era / brushwork / notes 也派生判据（与 bibleBlock 注入的 8 字段逐一对齐）', () => {
    const p = buildReviewPrompt({
      ...base,
      bible: { ...bible, era: '民国', brushwork: '干笔皴擦', notes: '不要出现现代家具' },
    });
    const lines = criteriaLines(p);
    expect(lines.some((l) => l.includes('时代背景') && l.includes('民国'))).toBe(true);
    expect(lines.some((l) => l.includes('笔触质感') && l.includes('干笔皴擦'))).toBe(true);
    expect(lines.some((l) => l.includes('补充要求') && l.includes('不要出现现代家具'))).toBe(true);
  });

  it('要求输出 JSON，且**必须含 fix_guidance**（绑到字段说明行，不靠判据行蹭词）', () => {
    const p = buildReviewPrompt(base);
    const lines = criteriaLines(p);
    // 这两个词是「输出格式要求」，不该出现在判据行里
    expect(lines.some((l) => l.includes('fix_guidance'))).toBe(false);
    expect(lines.some((l) => l.includes('JSON'))).toBe(false);
    // 必须由**指令块**承载，且以 JSON 字段契约（`"key":`）的形式给出 ——
    // 光出现「fix_guidance」这个词不算（判据行里蹭一个词也会通过）。
    const instrLines = p.split('\n').filter((l) => !/^\d+\.\s/.test(l));
    expect(instrLines.some((l) => l.includes('"score":'))).toBe(true);
    expect(instrLines.some((l) => l.includes('"fix_guidance":'))).toBe(true);
    // 「严格 JSON」由指令行明写
    expect(p).toContain('输出**严格 JSON**，字段如下：');
  });
});

describe('评审结果解析', () => {
  it('解析裸 JSON', () => {
    const r = parseReview('{"score":8,"dimensions":[],"issues":[],"fix_guidance":"加点雾"}');
    expect(r.score).toBe(8);
    expect(r.fix_guidance).toBe('加点雾');
  });

  it('解析被 ```json 围栏包裹的输出（模型最常见的包装）', () => {
    const r = parseReview('```json\n{"score":7,"dimensions":[],"issues":[],"fix_guidance":"x"}\n```');
    expect(r.score).toBe(7);
  });

  it('score 超出 0–10 → 抛错，不静默夹紧（夹紧会把「模型乱答」伪装成正常分）', () => {
    expect(() => parseReview('{"score":99,"dimensions":[],"issues":[],"fix_guidance":""}')).toThrow();
  });

  // 这几种值 `Number()` 都会静默吞成 0（`true` 吞成 1），而 0 分恰好落进
  // 「不合格」档 → 触发自动烧钱重生成。必须先验类型再取值。
  it('score 类型不对（null / "" / "   " / [] / true）→ 抛错，不静默读成 0 分', () => {
    for (const bad of ['null', '""', '"   "', '[]', 'true']) {
      const raw = `{"score":${bad},"dimensions":[],"issues":[],"fix_guidance":""}`;
      expect(() => parseReview(raw), `score=${bad} 应抛错`).toThrow(/评审分数非法/);
    }
  });

  it('数字字符串 "8" 刻意接受（模型常把数字写成字符串）', () => {
    expect(parseReview('{"score":"8","dimensions":[],"issues":[],"fix_guidance":""}').score).toBe(8);
  });

  it('缺 fix_guidance → 抛错（缺了它，形态④ 拿不到要喂的 guidance）', () => {
    expect(() => parseReview('{"score":8,"dimensions":[],"issues":[]}')).toThrow();
  });

  it('非 JSON → 抛错并带上原文片段便于排障', () => {
    expect(() => parseReview('抱歉，我无法评价')).toThrow(/无法评价/);
  });

  // 任务书 §3：把「刻意宽松」钉成规格。dimensions 仅供展示，
  // 与 score / fix_guidance（驱动自动烧钱迭代）的严格抛错**刻意不对称**。
  it('dimensions 类型不对 → 静默兜底为 []（仅供展示，缺了不影响自动决策）', () => {
    const r = parseReview('{"score":8,"fix_guidance":"x","dimensions":"很好"}');
    expect(r.dimensions).toEqual([]);
  });

  // ── 以下为 parse-fix-1 追加：旧实现取「第一个 { 到最后一个 }」切片，
  //    模型一次吐两个首尾相接的 JSON 时切片**跨对象** ⇒ JSON.parse 必炸
  //    （生产实测 job wa-7820e25c：Unexpected non-whitespace character after JSON at position 1116）。

  it('两个首尾相接的对象 → 取第一个（切片不跨对象）', () => {
    const r = parseReview(
      '{"score":8,"dimensions":[],"issues":[],"fix_guidance":"加雾"}'
        + '{"score":2,"dimensions":[],"issues":[],"fix_guidance":"x"}',
    );
    expect(r.score).toBe(8);
    expect(r.fix_guidance).toBe('加雾');
  });

  it('对象 + 尾随文字 → 取该对象', () => {
    const r = parseReview('{"score":7,"dimensions":[],"issues":[],"fix_guidance":"y"} 以上。');
    expect(r.score).toBe(7);
  });

  // 字符串字面量里的花括号是**内容**不是结构：按「数花括号但不看字符串」的实现会在此红。
  it('fix_guidance 内含 { 与 } → 逐字保留，不被当成结构', () => {
    const r = parseReview('{"score":6,"dimensions":[],"issues":[],"fix_guidance":"把 {圆窗} 换成 }方窗{"}');
    expect(r.fix_guidance).toBe('把 {圆窗} 换成 }方窗{');
  });

  it('fix_guidance 内含转义引号 \\" → 正常解析', () => {
    const r = parseReview('{"score":6,"dimensions":[],"issues":[],"fix_guidance":"说 \\"你好\\""}');
    expect(r.fix_guidance).toBe('说 "你好"');
  });

  // 上一条的转义是**偶数**个且不紧邻 `}`，把 `\"` 当字符串结束也照样配平（扫描侥幸不出错）。
  // 这一条才有咬合力：`\"` 后面紧跟 `}`，若不认转义就会在 `}` 处**提前**截断 ⇒ 解析失败。
  it('转义引号紧邻 } → 不把 \\" 当字符串结束（否则切片提前截断）', () => {
    const r = parseReview('{"score":6,"dimensions":[],"issues":[],"fix_guidance":"a\\"}b"}');
    expect(r.fix_guidance).toBe('a"}b');
  });

  // 前面先出现一个不成 JSON 的括号（如模型写「Here is the review {as requested}:」）时，
  // 应顺延到后面真正的对象，而不是整条失败。
  it('前面先出现一个不成 JSON 的括号 → 顺延到真正的对象', () => {
    const r = parseReview(
      'Here is the review {as requested}: '
        + '{"score":5,"dimensions":[],"issues":[],"fix_guidance":"z"}',
    );
    expect(r.score).toBe(5);
  });

  // ⚠️ 上面那条的包裹是**并列**在真对象**之前**的，故「跳过失败候选的整个跨度」
  //    （`from = close + 1`）也能侥幸顺延到真对象。**这一组**才钉住「配平但非 JSON 的
  //    包裹**包含**着真对象」——此时跳过整个包裹跨度就会连同里面的真对象一起跳过，
  //    永远看不到它。写成按候选逐个 `from = open + 1` 才救得回。
  it('配平但非 JSON 的包裹**包含**真对象 → 仍能取到内部的真对象', () => {
    const r = parseReview('{ 说明 {"score":5,"dimensions":[],"issues":[],"fix_guidance":"改"} }');
    expect(r.score).toBe(5);
    expect(r.fix_guidance).toBe('改');
  });

  it('配平但非 JSON 的包裹**包含**真对象（前后都有杂物）→ 取内部的真对象', () => {
    const r = parseReview('{ 然后 {"score":6,"dimensions":[],"issues":[],"fix_guidance":"n"} 结束 }');
    expect(r.score).toBe(6);
    expect(r.fix_guidance).toBe('n');
  });

  it('没有任何 { → 仍抛错并带原文片段', () => {
    expect(() => parseReview('全篇没有花括号')).toThrow(/评审输出不是 JSON/);
  });

  // ⚠️ 断言绑到**只可能由 `firstErr` 那条分支产生**的串上。原先写 `/不是 JSON/`
  //    钉不住分支：错误消息里拼了原文（`原文=…`），而本用例的输入自己就含「不是 JSON」
  //    字样 ⇒ 把实现换成「没有任何 `{`」那条分支的文案，正则照样被**原文**满足。
  it('所有配平候选都解析不了 → 仍抛错并带原文片段', () => {
    expect(() => parseReview('{不是 JSON}')).toThrow(/评审输出 JSON 解析失败/);
  });
});

describe('三档判定', () => {
  it('≥8 通过 / 6–8 待改 / <6 不合格', () => {
    expect(verdictOf(8)).toBe('pass');
    expect(verdictOf(7.9)).toBe('revise');
    expect(verdictOf(6)).toBe('revise');
    expect(verdictOf(5.9)).toBe('reject');
  });
});

/**
 * §8.5 正反例参照（片④ T13）。
 *
 * ⚠️ 断言一律绑到 `【正例】` / `【反例】` 这两个**只可能由样本行产生**的标记上：
 *    整段 `toContain('正例')` 会被标题行（「参照样本（由人工评审自动累积…）」不含
 *    「正例」二字，但将来改标题就会）蒙混过关 —— 与文件开头 `criteriaLines` 那条
 *    「断言绑到承载它的那一行」是同一条纪律。
 */
describe('正反例参照（§8.5 few-shot）', () => {
  let seq = 0;
  const ex = (kind: 'pos' | 'neg', over: Partial<{ name: string; score: string | null; comment: string | null }> = {}) => {
    seq += 1;
    return {
      name: over.name ?? `${kind}样本${seq}`,
      score: over.score === undefined ? (kind === 'pos' ? '8.50' : '2.00') : over.score,
      comment: over.comment === undefined ? `意见${seq}` : over.comment,
    };
  };
  /** 各 5 条 —— 比 `FEW_SHOT_LIMIT` 多，才能pin住「取的是前 3 条」而不是「有几条给几条」。 */
  const five = () => ({
    positive: Array.from({ length: 5 }, () => ex('pos')),
    negative: Array.from({ length: 5 }, () => ex('neg')),
  });
  const count = (p: string, marker: string) => (p.match(new RegExp(marker, 'g')) ?? []).length;

  it('正例恰好 3 条、反例恰好 3 条（写 == 3，不写 >= 1 也不写 >= 3）', () => {
    const prompt = buildReviewPrompt({ ...base, examples: five() });
    expect(count(prompt, '【正例】')).toBe(3);
    expect(count(prompt, '【反例】')).toBe(3);
  });

  it('超出上限的样本是**丢弃**，不是只截标题 —— 第 4、5 条的名字不进 prompt', () => {
    const e = five();
    const prompt = buildReviewPrompt({ ...base, examples: e });
    expect(prompt).not.toContain(e.positive[3].name);
    expect(prompt).not.toContain(e.positive[4].name);
    expect(prompt).not.toContain(e.negative[3].name);
    expect(prompt).not.toContain(e.negative[4].name);
  });

  it('正例与负例的上限**各自**生效（不是共用一个 3 的总额度）', () => {
    const prompt = buildReviewPrompt({ ...base, examples: five() });
    // 共用额度的话，正例 5 条会把额度吃光 ⇒ 反例一条都不出现。
    expect(count(prompt, '【反例】')).toBe(3);
  });

  // ★ 回归：`examples` 缺省 / 为 null 时，prompt 必须与**接线之前**逐字相同。
  //   否则「没接参照样本」这条路径的行为被静默改掉了，而它正是今天的生产路径。
  it('examples 缺省 / null → prompt 与不带参照时逐字相同（且不出现参照块标题）', () => {
    const bare = buildReviewPrompt({ ...base });
    expect(buildReviewPrompt({ ...base, examples: null })).toBe(bare);
    expect(buildReviewPrompt({ ...base, examples: { positive: [], negative: [] } })).toBe(bare);
    expect(bare).not.toContain('参照样本');
  });

  it('只有正例 → 不产出空的反例块（不出现一个没有内容的【反例】标题）', () => {
    const prompt = buildReviewPrompt({ ...base, examples: { positive: [ex('pos')], negative: [] } });
    expect(count(prompt, '【正例】')).toBe(1);
    expect(count(prompt, '【反例】')).toBe(0);
  });

  it('人工未打分 → 渲染成「未打分」，不伪造一个 0 分（0 分是「不合格」档，会误导模型）', () => {
    const prompt = buildReviewPrompt({
      ...base,
      examples: { positive: [ex('pos', { name: '甲', score: null, comment: '好' })], negative: [] },
    });
    expect(prompt).toContain('《甲》未打分');
    expect(prompt).not.toContain('《甲》分数');
  });

  it('无人工意见 → 不渲染空的「人工意见：」（空话比没有更误导）', () => {
    const prompt = buildReviewPrompt({
      ...base,
      examples: { positive: [ex('pos', { name: '乙', score: '9.00', comment: null })], negative: [] },
    });
    expect(prompt).toContain('《乙》分数 9.00');
    expect(prompt).not.toContain('人工意见');
  });

  it('人工意见超长 → 按**码点**截断并留标记（emoji 不得被切成孤立代理项）', () => {
    // 200 个码点的上限 + 20 个 emoji 垫在后面 ⇒ 截断点落在 emoji 之后，
    // 若用 `.slice()`（按 UTF-16 码元）截，代理对会被切开成孤立项，序列化即成 U+FFFD。
    const long = 'あ'.repeat(195) + '🌸'.repeat(20);
    const prompt = buildReviewPrompt({
      ...base,
      examples: { positive: [ex('pos', { name: '丙', comment: long })], negative: [] },
    });
    // ⚠️ 必须**经过编码往返**再查 U+FFFD：内存里 JS 字符串的孤立代理项是合法的，
    //    `includes('\uFFFD')` 在截断正确时也恒为假 —— 只有落成字节才暴露。
    const roundTripped = Buffer.from(prompt, 'utf8').toString('utf8');
    expect(roundTripped.includes('\uFFFD')).toBe(false);
    expect(prompt).toContain('（意见过长，已截断）');
  });
});
