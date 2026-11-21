// 队伍码（P2 §三）。**与 services/wenlv-venue.ts 的点位码字符集有意不同**：
//   · 点位码：32 个字符（含 `0`/`1`），前缀 `WLP-`，只用于扫码（不必手输）
//   · 队伍码：31 个字符（剔除 `0/O/1/I/L` —— 现场口头念码/手输的歧义字符），无前缀，8 位
// 别「顺手统一」这两个字符集：合了就会把 0/1 带进需要手输的那个码里。
import { randomInt } from 'node:crypto';

/** 字符集 = Crockford base32 去掉 `0`/`1`、把 `U` 加回来（Crockford 原本剔 I/L/O/U）⇒ 8 数字 + 23 字母 = 31 个字符 */
export const TEAM_CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
export const TEAM_CODE_LENGTH = 8;

/**
 * 生成队伍码。
 * @param random 注入点（便于测试确定性输出）；默认 `randomInt` —— **node:crypto 的 CSPRNG**，
 *   它内部已做拒绝采样、无取模偏置，所以这里**不要**再写 `floor(r() * 31)` 那套
 *   （那套配 `Math.random` 既偏又可预测）。
 */
export function genTeamCode(random: (max: number) => number = (max) => randomInt(max)): string {
  let out = '';
  for (let i = 0; i < TEAM_CODE_LENGTH; i++) {
    out += TEAM_CODE_ALPHABET[random(TEAM_CODE_ALPHABET.length)];
  }
  return out;
}
