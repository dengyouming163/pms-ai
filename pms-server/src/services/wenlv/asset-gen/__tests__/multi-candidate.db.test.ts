// 候选落库 id 规则 —— 纯函数用例，**本身不需要 RUN_DB**。
//
// ⚠️ 但它**不是**「不碰 DB」：`candidate-store.ts` 在模块顶层 import 了 `db`
//    （`../../../db/index.js`），而 `db/index.ts` 顶层就 `new Pool({ host: required('PG_HOST'), … })`
//    ⇒ **PG_HOST 缺失时 import 期直接抛 FATAL**（错误信息长得很像「缺 DB」，容易被误判）。
//    两个仓库 config 都注入 PG_*，所以门禁下无害；换成别的 runner（`node --test`、新 config）
//    就会在加载期炸。要单跑这个文件，先给齐 PG_* 环境变量。
import { describe, it, expect } from 'vitest';
import { designAssetIdFor } from '../candidate-store.js';

describe('候选落库 id 规则', () => {
  it('单候选的 id 与历史行一致（wa-<jobId>），保证既有素材不被重写', () => {
    expect(designAssetIdFor('job1', 0)).toBe('wa-job1');
  });

  it('多候选时 index 0 仍是 wa-<jobId>，其余加后缀', () => {
    expect(designAssetIdFor('job1', 1)).toBe('wa-job1-1');
    expect(designAssetIdFor('job1', 2)).toBe('wa-job1-2');
  });

  it('超长 jobId 截断到 50（列宽）', () => {
    const long = 'j'.repeat(80);
    // 不用 toBeLessThanOrEqual —— 本仓的 vitest 类型桩没声明它（见 claim.db.test.ts
    // 与 enqueue.test.ts 里同一条注记）。非负整数上 `<= 50` 与它等价。
    expect(Array.from(designAssetIdFor(long, 0)).length <= 50).toBe(true);
  });

  it('截断按**码点**，不切碎代理对（落库变 U+FFFD 的脏值是从这里来的）', () => {
    // 40 个 emoji = 40 码点 / 80 码元。`.slice()` 会从代理对中间切开，留下孤立代理项，
    // 落库时被编码成 U+FFFD —— 无报错、无日志。这里断言结果里**没有任何孤立代理项**。
    const emoji = '😀'.repeat(40);
    const id = designAssetIdFor(emoji, 0);
    expect(Array.from(id).length <= 50).toBe(true);
    // 孤立代理项：高代理 D800–DBFF 或低代理 DC00–DFFF 单独出现。
    // 用 `for...of`（按码点迭代）取出每个字符，长度 1 即为孤立代理。
    const hasLoneSurrogate = [...id].some((ch) => ch.length === 1 && ch.charCodeAt(0) >= 0xd800);
    expect(hasLoneSurrogate).toBe(false);
    // 正向：截断后仍是合法码点序列（`Array.from` 往返无损）。
    expect(Array.from(id).join('')).toBe(id);
  });

  it('长 jobId 下 index 0 与 index N **不撞成同一个 id**（后缀必须先留位再截）', () => {
    // 修前是「先拼后缀、后整体截到 50」⇒ jobId 够长时 `-2` 被截掉，
    // index 0 与 index 2 算出同一个 id，第二次 writeCandidate 会**更新**第一行，
    // 两张候选静默塌成一行。这条断言就是那个 bug 的看守。
    const long = 'j'.repeat(80);
    const id0 = designAssetIdFor(long, 0);
    const id2 = designAssetIdFor(long, 2);
    expect(id0).not.toBe(id2);
    expect(id0.endsWith('-2')).toBe(false);
    expect(id2.endsWith('-2')).toBe(true);
    expect(Array.from(id2).length <= 50).toBe(true);
    // 对真实输入（36 字符 UUID）逐字节不变 —— 保证既有素材不被重写。
    const uuid = '12345678-1234-1234-1234-1234567890ab';
    expect(designAssetIdFor(uuid, 0)).toBe(`wa-${uuid}`);
    expect(designAssetIdFor(uuid, 3)).toBe(`wa-${uuid}-3`);
  });
});
