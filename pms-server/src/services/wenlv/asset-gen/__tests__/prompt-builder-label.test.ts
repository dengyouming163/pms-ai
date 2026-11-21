import { describe, it, expect } from 'vitest';
import { buildScenePrompt } from '../prompt-builder.js';
import { TYPE_LABEL } from '../prompt-builder.js';
import { ASSET_TYPES, ALL_ASSET_TYPES } from '../asset-types.js';

describe('TYPE_LABEL 与注册表同源', () => {
  // ⚠️ 这里**不能**写 `expect(TYPE_LABEL[t]).toBe(ASSET_TYPES[t].promptLabel)` ——
  //    `TYPE_LABEL` 就是从 `promptLabel` 投影出来的，那句在结构上**永远为真**，
  //    注册表里漏一条 `promptLabel`（`undefined`）它照样绿。恒真断言 = 没测。
  //    下面断的是三条**真会失效**的性质：值存在、非空、不是英文类型名回落。
  it('每个类型都有非空中文说明，且不回落成英文类型名', () => {
    for (const t of ALL_ASSET_TYPES) {
      const v = TYPE_LABEL[t] as string | undefined;
      expect(typeof v, `${t} 缺说明（promptLabel 漏了？）`).toBe('string');
      expect(v!.trim(), `${t} 的说明是空串`).not.toBe('');
      expect(v, `${t} 回落成了英文类型名`).not.toBe(t);
    }
  });

  // ★ 本 Task 的**核心判据**：这五条是重构前就存在的文案，必须逐字节不变。
  //   写死字面量（而不是 `toBe(ASSET_TYPES.background.promptLabel)`）才叫判据 ——
  //   后者两边一起改就永远绿，等于没测。
  it('五类既有类型的说明逐字节不变（重构不改行为的守卫）', () => {
    expect(TYPE_LABEL.background).toBe('点位背景插画（横幅，供游客在点位阅读剧情时作背景）');
    expect(TYPE_LABEL.stamp).toBe('集章印章图案（圆形/方形章面，单色线条为主，便于印刷与叠印）');
    expect(TYPE_LABEL.cover).toBe('剧本封面海报（竖版，用于门票产品与分享）');
    expect(TYPE_LABEL.icon).toBe('小图标（简洁单色，小尺寸可辨识）');
    expect(TYPE_LABEL.collectible).toBe(
      '图鉴物件插画（单件证物特写，主体居中、占画面主体部分，小尺寸缩略图下仍清晰可辨）',
    );
  });

  it('新类型（ending / reward）也有说明', () => {
    expect(TYPE_LABEL.ending).toContain('结局');
    expect(TYPE_LABEL.reward).toContain('奖励');
  });

  // 反向判据：`TYPE_LABEL` 必须投影自 `promptLabel`（长说明），不得有人把它写成短 `label`。
  // ⚠️ **必须逐类覆盖全部 10 条**，不能只挑一条代表。只查 `background` 的话，
  //    把**别的**类型改成短名（如 `ending.promptLabel = '结局插画'`）全绿 ——
  //    而「结局插画」与短名同字，`toContain('结局')` 也照样绿（见上一条），
  //    于是「结局图的提示词被悄悄换成 job 名」这件事**没有任何一条断言会红**。
  it('全部 10 类都不得回落成短 label（反向判据，逐类）', () => {
    for (const t of ALL_ASSET_TYPES) {
      expect(TYPE_LABEL[t], `${t} 回落成了短 label（promptLabel 被写成 label？）`)
        .not.toBe(ASSET_TYPES[t].label);
    }
  });

  it('端到端：collectible 仍渲染成完整中文说明（复刻既有断言）', () => {
    const p = buildScenePrompt({
      productName: '龙门镇武侠夜游', worldSetting: null,
      nodeTitle: '半枚残破铜钱', storyText: '沈砚随身携带。',
      assetType: 'collectible',
    });
    expect(p).toContain('（图鉴物件插画');
    expect(p).not.toContain('（collectible）');
  });
});
