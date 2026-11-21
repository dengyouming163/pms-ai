import { describe, it, expect, afterAll } from 'vitest';
import adminWenlvRoute from '../wenlv.js';
import { db } from '../../../db/index.js';
import { pmsBuiWenlvProducts, pmsBuiWenlvCharacters, pmsBuiWenlvDesignAssets } from '../../../db/schema/index.js';
import { eq, inArray } from 'drizzle-orm';

// 内部 token 从 vitest.local.config.ts 注入（'test-internal-token'），与 pms-server constants.js 顶层取值一致
// ⚠️ 不用 `|| 'internal-secret-dev'` 兜底：那是个**构造上不可达**的死分支 ——
// `wenlv.js`（上面第 2 行的 import）会经 `src/constants.ts:12` 在**加载期**读同一个变量，
// 缺失时直接抛 `FATAL: INTERNAL_SERVICE_TOKEN 环境变量未设置！`，第 8 行根本执行不到。
const TOKEN = process.env.INTERNAL_SERVICE_TOKEN!;
const H = { 'X-Internal-Service-Token': TOKEN, 'Content-Type': 'application/json' };

/** 每个用例一个**独立产品**：本文件里有「删最后一个被拦」与「删非最后一个成功」这一对，
 *  它们对「库里剩几个角色」敏感。共用一个产品会让用例依赖声明顺序（本仓已有前科：
 *  顺序一变就随机红，且是**跨用例**的隐性耦合）。 */
const TAG = 'char-' + Date.now();
const created: string[] = [];
async function mkProd(suffix: string): Promise<string> {
  const id = `${TAG}-${suffix}`;
  await db.insert(pmsBuiWenlvProducts).values({ id, name: '角色夹具剧本' }).onConflictDoNothing();
  created.push(id);
  return id;
}

/** 角色夹具：只给必填三项 + 三维（三维无 DEFAULT，不给就是 23502 not_null_violation）。 */
const CH = (over: Record<string, unknown> = {}) => ({
  name: '沈砚', faction: '清流党', identity: '隐士',
  vitality: 60, wisdom: 80, insight: 70,
  ...over,
});

/** 六个**有宽度上限**的文本列：`[字段, 中文名, 上限]`。
 *  🔴 上限是**判据自己的字面量**（逐字抄自建表迁移 `drizzle/0042_wenlv_characters.sql:30-36`），
 *     **绝不从实现 import `CHARACTER_TEXT_MAX`** —— 若拿实现的值来算「恰好 N 个字符」，
 *     上限写错时实现与判据会同时偏（同一个值两边一起错）⇒ 该判据**零判别力**。
 *  POST 侧与 PATCH 侧**共用这一份**（同一组值写两份会在后续改动里各漂各的）。 */
const TEXT_WIDTH_MAXES: Array<[string, string, number]> = [
  ['name', '角色名称', 50],
  ['faction', '角色阵营', 50],
  ['identity', '角色身份', 50],
  ['role', '角色定位', 50],
  ['factionColor', '阵营色', 20],
  ['avatarUrl', '头像地址', 500],
];

