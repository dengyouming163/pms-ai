import { describe, it, expect, afterAll } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvNpcs, pmsBuiWenlvCharacters, pmsBuiWenlvScenes, pmsBuiWenlvChapters, pmsBuiWenlvScriptRooms } from '../../../db/schema/index.js';
import { eq, inArray } from 'drizzle-orm';

// 内部 token 从 vitest.local.config.ts 注入（'test-internal-token'），与 pms-server constants.js 顶层取值一致
// ⚠️ 不用 `|| 'internal-secret-dev'` 兜底：那是个**构造上不可达**的死分支 ——
// `wenlv.js`（上面第 2 行的 import）会经 `src/constants.ts:12` 在**加载期**读同一个变量，
// 缺失时直接抛 `FATAL: INTERNAL_SERVICE_TOKEN 环境变量未设置！`，第 8 行根本执行不到。
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN!;
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

/** 每个用例一个**独立产品**：避免跨用例对「库里剩几个 NPC」的隐性耦合
 *  （本文件用例虽不像 characters 那样有「删最后一个被拦」的约束，但保持同款骨架便于审计）。 */
const TAG = 'npc-' + Date.now();
const created: string[] = [];
async function mkProd(suffix: string): Promise<string> {
  const id = `${TAG}-${suffix}`;
  await db.insert(pmsBuiWenlvProducts).values({ id, name: 'NPC 夹具剧本' }).onConflictDoNothing();
  // 统一建一房一章：级联测试要往 scenes 挂 npcId，scenes 需 chapterId
  await db.insert(pmsBuiWenlvScriptRooms).values({ id: `room-${id}`, contentId: id, name: 'NPC 房', mode: 'narrative' }).onConflictDoNothing();
  await db.insert(pmsBuiWenlvChapters).values({ id: `ch-${id}`, scriptRoomId: `room-${id}`, title: '第一章', order: 0 }).onConflictDoNothing();
  created.push(id);
  return id;
}

/** NPC 夹具：只给必填（name + lines 至少 1 条）。其余可选列一律不写。 */
const NPC = (over: Record<string, unknown> = {}) => ({
  name: '讲解员',
  lines: [{ id: 'l1', text: '欢迎来到景区', voiceUrl: null, duration: 3.5 }],
  ...over,
});

/** 四个**有宽度上限**的 NPC 文本列：`[字段, 中文名, 上限]`。
 *  🔴 上限是**判据自己的字面量**（逐字抄自建表迁移 `drizzle/0043_wenlv_npcs.sql:25-34`），
 *     **绝不从实现 import `NPC_TEXT_MAX`** —— 若拿实现的值来算「恰好 N 个字符」，
 *     上限写错时实现与判据会同时偏（同一个值两边一起错）⇒ 该判据**零判别力**。
 *  POST 侧与 PATCH 侧**共用这一份**（与 characters 的 `TEXT_WIDTH_MAXES` 同款）。 */
const NPC_TEXT_WIDTH_MAXES: Array<[string, string, number]> = [
  ['name', 'NPC 名称', 50],
  ['role', 'NPC 定位', 50],
  ['portraitUrl', '立绘地址', 500],
  ['voiceId', '音色 ID', 50],
];

