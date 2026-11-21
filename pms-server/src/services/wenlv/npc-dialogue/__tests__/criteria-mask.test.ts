import { describe, it, expect } from 'vitest';
import { desensitizeCriteria } from '../criteria-mask.js';

describe('desensitizeCriteria', () => {
  it('去掉引号内的具体答案值，保留动作和对象', () => {
    const input = ["说出城中暗号'朱雀玄武'", "展示商队信物"];
    const result = desensitizeCriteria(input);
    expect(result).toEqual(['提及城中暗号', '展示商队信物']);
  });

  it('处理双引号包裹的答案', () => {
    const input = ['提到老族长的孙子小名"阿福"'];
    const result = desensitizeCriteria(input);
    expect(result).toEqual(['提及老族长的孙子']);
  });

  it('非提及类动词（展示/拿出等）原样保留', () => {
    const input = ['展示通关文牒'];
    const result = desensitizeCriteria(input);
    expect(result).toEqual(['展示通关文牒']);
  });

  it('空数组返回空数组', () => {
    expect(desensitizeCriteria([])).toEqual([]);
  });

  it('复合动词不被单字截断', () => {
    expect(desensitizeCriteria(['说明情况'])).toEqual(['说明情况']);
  });

  it('混合引号按同类型配对去除', () => {
    expect(desensitizeCriteria(["暗号\"朱雀'玄武\""])).not.toContain('"');
  });

  it('null / undefined 返回空数组', () => {
    expect(desensitizeCriteria(null)).toEqual([]);
    expect(desensitizeCriteria(undefined)).toEqual([]);
  });

  it('仅引号内容降级为关键线索', () => {
    expect(desensitizeCriteria(["'朱雀'"])).toEqual(['关键线索']);
  });
});