describe.skipIf(!process.env.RUN_DB)('wenlv 剧本角色 CRUD（P1）', () => {
  afterAll(async () => {
    if (created.length) {
      // design_assets 的清理键是 productId（不是 targetId），且必须先于 characters 删 ——
      // 否则删完角色后这些素材行就成了孤儿（本文件新增了「删角色解绑」用例会造 design_assets 行）。
      await db.delete(pmsBuiWenlvDesignAssets).where(inArray(pmsBuiWenlvDesignAssets.productId, created));
      await db.delete(pmsBuiWenlvCharacters).where(inArray(pmsBuiWenlvCharacters.productId, created));
      await db.delete(pmsBuiWenlvProducts).where(inArray(pmsBuiWenlvProducts.id, created));
    }
  });

  it('POST 建角色：全字段落库，且 0–100 之外的属性被夹回', async () => {
    const P = await mkProd('create');
    const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({
        id: `${TAG}-c1`, order: 2, factionColor: '#4A6FA5', identityDesc: '曾为京官，挂冠而去',
        role: '主角', avatarUrl: 'https://oss.test/a.png', ipPrompt: '水墨风，青衫，侧脸',
        vitality: 140, wisdom: -3,
        skills: [{ id: 'track', label: '追踪', description: '循迹辨向' }],
        hiddenQuest: { title: '旧案', description: '寻到三处旧案线索', collectible_ids: ['x1', 'x1', 'x2'] },
      })),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    expect(row.name).toBe('沈砚');
    expect(row.faction).toBe('清流党');
    expect(row.identity).toBe('隐士');
    expect(row.vitality).toBe(100);   // 140 → 100（形态闸）
    expect(row.wisdom).toBe(0);       // -3  → 0
    expect(row.insight).toBe(70);
    expect(row.skills).toEqual([{ id: 'track', label: '追踪', description: '循迹辨向' }]);
    // collectible_ids 去重（'x1' 出现两次）
    expect(row.hiddenQuest.collectible_ids).toEqual(['x1', 'x2']);
  });

  it('POST 幂等重入：同 id 再 POST 返回**同一行**，且不被第二次 body 改写', async () => {
    const P = await mkProd('idem');
    const id = `${TAG}-c-idem`;
    const first = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, name: '首名' })),
    });
    expect((await first.json()).data.name).toBe('首名');
    const second = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, name: '二名' })),
    });
    expect(second.status).toBe(200);
    // 承重：只断言 200 的话，「先删后插」的实现也会绿 —— 必须断言**第二次的 body 没生效**
    expect((await second.json()).data.name).toBe('首名');
    const rows = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id));
    expect(rows).toHaveLength(1);
  });

  it('POST 缺必填（name/faction/identity）⇒ 400，且一行都不落库', async () => {
    const P = await mkProd('req');
    for (const k of ['name', 'faction', 'identity']) {
      const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
        method: 'POST', headers: H, body: JSON.stringify(CH({ [k]: '   ' })),
      });
      expect(res.status, `${k} 空值应 400`).toBe(400);
    }
    // 承重：只断言状态码的话，「先插入再报错」的实现也会绿
    const rows = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P));
    expect(rows).toHaveLength(0);
  });

  it('POST 到不存在的产品 ⇒ 404', async () => {
    const res = await adminWenlvRoute.request(`/products/${TAG}-no-such/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH()),
    });
    expect(res.status).toBe(404);
    // 承重：本条的 404 现在来自 handler 分支（路径模式能匹配）。body 断言防的是**路由被删/改名**
    // 这类回归 —— Hono 对未匹配路由也回 404（鉴权中间件放行后；不带 token 是先 403），但 body 是**纯文本**（`res.json()` 会直接抛）。文案取自 getProductOr404。
    const body = await res.json();
    expect(body.error).toBe('内容产品不存在');
  });

  it('PATCH 改标量并过形态闸：越界夹回、空 id 的 skill 被丢弃、必需列不许清空', async () => {
    const P = await mkProd('patch');
    const id = `${TAG}-c-patch`;
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id })),
    });
    const res = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({
        order: 5, factionColor: '#B23A48',
        insight: 999,
        skills: [{ id: 'a', label: 'A', description: '' }, { id: '  ', label: '无名', description: '' }],
      }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    expect(row.order).toBe(5);
    expect(row.insight).toBe(100);
    expect(row.skills).toEqual([{ id: 'a', label: 'A', description: '' }]); // 空 id 那条被丢
    // 必需列清空 ⇒ 400，且原值不动
    const bad = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ name: '' }),
    });
    expect(bad.status).toBe(400);
    const [after] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
    expect(after.name).toBe('沈砚');
  });

  it('PATCH 不存在的角色 ⇒ 404', async () => {
    const res = await adminWenlvRoute.request(`/characters/${TAG}-ghost`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ order: 1 }),
    });
    expect(res.status).toBe(404);
    // 承重：同上 —— 断 body 文案才能把「handler 的 JSON 404」与「路由未匹配的纯文本 404」区分开
    const body = await res.json();
    expect(body.error).toBe('角色不存在');
  });

  it('GET 列表按 order 升序', async () => {
    const P = await mkProd('list');
    for (const [i, o] of [[3, 3], [1, 1], [2, 2]] as const) {
      await adminWenlvRoute.request(`/products/${P}/characters`, {
        method: 'POST', headers: H, body: JSON.stringify(CH({ id: `${TAG}-c-l${i}`, name: `角色${i}`, order: o })),
      });
    }
    const res = await adminWenlvRoute.request(`/products/${P}/characters`, { headers: H });
    const list = (await res.json()).data;
    expect(list.map((r: any) => r.order)).toEqual([1, 2, 3]);
  });

  it('DELETE 最后一个角色 ⇒ 400，且**行还在**（承重：不能先删再报错）', async () => {
    const P = await mkProd('last');
    const id = `${TAG}-c-last`;
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id })),
    });
    const res = await adminWenlvRoute.request(`/characters/${id}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(400);
    const rows = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id));
    expect(rows, '删到 0 被拦时必须原样保留').toHaveLength(1);
  });

  it('DELETE 非最后一个 ⇒ 200，且**只**删掉那一个', async () => {
    const P = await mkProd('del');
    const a = `${TAG}-c-da`, b = `${TAG}-c-db`;
    for (const id of [a, b]) {
      await adminWenlvRoute.request(`/products/${P}/characters`, {
        method: 'POST', headers: H, body: JSON.stringify(CH({ id })),
      });
    }
    const res = await adminWenlvRoute.request(`/characters/${a}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(200);
    const rest = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.productId, P));
    expect(rest.map((r) => r.id)).toEqual([b]);
  });

  it('DELETE 不存在的角色 ⇒ 404', async () => {
    const res = await adminWenlvRoute.request(`/characters/${TAG}-ghost`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(404);
    // 承重：同上 —— 断 body 文案才能把「handler 的 JSON 404」与「路由未匹配的纯文本 404」区分开
    const body = await res.json();
    expect(body.error).toBe('角色不存在');
  });

  it('PATCH order 非整数 / 越界 ⇒ 400，且**原值不动**（不能是 500）', async () => {
    const P = await mkProd('order');
    const id = `${TAG}-c-order`;
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, order: 7 })),
    });
    // `null` / `''` / `[]` / `false` 是**输入形态**非法但 `Number()` 结果为 0 的那一族 ——
    // 只按 `Number(v)` 的结果判会把这四个**显式非法值**伪装成合法整数 0（实测曾把 order 从 7 静默改成 0）。
    // 下面的「原值不动」断言就是为这一族准备的。
    for (const bad of ['abc', 1.7, 1e20, null, '', [], false]) {
      const res = await adminWenlvRoute.request(`/characters/${id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ order: bad }),
      });
      expect(res.status, `order=${String(bad)} 应 400（不是 500）`).toBe(400);
    }
    // 承重：只断言状态码的话，「先写 0 再报错」的实现也会绿 —— 必须断言原值没被改写
    const [after] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
    expect(after.order).toBe(7);
  });

  it('POST order 非法值落 0（创建面宽松），不是 500', async () => {
    const P = await mkProd('order-post');
    // 与 PATCH 面同一批输入、**相反**的期望（这里落 0，PATCH 面 400）——
    // 两条用例合起来才钉住「宽松只在创建面」：只留一边的话，把两边统一成一种口径也会绿。
    // ⚠️ 判据盲区（如实记录）：下面 7 条**只**断言落库值为 0，而 0 恰好就是列默认值
    // `"order" integer NOT NULL DEFAULT 0`（0042.sql）—— 于是「把 POST 的 order 入参整个忽略掉」
    // 这 7 条断言照样全绿 ⇒ 本用例对「入参被忽略」**零信号**。（实测：删掉 POST 的
    // `order: normalizeOrder(body.order, 0)` 后本用例仍全绿。）
    // 真正承住「入参没被忽略」的是下面那条正向用例 `order: ' 7 ' ⇒ 7`：同一变异会让它红
    // （同批红的还有 GET 排序、PATCH 越界两条）。
    const bads = ['abc', 1.7, 1e20, null, '', [], false];
    for (let i = 0; i < bads.length; i++) {
      const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
        method: 'POST', headers: H, body: JSON.stringify(CH({ id: `${TAG}-co${i}`, order: bads[i] })),
      });
      expect(res.status, `order=${String(bads[i])} 应 200`).toBe(200);
      expect((await res.json()).data.order).toBe(0);
    }
  });

  it('PATCH 文本列与 POST 同口径：同一份输入、同一组期望，两个端点各断一次', async () => {
    const P = await mkProd('norm');
    const id = `${TAG}-c-norm`;
    const blank = {
      name: '  沈砚  ', faction: ' 清流党 ', identity: ' 隐士 ',
      factionColor: '   ', role: '   ', avatarUrl: '   ', identityDesc: '   ', ipPrompt: '   ',
    };
    // 同一组期望值断言两次 —— **POST 侧必须也断**：只断 PATCH 的响应时，POST 的归一坏了
    // 这条用例照样绿（`blank` 覆盖全部 8 键、PATCH 会把它们全部覆写 ⇒ 结构上看不见 POST）。
    const expectSame = (row: Record<string, unknown>) => {
      expect(row.name).toBe('沈砚');
      expect(row.faction).toBe('清流党');
      expect(row.identity).toBe('隐士');
      expect(row.factionColor).toBeNull();
      expect(row.role).toBeNull();
      expect(row.avatarUrl).toBeNull();
      expect(row.identityDesc).toBeNull();
      expect(row.ipPrompt).toBeNull();
    };
    const post = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify({ ...blank, id }),
    });
    expect(post.status).toBe(200);
    expectSame((await post.json()).data);
    const res = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify(blank),
    });
    expect(res.status).toBe(200);
    expectSame((await res.json()).data);
  });

  it('长文本列**不 trim**：前后空白与换行原样保留（POST 与 PATCH 同口径）', async () => {
    const P = await mkProd('longtxt');
    const id = `${TAG}-c-long`;
    // ⚠️ 刻意用**跨行模板字面量**表达换行（首行即空行 ⇒ desc 以换行符开头，这正是判据的承重处）。
    const desc = `
  第一行
第二行`;
    const prompt = '  ${角色名} 站在雨里  ';
    const post = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, identityDesc: desc, ipPrompt: prompt })),
    });
    expect(post.status).toBe(200);
    expect((await post.json()).data.identityDesc).toBe(desc);
    const res = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ identityDesc: desc, ipPrompt: prompt }),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    expect(row.identityDesc).toBe(desc);
    expect(row.ipPrompt).toBe(prompt);
  });

  it('GET /products/:id/full 带上 characters（创作台一次 load 拿全）', async () => {
    const P = await mkProd('full');
    const id = `${TAG}-c-full`;
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, name: '全量角色' })),
    });
    // 第二个产品 + 它的角色：只做**跨产品负判据**用
    const P2 = await mkProd('full-other');
    const otherId = `${TAG}-c-full-other`;
    await adminWenlvRoute.request(`/products/${P2}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id: otherId, name: '别家角色' })),
    });
    const res = await adminWenlvRoute.request(`/products/${P}/full`, { headers: H });
    expect(res.status).toBe(200);
    const data = (await res.json()).data;
    // ⚠️ 这一条被下面 `expect(...).toEqual([id])` **逻辑蕴含**（`toEqual` 已要求它是真数组）
    // ⇒ 不可能独立为红。保留它是**意图声明**（「这个字段必须是数组」），不表示它有独立判别力。
    expect(Array.isArray(data.characters)).toBe(true);
    // 承重：原来只有 `Array.isArray` + `toContain(id)` ⇒ 把投影的 `where` 换成**恒真**
    // （跨剧本泄漏**全部**角色）照样全绿 —— 而同一型变异在 `GET /products/:id/characters`
    // （上面的「按 order 升序」用例）上会红，说明判别力差在本条自身的断言强度上。
    // 恰好相等钉住「过滤键没被放宽」，负判据钉住「没多带别人的行」，两条都要。
    expect(data.characters.map((c: any) => c.id)).toEqual([id]);
    // ⚠️ 承重的是**上一行的 `toEqual`**；这一条是**意图声明**（把「跨剧本泄漏」写进断言里），
    // 被 `toEqual([id])` 逻辑蕴含、**不可能独立失败** —— 下一个人不要误以为它有独立判别力。
    expect(data.characters.map((c: any) => c.id)).not.toContain(otherId);
  });

  it('三维属性闸：显式非法值（null / "" / []）落 50 中立值（不是 0），数字字符串仍被接受', async () => {
    const P = await mkProd('attr');
    const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({ id: `${TAG}-c-attr1`, vitality: null, wisdom: '', insight: [] })),
    });
    expect(res.status).toBe(200);
    const row = (await res.json()).data;
    // 承重：`Number(null)` / `Number('')` / `Number([])` **全是 0** —— 按 `Number(v)` 的结果判会落 0，
    // 端面属性条宽度归零，与注释承诺的「中立值 50」不符。三条各断一次，任一条走回落 `Number()` 都会被抓到。
    expect(row.vitality).toBe(50);
    expect(row.wisdom).toBe(50);
    expect(row.insight).toBe(50);
    // 反向：可解析的数字字符串仍必须被接受 —— 防「把字符串分支整个删掉」的过头修法
    const ok = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({ id: `${TAG}-c-attr2`, vitality: '80' })),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.vitality).toBe(80);
  });

  it('order 的数字字符串（含前后空白）仍被接受 —— 形态闸只拒非法形状，不拒可解析字符串', async () => {
    const P = await mkProd('order-str');
    const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id: `${TAG}-c-orderstr`, order: ' 7 ' })),
    });
    expect(res.status).toBe(200);
    expect((await res.json()).data.order).toBe(7);
  });

  it('PATCH skills 形状错（字符串）⇒ 400，且该角色**原有技能一条都不少**（数据丢失路径）', async () => {
    const P = await mkProd('skills');
    const id = `${TAG}-c-skills`;
    const skills = [{ id: 'track', label: '追踪', description: '循迹辨向' }];
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, skills })),
    });
    const res = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ skills: 'oops' }),
    });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe('技能格式不正确');
    // 承重：只断状态码的话，「先把 skills 洗成 [] 再报错」的实现也会绿 ⇒ 必须断**落库值没被改写**。
    // 这正是未加形状闸时的实测行为：`PATCH {"skills":"oops"}` 把原有技能整批静默清成 []。
    const [after] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
    expect(after.skills).toEqual(skills);
    // 清空只有一条路径：显式 null（不是「形状错」）
    const cleared = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ skills: null }),
    });
    expect(cleared.status).toBe(200);
    expect((await cleared.json()).data.skills).toEqual([]);
  });

  it('PATCH hiddenQuest 数组 ⇒ 400（形状非法）；只有 null 才是清空', async () => {
    const P = await mkProd('hq');
    const id = `${TAG}-c-hq`;
    const hq = { title: '旧案', description: '寻三处旧案线索', collectible_ids: ['x1'] };
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, hiddenQuest: hq })),
    });
    const bad = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ hiddenQuest: [] }),
    });
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toBe('隐秘任务格式不正确');
    // 承重：必须断原值还在 —— 只断 400 的话，「先把该列写脏 / 写空再报错」的实现也会绿。
    // （注：`[]` 在形状闸被去掉后**也不会**再落「真值空卡」—— `normalizeHiddenQuest` 的空壳判定
    //   会把它落成 `null`。所以这条闸的理由是「**形状非法**应当报错」，不是「防真值空卡」；
    //   两条闸分工见 wenlv.ts 里 POST 段与 normalizeHiddenQuest 的注释。）
    const [mid] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
    expect(mid.hiddenQuest).toEqual(hq);
    // 清空只有 `null` 一条路径（`null` 不是「形状错」，必须放行）
    const ok = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ hiddenQuest: null }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.hiddenQuest).toBeNull();
  });

  it('POST 侧两个 jsonb 形状闸：形状错 ⇒ 400，且**该行一行都不落库**；null 是清空、必须放行', async () => {
    const P = await mkProd('post-shape');
    // ⚠️ 覆盖缺口（规格关实测）：把 POST 段那两个形状闸**整块删掉**，本文件全部判据曾**全绿** ——
    // 因为此前没有任何 POST 用例把 `skills` / `hiddenQuest` 传成「非 null 且形状非法」。
    // 同型变异在 PATCH 侧会红 ⇒ 规则「两处都要」此前只是**实现上一致**，不是**可回归的约束**。
    const bads: Array<[string, Record<string, unknown>, string]> = [
      ['skills', { skills: 'oops' }, '技能格式不正确'],
      ['hiddenQuest', { hiddenQuest: [] }, '隐秘任务格式不正确'],
    ];
    for (const [label, extra, err] of bads) {
      const id = `${TAG}-c-postbad-${label}`;
      const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
        method: 'POST', headers: H, body: JSON.stringify(CH({ id, ...extra })),
      });
      expect(res.status, `POST ${label} 形状错应 400`).toBe(400);
      expect((await res.json()).error).toBe(err);
      // 承重：只断 400 的话，「先插入再报错 / 先洗成空集」的实现也会绿 ⇒ 必须断**该行确实没建出来**。
      // 闸在 `const id = …` 与 insert 之前，所以断言的是「整条 POST 没有落库」这一行为，而不只是状态码。
      const list = (await (await adminWenlvRoute.request(`/products/${P}/characters`, { headers: H })).json()).data;
      expect(list.map((r: any) => r.id), `POST ${label} 形状错时不应落库`).not.toContain(id);
    }
    // 正对照（防「把闸写成一律拒绝」）：`null` **不是**形状错 —— 必须 200，且落「清空」形态
    const okId = `${TAG}-c-postok`;
    const ok = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({ id: okId, skills: null, hiddenQuest: null })),
    });
    expect(ok.status, 'POST null 是清空、不是形状错').toBe(200);
    const okRow = (await ok.json()).data;
    expect(okRow.skills).toEqual([]);
    expect(okRow.hiddenQuest).toBeNull();
  });

  it('hiddenQuest 空壳（洗形后三字段皆空）⇒ 落 null，不是真值空卡；判空才 trim、落库不 trim', async () => {
    const P = await mkProd('hq-shell');
    const id = `${TAG}-c-hq-shell`;
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id })),
    });
    // 三条空壳入口各断一次：`{}` / 纯空白 title / 空 collectible_ids
    const shells: Array<[string, Record<string, unknown>]> = [
      ['{}', {}],
      ['{"title":"   "}', { title: '   ' }],
      ['{"collectible_ids":[]}', { collectible_ids: [] }],
    ];
    for (const [label, shell] of shells) {
      const res = await adminWenlvRoute.request(`/characters/${id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ hiddenQuest: shell }),
      });
      expect(res.status, `hiddenQuest=${label} 应 200（空壳不是形状非法）`).toBe(200);
      // 承重：这三条原样落库会是一张**真值**空对象 `{title:'',description:'',collectible_ids:[]}`，
      // 端面据此渲染一张空卡；而本列可选、`null` 才是「没有隐秘任务」。
      // 必须断**落库值**（不只断 200）：空壳判定与形状闸是两回事，后者对这三条都会放行。
      expect((await res.json()).data.hiddenQuest, `hiddenQuest=${label} 响应应落 null`).toBeNull();
      const [row] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
      expect(row.hiddenQuest, `hiddenQuest=${label} 落库应为 null`).toBeNull();
    }
    // 正例：只要有一样有实质内容就正常落库（不是「一律落 null」）
    const ok = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H,
      body: JSON.stringify({ hiddenQuest: { title: '找玉佩', collectible_ids: ['  x1  ', 'x1'] } }),
    });
    expect(ok.status).toBe(200);
    expect((await ok.json()).data.hiddenQuest).toEqual({ title: '找玉佩', description: '', collectible_ids: ['x1'] });
    // 反向：判空用的 trim **不得**渗进落库值 —— 带前后空白的 title 必须原样保留
    // （只断上一条的话，「判空顺手把 title 也 trim 了」的实现照样绿，因为上一条的 title 没有空白）
    const padded = await adminWenlvRoute.request(`/characters/${id}`, {
      method: 'PATCH', headers: H, body: JSON.stringify({ hiddenQuest: { title: '  找玉佩  ' } }),
    });
    expect(padded.status).toBe(200);
    expect((await padded.json()).data.hiddenQuest)
      .toEqual({ title: '  找玉佩  ', description: '', collectible_ids: [] });
  });

  it('POST hiddenQuest 空壳（{}）⇒ 200 且该列落 null（与 PATCH 同一条口径）', async () => {
    const P = await mkProd('hq-shell-post');
    const id = `${TAG}-c-hq-shell-post`;
    const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id, hiddenQuest: {} })),
    });
    expect(res.status).toBe(200);
    // 承重：同 PATCH —— POST 与 PATCH 共用同一个 normalizeHiddenQuest，两边各断一次，
    // 防「只在一个入口洗空壳」的实现。
    expect((await res.json()).data.hiddenQuest).toBeNull();
    const [row] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
    expect(row.hiddenQuest).toBeNull();
  });

  it('collectible_ids 洗形：trim + 丢纯空白 + 去重 + 丢非字符串', async () => {
    const P = await mkProd('ids');
    const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({
        id: `${TAG}-c-ids`,
        hiddenQuest: { title: 't', description: 'd', collectible_ids: ['  ', 'x1', ' x1 ', '', 123] },
      })),
    });
    expect(res.status).toBe(200);
    // 承重：原夹具里**从来没有**空白/空 id（全是 'x1'/'x2' 这种干净值）⇒ `!!x.trim()` 与 `!!x`
    // 结果完全相同（变异实测：把 `!!x.trim()` 改成 `!!x`，15 条用例当时全绿）。
    // 这一条同时压四个分支：纯空白丢、首尾空白 trim、重复去重、非字符串丢。
    expect((await res.json()).data.hiddenQuest.collectible_ids).toEqual(['x1']);
  });

  it('文本列超宽 ⇒ 400 且点名该列与上限（不截断）；恰好上限放行 —— 判据自带字面量', async () => {
    const P = await mkProd('width');
    // 六列逐个钉住两端，不是只钉 `name`：任何一列漏接线都要能红。
    // （上限表 `TEXT_WIDTH_MAXES` 在文件级 —— POST / PATCH 两处共用，理由见其定义处。）
    for (const [field, label, max] of TEXT_WIDTH_MAXES) {
      // 恰好 N 个字符 ⇒ 放行，且**原样落库**（不截断）
      const okId = `${TAG}-c-w-${field}`;
      const ok = await adminWenlvRoute.request(`/products/${P}/characters`, {
        method: 'POST', headers: H, body: JSON.stringify(CH({ id: okId, [field]: 'x'.repeat(max) })),
      });
      expect(ok.status, `${field} = 恰好 ${max} 个字符应放行`).toBe(200);
      // N+1 ⇒ 400（不是 500）+ 文案点名该列与上限
      const badId = `${TAG}-c-w-${field}-bad`;
      const bad = await adminWenlvRoute.request(`/products/${P}/characters`, {
        method: 'POST', headers: H, body: JSON.stringify(CH({ id: badId, [field]: 'x'.repeat(max + 1) })),
      });
      expect(bad.status, `${field} = ${max + 1} 个字符应 400（不是 500）`).toBe(400);
      expect((await bad.json()).error, `${field} 的文案应点名该列与上限`)
        .toBe(`${label}超长（最多 ${max} 字符）`);
      // 承重：只断状态码的话，「先插入再报错」的实现也会绿 ⇒ 断该行**没建出来**、且恰好 N 的那行**在**
      const list = (await (await adminWenlvRoute.request(`/products/${P}/characters`, { headers: H })).json()).data;
      expect(list.map((r: any) => r.id), `${field} 超宽时不应落库`).not.toContain(badId);
      expect(list.find((r: any) => r.id === okId)?.[field], `${field} 恰好 ${max} 应原样落库（不截断）`)
        .toBe('x'.repeat(max));
    }
  });

  it('宽度闸在 PATCH 侧同样接线（N+1 ⇒ 400 且原值不动 / 恰好上限 ⇒ 200）；POST 的 id 超宽 ⇒ 400', async () => {
    const P = await mkProd('width2');
    const id = `${TAG}-c-w2`;
    // 种子：六列都给**互不相同、且非 null** 的原值 —— 若原值是 null，下面「原值不动」的
    // 两边会一起是 null 而看不见改写。
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({
        id, name: '原名', faction: '原阵营', identity: '原身份',
        role: '原定位', factionColor: '#000000', avatarUrl: 'https://oss.test/orig.png',
      })),
    });
    // 承重①：PATCH N+1 ⇒ 400 + **逐字文案**，六列**逐个**钉住。
    //   ⚠️ 只钉 name/factionColor 时，把某一列（如 `avatarUrl`）从实现 `wenlv.ts:2136` 的键表里摘掉
    //   是**静默**的 —— **实测**该列既不写也不判宽，PATCH 直接 **200**、入参被悄悄丢掉
    //   （读数是 `expected 200 to be 400`）；旧的两列判据对此**全绿**。
    //   （另一种坏形状是键表保留、只摘掉宽度判定 ⇒ 超宽**真**写进 PG ⇒ `22001` ⇒ 500。）
    //   六列各自一条，任一行漏接线都必须能红。
    const [before] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
    for (const [field, label, max] of TEXT_WIDTH_MAXES) {
      const bad = await adminWenlvRoute.request(`/characters/${id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ [field]: 'x'.repeat(max + 1) }),
      });
      expect(bad.status, `PATCH ${field} = ${max + 1} 应 400（不是 500）`).toBe(400);
      expect((await bad.json()).error, `PATCH ${field} 的文案应点名该列与上限`)
        .toBe(`${label}超长（最多 ${max} 字符）`);
      // 被拒的 PATCH 不得改动该列。它挡的是「**先写库再报错**」的实现形状。
      //   注意它**不是**由宽度判定承重的：对当前实现改宽度逻辑无法让它红（400 返回在唯一那处
      //   `db.update`（wenlv.ts:2160）**之前**，`patch` 只是局部对象、够不到库）。
      //   已实测：把实现改成「在 400 分支里先写一次库」能让它红 ——
      //   读数 `PATCH name 超宽被拒后原值不应被改写: expected 'xxxx…' to be '原名'`。
      const [after] = await db.select().from(pmsBuiWenlvCharacters).where(eq(pmsBuiWenlvCharacters.id, id)).limit(1);
      expect((after as any)[field], `PATCH ${field} 超宽被拒后原值不应被改写`).toBe((before as any)[field]);
    }
    // 承重②：恰好上限 ⇒ 200 且**原样落库**（不截断）—— 六列逐个。
    for (const [field, , max] of TEXT_WIDTH_MAXES) {
      const okPatch = await adminWenlvRoute.request(`/characters/${id}`, {
        method: 'PATCH', headers: H, body: JSON.stringify({ [field]: 'x'.repeat(max) }),
      });
      expect(okPatch.status, `PATCH ${field} = 恰好 ${max} 应 200`).toBe(200);
      expect((await okPatch.json()).data[field], `PATCH ${field} 恰好 ${max} 应原样落库（不截断）`)
        .toBe('x'.repeat(max));
    }
    // `id` 是 PK、varchar(50)：51 字符 ⇒ 400（不是 500），50 字符 ⇒ 放行
    const longId = 'x'.repeat(51);
    const idRes = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id: longId })),
    });
    expect(idRes.status, 'id = 51 个字符应 400（不是 500）').toBe(400);
    expect((await idRes.json()).error).toBe('角色 id 超长（最多 50 字符）');
    const id50 = 'z'.repeat(50);
    const idOk = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id: id50 })),
    });
    expect(idOk.status, 'id = 恰好 50 个字符应放行').toBe(200);
    expect((await idOk.json()).data.id).toBe(id50);
  });

  it('宽度按**码点**计，不是 UTF-16 码元：20 个 emoji 恰在 factionColor 上限内 ⇒ 放行', async () => {
    const P = await mkProd('codepoint');
    const emoji = '😀'.repeat(20);          // factionColor 上限 = 20（varchar(20) 数的是**字符**）
    // 前置自证：夹具必须真的是「20 个码点、40 个码元」——否则这条对 `.length` 零判别力
    expect([...emoji].length).toBe(20);
    expect(emoji.length).toBe(40);
    const res = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({ id: `${TAG}-c-emoji`, factionColor: emoji })),
    });
    // 用 `s.length` 的实现会把 20 个 emoji 数成 40 ⇒ 这里 400（假红）
    expect(res.status, '20 个码点 = PG 眼里的 20 个字符 ⇒ 必须放行').toBe(200);
    // 反向：21 个码点仍要 400（说明放行不是因为闸被整段绕过）
    const bad = await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H,
      body: JSON.stringify(CH({ id: `${TAG}-c-emoji-bad`, factionColor: '😀'.repeat(21) })),
    });
    expect(bad.status, '21 个码点应 400').toBe(400);
    expect((await bad.json()).error).toBe('阵营色超长（最多 20 字符）');
  });

  it('删角色后解绑其素材坐标（不删素材行），且两个诱饵不受影响', async () => {
    // 🔴 结构照 wenlv.test.ts 的「删图鉴条目后…」双诱饵用例：两条诱饵分别钉住
    //    `unbindAssetsOf` 的 `targetId` 条件与 `targetKind` 条件（掉任一条件都会解绑错行）。
    //    ⚠️ 与 plan 块的差异（有意）：plan 让诱饵①绑在「另一个角色」上、再先删那个角色 ——
    //    但删那个角色会**当场解绑诱饵①**（它也是 character kind），且删完只剩 1 个角色、
    //    目标角色的 DELETE 会撞「至少保留 1 个」400。故诱饵①改绑一个**不删**的守门角色 KEEPER。
    const P = await mkProd('unbind');
    const id = `${TAG}-c-unbind`;
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id })),
    });
    // 该角色的素材行（type 取 character_avatar，targetKind 取 character）
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: `${TAG}-asset-own`, type: 'character_avatar', name: '自有素材', url: 'https://oss.test/a.png',
      productId: P, targetKind: 'character', targetId: id,
    });
    // 诱饵①：**同 kind 别的 targetId**（一个**不删**的角色 —— 若实现漏了 targetId 条件，会被一起解绑）
    const KEEPER = `${TAG}-c-keeper`;
    await adminWenlvRoute.request(`/products/${P}/characters`, {
      method: 'POST', headers: H, body: JSON.stringify(CH({ id: KEEPER })),
    });
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: `${TAG}-asset-decoy1`, type: 'character_avatar', name: '诱饵A', url: 'https://oss.test/b.png',
      productId: P, targetKind: 'character', targetId: KEEPER,
    });
    // 诱饵②：**同 targetId 别的 kind**（若实现漏了 kind 条件，会被一起解绑）
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: `${TAG}-asset-decoy2`, type: 'collectible', name: '诱饵B', url: 'https://oss.test/c.png',
      productId: P, targetKind: 'collectible', targetId: id,
    });
    // 删目标角色（KEEPER 仍在 ⇒ 不撞「至少保留 1 个」400）
    const res = await adminWenlvRoute.request(`/characters/${id}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(200);
    const rows = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(inArray(pmsBuiWenlvDesignAssets.id, [`${TAG}-asset-own`, `${TAG}-asset-decoy1`, `${TAG}-asset-decoy2`]));
    const byId = new Map(rows.map((r) => [r.id, r]));
    const own = byId.get(`${TAG}-asset-own`)!;
    expect(own, '自己的素材行应还在').toBeTruthy();       // **不删素材行**
    expect(own.targetKind, '自己的素材应被解绑').toBeNull();
    expect(own.targetId).toBeNull();
    expect(own.url, 'url 保留，仍可复用').toBe('https://oss.test/a.png');
    // 诱饵原样不动 —— 这两条才是 WHERE 两个条件的真正判据
    expect(byId.get(`${TAG}-asset-decoy1`)!.targetKind, '同 kind 别的 targetId 不得被解绑').toBe('character');
    expect(byId.get(`${TAG}-asset-decoy1`)!.targetId).toBe(KEEPER);
    expect(byId.get(`${TAG}-asset-decoy2`)!.targetKind, '同 targetId 别的 kind 不得被解绑').toBe('collectible');
    expect(byId.get(`${TAG}-asset-decoy2`)!.targetId).toBe(id);
  });

  it('删不存在的角色 ⇒ 404，且解绑不得发生在 404 早返回之前', async () => {
    // 🔴 夹具的素材必须**绑在「那个不存在的 id」上**，才测得出「解绑在 404 之后」。
    //    绑在别的 id 上，解绑写没写在 404 之前，这条素材都不会被动 ⇒ 恒真（假绿）。
    const P = await mkProd('unbind-404');
    const ghost = `${TAG}-ghost-asset`;
    await db.insert(pmsBuiWenlvDesignAssets).values({
      id: `${TAG}-asset-orphan`, type: 'character_avatar', name: '孤儿素材', url: 'https://oss.test/orphan.png',
      productId: P, targetKind: 'character', targetId: ghost,
    });
    const res = await adminWenlvRoute.request(`/characters/${ghost}`, { method: 'DELETE', headers: H });
    expect(res.status).toBe(404);
    const [asset] = await db.select().from(pmsBuiWenlvDesignAssets)
      .where(eq(pmsBuiWenlvDesignAssets.id, `${TAG}-asset-orphan`)).limit(1);
    expect(asset.targetKind, '仍绑着 ⇒ 解绑确实在 404 早返回之后').toBe('character');
    expect(asset.targetId).toBe(ghost);
  });
});
