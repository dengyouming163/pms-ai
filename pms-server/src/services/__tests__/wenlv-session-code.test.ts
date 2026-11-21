import { describe, it, expect, vi } from 'vitest';
import { TEAM_CODE_ALPHABET, TEAM_CODE_LENGTH, genTeamCode } from '../wenlv-session-code.js';

describe('队伍码生成器（P2 §三）', () => {
  it('字符集：31 个、互不重复、剔除 0/O/1/I/L', () => {
    expect(TEAM_CODE_ALPHABET).toHaveLength(31);
    // 重复字符会**静默**缩小空间（31 个字符里若重复一个，实际只有 30 个）
    expect(new Set(TEAM_CODE_ALPHABET).size).toBe(31);
    expect(TEAM_CODE_ALPHABET).not.toMatch(/[01OIL]/);
    // 负判据：**不能**与点位码的 32 字符集混用（那边含 0/1，现场手输会歧义）
    expect(TEAM_CODE_ALPHABET).not.toBe('0123456789ABCDEFGHJKMNPQRSTVWXYZ');
  });

  it('长度 8；注入 random ⇒ 确定性输出，且钉住索引方向', () => {
    expect(TEAM_CODE_LENGTH).toBe(8);
    expect(genTeamCode(() => 0)).toBe('22222222');          // alphabet[0]
    expect(genTeamCode((max) => max - 1)).toBe('ZZZZZZZZ'); // alphabet[30]：反向取索引会红
    expect(genTeamCode(() => 0)).toHaveLength(8);
  });

  it('默认随机源 smoke：1000 次都是 8 位、字符在集内（不验随机性）', () => {
    for (let i = 0; i < 1000; i++) {
      const code = genTeamCode();
      expect(code).toHaveLength(8);
      for (const ch of code) expect(TEAM_CODE_ALPHABET).toContain(ch);
    }
  });

  it('默认随机源是 CSPRNG：不读 Math.random', () => {
    // 队伍码不授予票池（领队码才授予），但它是**可猜即入队**的凭证 ⇒ 不该用可预测的 PRNG。
    // 这条是结构判据：一旦有人图省事换成 Math.random，它会红。
    const spy = vi.spyOn(Math, 'random');
    genTeamCode();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
  });
});