describe.skipIf(!process.env.RUN_DB)('wenlv 剧本 NPC CRUD（Task 3）', () => {
  afterAll(async () => {
    if (created.length) {
      const chapterIds = created.map((p) => `ch-${p}`);
      const roomIds = created.map((p) => `room-${p}`);
      // T33 级联测试会建 scenes，需在 NPC/产品清掉之前先清 scenes（npcs 表 delete 已级联清过一部分，
      // 但 del-no-cascade 那条 case 删 NPC 时该 NPC 没场景引用 ⇒ 场景仍在）。
      await db.delete(pmsBuiWenlvScenes).where(inArray(pmsBuiWenlvScenes.chapterId, chapterIds));
      await db.delete(pmsBuiWenlvChapters).where(inArray(pmsBuiWenlvChapters.id, chapterIds));
      await db.delete(pmsBuiWenlvScriptRooms).where(inArray(pmsBuiWenlvScriptRooms.id, roomIds));
      await db.delete(pmsBuiWenlvNpcs).where(inArray(pmsBuiWenlvNpcs.productId, created));
      // 顺带清掉本文件可能建出来的 characters（R-N3 正负判据会建夹具角色）
      await db.delete(pmsBuiWenlvCharacters).where(inArray(pmsBuiWenlvCharacters.productId, created));
      await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, created));
    }
  });

  it('POST 建 NPC：全字段落库，lines 长度为 1', async () => {
    const P = await mkProd('create');
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      body: JSON.stringify(NPC({
        id: `${TAG}-c1`, order: 2, role: '向导',
        portraitUrl: 'https://oss.test/a.png', portraitPrompt: '水墨风，青衫',
        voiceId: 'voice-1', description: '讲解员小张',
        characterId: null,
      })),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    expect(row.name).toBe('讲解员');
    // ⚠️ NPC schema 用 `orderId` 作为 JS 字段名（映射到 DB 列 `order`）—— 与 characters
    // 那张表（JS 字段直接叫 `order`）刻意不同。drizzle 返回行用 JS 字段名 ⇒ 响应键是 `orderId`。
    expect(row.orderId).toBe(2);
    expect(row.role).toBe('向导');
    expect(row.portraitUrl).toBe('https://oss.test/a.png');
    expect(row.voiceId).toBe('voice-1');
    expect(row.description).toBe('讲解员小张');
    // 承重：lines 长度为 1（不是空数组、也不是 null）—— 这是 NPC 区别于 characters 的核心列
    expect(Array.isArray(row.lines)).toBe(true);
    expect(row.lines).toHaveLength(1);
    expect(row.lines[0]).toEqual({ id: 'l1', text: '欢迎来到景区', voiceUrl: null, duration: 3.5 });
  });

  it('POST 缺 name ⇒ 400，且一行都不落库', async () => {
    const P = await mkProd('no-name');
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ name: '   ' })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NPC 名称不能为空');
    // 承重：只断状态码的话，「先插入再报错」的实现也会绿 ⇒ 必须断**该行确实没建出来**
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    expect(rows).toHaveLength(0);
  });

  it('POST rejects empty lines (R-N4)：lines: [] ⇒ 400，且不落库', async () => {
    const P = await mkProd('empty-lines');
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      // ⚠️ 判别力必须用 `lines: []` 而不是 `lines: undefined` —— 后者可能走列默认值 `[]`
      // 也可能 400，口径模糊；显式空数组把 R-N4 钉死在「至少 1 条」这一条规则上。
      body: JSON.stringify(NPC({ id: `${TAG}-empty`, lines: [] })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NPC 至少要有 1 条台词');
    // 承重：只断 400 的话，「先插入再报错」的实现也会绿 ⇒ 必须断该行没建出来
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    expect(rows).toHaveLength(0);
  });

  it('POST 到不存在的产品 ⇒ 404（且文案是 getProductOr404 那条）', async () => {
    const res = await adminWenlvRoute.request(`/products/${TAG}-no-such/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC()),
    });
    expect(res.status).toBe(404);
    // 承重：本条的 404 现在来自 handler 分支（路径模式能匹配）。body 断言防的是**路由被删/改名**
    // 这类回归 —— Hono 对未匹配路由也回 404（鉴权中间件放行后；不带 token 是先 403），但 body 是**纯文本**
    // （`res.json()` 会直接抛）。文案取自 getProductOr404。
    const body = await res.json();
    expect(body.error).toBe('内容产品不存在');
  });

  it('POST 幂等重入：同 id 再 POST 返回**同一行**，且不被第二次 body 改写', async () => {
    const P = await mkProd('idem');
    const id = `${TAG}-c-idem`;
    const first = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id, name: '首名' })),
    });
    expect((await first.json()).data.name).toBe('首名');
    const second = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id, name: '二名' })),
    });
    expect(second.status).toBe(200);
    // 承重：只断 200 的话，「先删后插」的实现也会绿 —— 必须断言**第二次的 body 没生效**
    expect((await second.json()).data.name).toBe('首名');
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id));
    expect(rows).toHaveLength(1);
  });

  it('POST R-N3 正判据：character_id 属于该 product ⇒ 200（不报 400）', async () => {
    const P = await mkProd('char-ok');
    // 在该 product 下先建一个 character
    const [char] = await db.insert(pmsBuiWenlvCharacters).values({
      id: `${TAG}-char-ok`, productId: P,
      name: '关联角色', faction: '清流党', identity: '隐士',
      vitality: 60, wisdom: 80, insight: 70,
    }).returning();
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      body: JSON.stringify(NPC({ id: `${TAG}-c-char-ok`, characterId: char.id })),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.characterId).toBe(char.id);
  });

  it('POST R-N3 负判据：character_id 不属于该 product ⇒ 400，且不落库', async () => {
    const P = await mkProd('char-cross');
    const POther = await mkProd('char-cross-other');
    // 在「另一个产品」下建 character，然后让本产品的 NPC 引用它（跨产品脏引用）
    const [otherChar] = await db.insert(pmsBuiWenlvCharacters).values({
      id: `${TAG}-char-other`, productId: POther,
      name: '别家角色', faction: '清流党', identity: '隐士',
      vitality: 60, wisdom: 80, insight: 70,
    }).returning();
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      body: JSON.stringify(NPC({ id: `${TAG}-c-char-cross`, characterId: otherChar.id })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('角色不存在或不属于该剧本');
    // 承重：只断 400 的话，「先插入再报错」的实现也会绿 ⇒ 必须断该行没建出来
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    expect(rows).toHaveLength(0);
  });

  it('POST lines 洗形：丢掉 id/text 非字符串或空的项 + voiceUrl 非字符串落 null + duration 非数字落 undefined + 多余键被丢弃', async () => {
    const P = await mkProd('wash');
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      body: JSON.stringify(NPC({
        id: `${TAG}-c-wash`,
        lines: [
          // 第 1 条：全合法 + 多余键 extra（应被丢弃）
          { id: 'l1', text: 'hello', voiceUrl: 'http://x', duration: 3.5, extra: 'drop' },
          // 第 2 条：id 是纯空白 ⇒ 整条丢弃
          { id: '   ', text: '应被丢弃', voiceUrl: null, duration: 1 },
          // 第 3 条：text 是纯空白 ⇒ 整条丢弃
          { id: 'l2', text: '   ', voiceUrl: null, duration: 1 },
          // 第 4 条：voiceUrl 非字符串（数字）⇒ 落 null；duration 非数字（字符串 'bad'）⇒ 落 undefined
          { id: 'l3', text: 'world', voiceUrl: 123, duration: 'bad' },
          // 第 5 条：id 非字符串（数字）⇒ 整条丢弃
          { id: 42, text: '应被丢弃', voiceUrl: null, duration: 1 },
        ],
      })),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    // 承重：normalizeNpcLines 是 route 层唯一的形态闸 —— 5 条入参里只有 l1 / l3 是合法项。
    // 变异实测：若实现裸透 body.lines，端面会拿到带 `extra` 字段 + 非字符串 voiceUrl + 字符串 duration 的脏数据。
    expect(row.lines).toHaveLength(2);
    // ⚠️ duration 落 undefined 时 JSON.stringify 会**省略该键**（不是 null）——
    // `toEqual` 对「键不存在」与「键存在且值为 undefined」一视同仁，故这里不带 duration 即可。
    expect(row.lines[0]).toEqual({ id: 'l1', text: 'hello', voiceUrl: 'http://x', duration: 3.5 });
    expect(row.lines[1]).toEqual({ id: 'l3', text: 'world', voiceUrl: null });
  });

  it('POST lines id 重复 ⇒ 400（R-N4 唯一性条款），且不落库', async () => {
    const P = await mkProd('dup-id');
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      body: JSON.stringify(NPC({
        id: `${TAG}-c-dup`,
        lines: [
          { id: 'l1', text: '甲', voiceUrl: null },
          { id: 'l1', text: '乙', voiceUrl: null },  // 同 id
        ],
      })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NPC 台词 id 不能重复');
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    expect(rows).toHaveLength(0);
  });

  it('GET 列表按 order 升序，平手用 createdAt 兜稳', async () => {
    const P = await mkProd('list');
    // 故意按乱序插：3 / 1 / 2，断言 GET 返回 1 / 2 / 3
    for (const [i, o] of [[3, 3], [1, 1], [2, 2]] as const) {
      await adminWenlvRoute.request(`/products/${P}/npcs`, {
        method: 'POST', headers: H,
        body: JSON.stringify(NPC({ id: `${TAG}-c-l${i}`, name: `NPC${i}`, order: o })),
      });
    }
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, { headers: H });
    expect(res.status).toBe(200);
    const list = (await res.json()).data;
    // 承重：order 升序钉住「排序键没被绕过」；只断 length 会让「按 createdAt 排」的实现也绿
    expect(list.map((r: any) => r.orderId)).toEqual([1, 2, 3]);
    // 循环 [[3,3],[1,1],[2,2]] ⇒ 第 1 次建 l3(order=3)、第 2 次建 l1(order=1)、第 3 次建 l2(order=2)
    // ⇒ 按 order 升序的 id 序是 [l1, l2, l3]。这一条钉住「id 与 orderId 对齐」，
    // 防「返回顺序是插入序（l3,l1,l2）但 orderId 恰好为 [1,2,3]」的假绿。
    expect(list.map((r: any) => r.id)).toEqual([`${TAG}-c-l1`, `${TAG}-c-l2`, `${TAG}-c-l3`]);
  });

  it('GET 列表跨产品不串：只返回本产品的 NPC', async () => {
    const P = await mkProd('cross');
    const POther = await mkProd('cross-other');
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id: `${TAG}-c-cross-mine`, name: '本家' })),
    });
    await adminWenlvRoute.request(`/products/${POther}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id: `${TAG}-c-cross-other`, name: '别家' })),
    });
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, { headers: H });
    expect(res.status).toBe(200);
    const list = (await res.json()).data;
    // 承重：`toEqual` 已蕴含 `Array.isArray` 与「不包含别家」—— 这一条是「跨剧本泄漏」的负判据
    expect(list.map((r: any) => r.id)).toEqual([`${TAG}-c-cross-mine`]);
    expect(list.map((r: any) => r.id)).not.toContain(`${TAG}-c-cross-other`);
  });

  it('PATCH 改 name + lines：原值被新值覆盖；可清空 characterId（传 null）', async () => {
    const P = await mkProd('patch');
    const id = `${TAG}-c-patch`;
    // 种子：characterId 先挂上一个 character（验证 PATCH 能清空软引用）
    const [char] = await db.insert(pmsBuiWenlvCharacters).values({
      id: `${TAG}-char-patch`, productId: P,
      name: '种子角色', faction: '清流党', identity: '隐士',
      vitality: 60, wisdom: 80, insight: 70,
    }).returning();
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      body: JSON.stringify(NPC({ id, characterId: char.id })),
    });
    const res = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({
        name: '更新后的讲解员',
        lines: [{ id: 'l2', text: '新台词', voiceUrl: 'http://y' }],
        characterId: null,  // 清空软引用
      }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    expect(row.name).toBe('更新后的讲解员');
    expect(row.lines).toEqual([{ id: 'l2', text: '新台词', voiceUrl: 'http://y' }]);
    expect(row.characterId).toBeNull();
  });

  it('PATCH name 清空 ⇒ 400，且原值不动（与 POST 同一条口径）', async () => {
    const P = await mkProd('patch-name');
    const id = `${TAG}-c-patch-name`;
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id })),
    });
    const bad = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '   ' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('NPC 名称不能为空');
    // 承重：只断 400 的话，「先写空再报错」的实现也会绿 ⇒ 必须断原值还在
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.name).toBe('讲解员');
  });

  it('PATCH lines 传 [] ⇒ 400（R-N4 在 PATCH 侧同样落地）', async () => {
    const P = await mkProd('patch-empty');
    const id = `${TAG}-c-patch-empty`;
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id })),
    });
    const bad = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ lines: [] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('NPC 至少要有 1 条台词');
    // 承重：必须断原值还在 —— 只断 400 的话，「先洗成 [] 再报错」的实现也会绿
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.lines).toHaveLength(1);
  });

  it('PATCH 不存在的 NPC ⇒ 404（且文案点名「NPC 不存在」）', async () => {
    const res = await adminWenlvRoute.request(`/npcs/${TAG}-ghost`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '改名' }),
    });
    expect(res.status).toBe(404);
    // 承重：断 body 文案才能把「handler 的 JSON 404」与「路由未匹配的纯文本 404」区分开
    const body = await res.json();
    expect(body.error).toBe('NPC 不存在');
  });

  it('DELETE 移除 NPC：200 且行被删（NPC 无「至少 1 个」守卫，删到 0 也允许）', async () => {
    const P = await mkProd('del');
    const id = `${TAG}-c-del`;
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id })),
    });
    const res = await adminWenlvRoute.request(`/npcs/${id}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(200);
    // 承重：必须断**行真的没了** —— 只断 200 的话，「软删/不删」的实现也会绿
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id));
    expect(rows).toHaveLength(0);
  });

  it('DELETE 级联清空引用节点：unlinkedNodes 返受影响节点 id，节点 npcId/npcLineIds 被清空（T33）', async () => {
    // T33 落地 spec §4.3 软引用约束：删 NPC 须反向清空引用它的节点的 npcId/npcLineIds，
    // 否则管理端 full 接口仍会下发 npcId 字段让前端表单误以为该 NPC 还活着（spec §8.10 端面兜底
    // 能护游客端，但护不住管理端 ⇒ 必须在删除侧级联）。
    const P = await mkProd('del-cascade');
    const chId = `ch-${P}`;
    const npcId = `${TAG}-del-cascade`;
    const nodeId1 = `${TAG}-del-cascade-n1`;
    const nodeId2 = `${TAG}-del-cascade-n2`;
    const otherNpcId = `${TAG}-del-cascade-other`;
    // 建一个 NPC + 另一个 NPC + 两个场景（一个引用此 NPC、一个引用另一个 NPC）
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id: npcId })),
    });
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id: otherNpcId, name: '其他 NPC' })),
    });
    // 场景通过 DB 直插（旧 POST /products/:id/nodes 已退役，新端点 POST /chapters/:id/scenes
    // 不接受自定义 id；级联断言依赖固定 id ⇒ 直插）
    await db.insert(pmsBuiWenlvScenes).values([
      { id: nodeId1, chapterId: chId, title: '节点1', type: 'narrative', npcId, npcLineIds: ['l1'] },
      { id: nodeId2, chapterId: chId, title: '节点2', type: 'narrative', npcId: otherNpcId, npcLineIds: [] },
    ]);
    // 删除 npcId：应级联清空 nodeId1，但不动 nodeId2
    const res = await adminWenlvRoute.request(`/npcs/${npcId}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(200);
    const body = await res.json();
    // unlinkedNodes 必须只含 nodeId1（不含 nodeId2），证明级联只针对当前删除的 NPC
    expect(body.unlinkedNodes).toEqual([nodeId1]);
    // 验证场景1 已被清空
    const [n1] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, nodeId1));
    expect(n1.npcId).toBeNull();
    expect(n1.npcLineIds).toEqual([]);
    // 验证场景2 未被波及（otherNpcId 仍挂在那）
    const [n2] = await db.select().from(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.id, nodeId2));
    expect(n2.npcId).toBe(otherNpcId);
  });

  it('DELETE NPC 无引用节点：unlinkedNodes 为空数组（不报错）', async () => {
    // 承重：级联实现里 UPDATE WHERE npc_id = $id 在 0 行命中时返 []，
    // 不能因为「无引用」就报错或返 null —— 必须显式 []。
    const P = await mkProd('del-no-cascade');
    const npcId = `${TAG}-del-no-cascade`;
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id: npcId })),
    });
    const res = await adminWenlvRoute.request(`/npcs/${npcId}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.unlinkedNodes).toEqual([]);
  });

  it('DELETE 不存在的 NPC ⇒ 404（且文案点名「NPC 不存在」）', async () => {
    const res = await adminWenlvRoute.request(`/npcs/${TAG}-ghost`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(404);
    // 承重：同上 —— 断 body 文案才能把「handler 的 JSON 404」与「路由未匹配的纯文本 404」区分开
    const body = await res.json();
    expect(body.error).toBe('NPC 不存在');
  });

  it('POST id 超过 50 字符 ⇒ 400（不是 500）', async () => {
    const P = await mkProd('id-too-long');
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id: 'x'.repeat(51) })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NPC id 超长（最多 50 字符）');
  });

  // ─── C1 修复回归 ───────────────────────────────────────────────
  // 早期实现把 `null` 当清空放行（`body.lines !== null` 才进 R-N4 校验），导致
  // `PATCH {lines: null}` 落到 `patch.lines = []`、返回 200，**绕过 R-N4**。
  // 这一条把 R-N4 在 PATCH 侧的 `null` 路径钉死：必须 400、原 lines 不动。
  it('C1 回归：PATCH {lines: null} ⇒ 400 且原 lines 不动（不能清成空数组）', async () => {
    const P = await mkProd('c1-null');
    const id = `${TAG}-c-c1-null`;
    const orig = [{ id: 'l1', text: '原始台词', voiceUrl: null }];
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id, lines: orig })),
    });
    const bad = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ lines: null }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('NPC 至少要有 1 条台词');
    // 承重：必须断原 lines 还在 —— 只断 400 的话，「先洗成 [] 再报错」的实现也会绿。
    // 这正是未加 R-N4 null 校验时的实测行为：`PATCH {lines: null}` 把 lines 静默清成 []。
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.lines).toEqual(orig);
  });

  // ─── I1：NPC 文本列宽度闸（POST 侧 + PATCH 侧，4 列各钉两端） ────
  it('POST 文本列超宽 ⇒ 400 且点名该列与上限（不截断）；恰好上限放行 —— 判据自带字面量', async () => {
    const P = await mkProd('width-post');
    for (const [field, label, max] of NPC_TEXT_WIDTH_MAXES) {
      // 恰好 N 个字符 ⇒ 放行，且**原样落库**（不截断）
      const okId = `${TAG}-c-w-post-${field}`;
      const ok = await adminWenlvRoute.request(`/products/${P}/npcs`, {
        method: 'POST', headers: H, body: JSON.stringify(NPC({ id: okId, [field]: 'x'.repeat(max) })),
      });
      expect(ok.status, `POST ${field} = 恰好 ${max} 个字符应放行`).toBe(200);
      // N+1 ⇒ 400（不是 500）+ 文案点名该列与上限
      const badId = `${TAG}-c-w-post-${field}-bad`;
      const bad = await adminWenlvRoute.request(`/products/${P}/npcs`, {
        method: 'POST', headers: H, body: JSON.stringify(NPC({ id: badId, [field]: 'x'.repeat(max + 1) })),
      });
      expect(bad.status, `POST ${field} = ${max + 1} 个字符应 400（不是 500）`).toBe(400);
      expect((await bad.json()).error, `POST ${field} 的文案应点名该列与上限`)
        .toBe(`${label}超长（最多 ${max} 字符）`);
      // 承重：只断状态码的话，「先插入再报错」的实现也会绿 ⇒ 断该行**没建出来**、且恰好 N 的那行**在**
      const list = (await (await adminWenlvRoute.request(`/products/${P}/npcs`, { headers: H })).json()).data;
      expect(list.map((r: any) => r.id), `POST ${field} 超宽时不应落库`).not.toContain(badId);
      expect(list.find((r: any) => r.id === okId)?.[field], `POST ${field} 恰好 ${max} 应原样落库（不截断）`)
        .toBe('x'.repeat(max));
    }
  });

  it('PATCH 文本列超宽 ⇒ 400 且点名该列与上限（原值不动）；恰好上限 ⇒ 200 且原样落库', async () => {
    const P = await mkProd('width-patch');
    const id = `${TAG}-c-w-patch`;
    // 种子：四列都给**互不相同、且非 null** 的原值 —— 若原值是 null，下面「原值不动」的
    // 两边会一起是 null 而看不见改写（与 characters 的 `width2` 用例同款理由）。
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H,
      body: JSON.stringify(NPC({
        id, name: '原名', role: '原定位',
        portraitUrl: 'https://oss.test/orig.png', voiceId: 'orig-voice',
      })),
    });
    const [before] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    for (const [field, label, max] of NPC_TEXT_WIDTH_MAXES) {
      // 承重①：PATCH N+1 ⇒ 400 + **逐字文案**，四列**逐个**钉住。
      //   ⚠️ 只钉 name 时，把 `voiceId` 从实现的键表里摘掉是**静默**的 ——
      //   四列各自一条，任一行漏接线都必须能红。
      const bad = await adminWenlvRoute.request(`/npcs/${id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ [field]: 'x'.repeat(max + 1) }),
      });
      expect(bad.status, `PATCH ${field} = ${max + 1} 应 400（不是 500）`).toBe(400);
      expect((await bad.json()).error, `PATCH ${field} 的文案应点名该列与上限`)
        .toBe(`${label}超长（最多 ${max} 字符）`);
      // 被拒的 PATCH 不得改动该列（挡的是「先写库再报错」的实现形状）。
      const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
      expect((after as any)[field], `PATCH ${field} 超宽被拒后原值不应被改写`).toBe((before as any)[field]);
    }
    // 承重②：恰好上限 ⇒ 200 且**原样落库**（不截断）—— 四列逐个。
    for (const [field, , max] of NPC_TEXT_WIDTH_MAXES) {
      const okPatch = await adminWenlvRoute.request(`/npcs/${id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ [field]: 'x'.repeat(max) }),
      });
      expect(okPatch.status, `PATCH ${field} = 恰好 ${max} 应 200`).toBe(200);
      expect((await okPatch.json()).data[field], `PATCH ${field} 恰好 ${max} 应原样落库（不截断）`)
        .toBe('x'.repeat(max));
    }
  });

  // ─── I2：PATCH 侧 R-N3 cross-ref 正负判据 ──────────────────────
  it('I2 正判据：PATCH 挂一个属于本 product 的 characterId ⇒ 200', async () => {
    const P = await mkProd('patch-char-ok');
    const id = `${TAG}-c-patch-char-ok`;
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id })),
    });
    const [char] = await db.insert(pmsBuiWenlvCharacters).values({
      id: `${TAG}-char-patch-ok`, productId: P,
      name: '可挂角色', faction: '清流党', identity: '隐士',
      vitality: 60, wisdom: 80, insight: 70,
    }).returning();
    const res = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ characterId: char.id }),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.characterId).toBe(char.id);
  });

  it('I2 负判据：PATCH 挂一个属于别家 product 的 characterId ⇒ 400 且原值不动', async () => {
    const P = await mkProd('patch-char-cross');
    const POther = await mkProd('patch-char-other');
    const id = `${TAG}-c-patch-char-cross`;
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id })),
    });
    // 在「另一个产品」下建 character，让本产品的 NPC PATCH 引用它（跨产品脏引用）
    const [otherChar] = await db.insert(pmsBuiWenlvCharacters).values({
      id: `${TAG}-char-patch-other`, productId: POther,
      name: '别家角色', faction: '清流党', identity: '隐士',
      vitality: 60, wisdom: 80, insight: 70,
    }).returning();
    const res = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ characterId: otherChar.id }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('角色不存在或不属于该剧本');
    // 承重：必须断原 characterId 还在（null）—— 只断 400 的话，「先写脏值再报错」的实现也会绿
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.characterId).toBeNull();
  });

  // ─── I3：形状闸 + order 非法值 + PATCH 侧 lines id 重复 ──────────
  it('I3 POST lines 非数组形状闸（lines: "oops"）⇒ 400 且不落库', async () => {
    const P = await mkProd('post-lines-shape');
    const res = await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id: `${TAG}-c-plshape`, lines: 'oops' as unknown })),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('NPC 台词格式不正确');
    // 承重：只断 400 的话，「先插入再报错」的实现也会绿 ⇒ 必须断该行没建出来
    const rows = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.productId, P));
    expect(rows).toHaveLength(0);
  });

  it('I3 PATCH lines 非数组形状闸（lines: "oops"）⇒ 400 且原 lines 不动', async () => {
    const P = await mkProd('patch-lines-shape');
    const id = `${TAG}-c-patch-lshape`;
    const orig = [{ id: 'l1', text: '原台词', voiceUrl: null }];
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id, lines: orig })),
    });
    const bad = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ lines: 'oops' as unknown }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('NPC 台词格式不正确');
    // 承重：必须断原 lines 还在 —— 只断 400 的话，「先洗成 [] 再报错」的实现也会绿
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.lines).toEqual(orig);
  });

  it('I3 PATCH order 非法值（"abc"）⇒ 400 且原值不动', async () => {
    const P = await mkProd('patch-order-bad');
    const id = `${TAG}-c-patch-order-bad`;
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id, order: 7 })),
    });
    const bad = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ order: 'abc' }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('排序号必须是整数');
    // 承重：必须断原值还在 —— 只断 400 的话，「先写 0 再报错」的实现也会绿
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.orderId).toBe(7);
  });

  it('I3 PATCH lines id 重复 ⇒ 400 且原 lines 不动（与 POST 侧同口径）', async () => {
    const P = await mkProd('patch-lines-dup');
    const id = `${TAG}-c-patch-lines-dup`;
    const orig = [{ id: 'l1', text: '原台词', voiceUrl: null }];
    await adminWenlvRoute.request(`/products/${P}/npcs`, {
      method: 'POST', headers: H, body: JSON.stringify(NPC({ id, lines: orig })),
    });
    const bad = await adminWenlvRoute.request(`/npcs/${id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ lines: [
        { id: 'a', text: '甲', voiceUrl: null },
        { id: 'a', text: '乙', voiceUrl: null },  // 同 id
      ] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('NPC 台词 id 不能重复');
    // 承重：必须断原 lines 还在 —— 只断 400 的话，「先洗成新数组再报错」的实现也会绿
    const [after] = await db.select().from(pmsBuiWenlvNpcs).where(eq(pmsBuiWenlvNpcs.id, id)).limit(1);
    expect(after.lines).toEqual(orig);
  });
});
