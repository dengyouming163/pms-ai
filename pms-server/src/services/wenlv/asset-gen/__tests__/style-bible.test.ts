import { describe, it, expect } from 'vitest';
import { buildStyleBiblePrompt, parseStyleBible, STYLE_BIBLE_SYSTEM } from '../style-bible.js';

/**
 * 断言抛错：等价于 `expect(fn).toThrow()`，但**不依赖 matcher 的类型声明**。
 *
 * ⚠️ 2026-09-19 更正：此注释原先写「桩里没有声明裸 `toThrow`，故仓库一律回避」——
 *    那句已不成立。`src/types/vitest.d.ts` 自 d5a65359（Task 8）起**已声明** `toThrow`
 *    与 `toBeLessThan`（纯追加，符合该文件第 2 行「用时补桩」的约定）。
 *    本 helper 保留是因为它已在多处使用、断言意图（「抛了没有」）比 `.toThrow()`
 *    的空参形式更直白；**新写的测试可以直接用 `toThrow`，不必再造这个 helper**。
 */
function expectThrow(fn: () => unknown): void {
  let threw = false;
  try { fn(); } catch { threw = true; }
  expect(threw).toBe(true);
}

describe('风格基线自举提示词（纯函数）', () => {
  const base = {
    productName: '龙门镇谜案',
    subtitle: '黔中古镇悬疑',
    theme: { primaryColor: '#2f4f4f', templateId: 'tpl-ink' },
    config: { world_setting: { era: '民国' }, storyline: { theme: '寻亲' } },
    nodeTitles: ['入镇', '古井'],
    venuePointNames: ['龙门古井', '老戏台'],
  };

  it('提示词里带上产品名、节点标题与真实点位名', () => {
    const p = buildStyleBiblePrompt(base);
    expect(p).toContain('龙门镇谜案');
    expect(p).toContain('入镇');
    expect(p).toContain('龙门古井');
  });

  it('要求输出规定的八个字段', () => {
    const p = buildStyleBiblePrompt(base) + STYLE_BIBLE_SYSTEM;
    for (const f of ['artStyle', 'palette', 'era', 'brushwork', 'mood', 'mustHave', 'forbidden', 'notes']) {
      expect(p).toContain(f);
    }
  });

  it('parseStyleBible 能剥掉 markdown 围栏', () => {
    const b = parseStyleBible('```json\n{"artStyle":"水墨"}\n```');
    expect(b.artStyle).toBe('水墨');
  });

  it('parseStyleBible 遇到非法 JSON 抛错而不是返回空对象', () => {
    // 静默返回 {} 等于「用空基线出图」—— 出一批风格漂移的图比不出更糟
    expectThrow(() => parseStyleBible('这不是 JSON'));
  });

  it('parseStyleBible 丢弃非字符串的 forbidden 项', () => {
    // 夹具必须带 artStyle —— 本用例测的是 forbidden 的类型过滤，但 parseStyleBible
    // 有「缺 artStyle 就抛错」的守卫。少了它根本走不到断言，
    // 会以 `风格基线缺少 artStyle` 报错，看起来像过滤逻辑坏了。
    const b = parseStyleBible('{"artStyle":"水墨","forbidden":["现代物件",123,null,"人脸"]}');
    expect(b.forbidden).toEqual(['现代物件', '人脸']);
  });

  it('parseStyleBible 缺 artStyle 时抛错（防「空基线出图」的红线）', () => {
    // 与上一条的区别：上一条证明过滤正确，这一条证明**守卫真的在**。
    // 两者都重要 —— 守卫若被后人删掉，只有这条会红。
    expectThrow(() => parseStyleBible('{"palette":["#fff"]}'));
  });

  it('parseStyleBible 容忍语言标注的大小写与空格', () => {
    // LLM 写 ```JSON 是常见写法。为此整批失败不值当 —— 失败代价是
    // 「风格基线自举失败」，而用户看到的只是「生成不了」。
    expect(parseStyleBible('```JSON\n{"artStyle":"水墨"}\n```').artStyle).toBe('水墨');
    expect(parseStyleBible('``` json\n{"artStyle":"水墨"}\n```').artStyle).toBe('水墨');
  });

  it('parseStyleBible 容忍 JSON 前的寒暄', () => {
    const raw = '好的，这是该剧本的画风规范：\n```json\n{"artStyle":"水墨"}\n```';
    expect(parseStyleBible(raw).artStyle).toBe('水墨');
  });

  it('parseStyleBible 不破坏字符串值里的反引号', () => {
    // 全局 replace(/```/g, '') 会把值里的 ``` 一起抹掉 —— 解析"成功"、内容却被静默
    // 改动。这条钉死「只剥包裹整体的围栏」。
    const b = parseStyleBible('{"artStyle":"水墨","notes":"用 ``` 包围"}');
    expect(b.notes).toBe('用 ``` 包围');
  });

  it('parseStyleBible 拒绝合法 JSON 但不是对象（守卫必须有用例钉住）', () => {
    // 后人删掉「必须是对象」这道守卫时，只有这条会红。
    expectThrow(() => parseStyleBible('[1,2]'));
    expectThrow(() => parseStyleBible('"abc"'));
    expectThrow(() => parseStyleBible('null'));
    expectThrow(() => parseStyleBible('123'));
  });

  it('parseStyleBible 把全空白的 artStyle 视为缺失', () => {
    // 与 zod 空串脏引用同类：`"   "` 过得了 typeof 检查，但不是一个可用画风。
    expectThrow(() => parseStyleBible('{"artStyle":"   "}'));
  });
});
