// 挂载顺序的静态判据：不跑路由，只读 src/index.ts 的文本。
// 为什么需要它：顺序错了的症状是「/unified 恒 404 且看起来像订单不存在」，而**没有任何运行期
// 判据能区分它**（两条路径都要先登录、再查库，失败形态一样）。所以这里判**文本**。
// 与 pms-platform/pms-platform-server/src/index.ts:219-227 用注释声明的同一件事 —— 这里升级成闸。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

// ⚠️ 到 src/index.ts 必须是**三级**：`'../../index.ts'` 会从本文件所在目录（src/routes/mini/__tests__/）
//    解析到 src/routes/index.ts —— **该文件不存在**（实测 ENOENT，import 期即抛）。别改成两级。
const SRC = readFileSync(new URL('../../../index.ts', import.meta.url), 'utf8');

// 🔴 针必须**行首锚定**（`\n` + 语句文本）：裸 indexOf 会被**注释文本**命中。
//    实测（裸针版）：index.ts 里那段说明顺序的注释本身就写着 `app.route('/api/mini/orders', …)`
//    ⇒ 裸针的 wide 落在**注释**上而不是语句上 ⇒ 判据恒红，且报出的「窄前缀在后面」是假因。
//    （与「判据字面量自污染」同型：判据的针出现在被扫描文本的别处。）
//    ⚠️ 刻意不写绝对偏移数字：偏移会被其后任何一次插入/改写推漂（本片踩过一次）⇒ 写下的数字会自己过期。
const atLineStart = (needle: string) => SRC.indexOf('\n' + needle);

describe('合并订单路由的挂载顺序', () => {
  it('窄前缀 /api/mini/orders/unified 必须在 /api/mini/orders 之前注册', () => {
    const narrow = atLineStart("app.route('/api/mini/orders/unified'");
    const wide = atLineStart("app.route('/api/mini/orders'");
    expect(narrow, '没有注册 /api/mini/orders/unified').toBeGreaterThan(-1);
    expect(wide, '没有注册 /api/mini/orders').toBeGreaterThan(-1);
    expect(narrow, '窄前缀必须在宽前缀之前，否则 /:id 会先吃掉 /unified').toBeLessThan(wide);
  });
});
