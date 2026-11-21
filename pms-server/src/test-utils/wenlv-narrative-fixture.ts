/**
 * 文旅 narrative 夹具 —— 块 D「走场模拟」全部判据的**硬前置**。
 *
 * ## 为什么必须有它
 * 本地开发库（`pms-pg-sop` / `aipms`）实测：`pms_bui_wenlv_endings` **0 行**、
 * 且唯一的产品是 `mode='rally'`。也就是说本地**没有任何 narrative 数据**。
 * 于是任何形状为「模拟器报出结局可达 / 报出某节点不可达」的判据在本地
 * **会无声恒绿**（`plan-run-lines-default-to-silent-skip` 那一类缺陷：判据看起来在跑，
 * 实际什么都没测）。本文件造的就是那份能让判据真正有区分力的数据。
 *
 * ## 三个夹具的分工（对应模拟器相对静态闸的三条判据）
 * | 夹具 | 静态闸 `validateWenlvIntegrity` | 模拟器 | 用途 |
 * |---|---|---|---|
 * | `fixtureLinear`      | 绿 | 全可达、结局可达 | 正例：证明判据不是恒红 |
 * | `fixtureBrokenChain` | **红**（n2 无人 complete） | n3 不可达 | 反例 A：两侧应当**一致** |
 * | `fixtureCycle`       | **绿**（两个 id 都在 completableIds 里） | 0 可达 | 反例 B：**模拟器的全部增量价值** |
 *
 * 静态闸只问「有没有任意节点会写它」（`wenlv-integrity.ts` 的 `grantableIds` / `completableIds`），
 * **不问那个写它的节点自己可不可达** —— 互相依赖的环因此能让发布闸全绿而玩家一步走不动。
 * 第三条夹具就是这条缺口的可执行证明，顺序不能反：
 * 必须**先断言静态闸为空**、再断言模拟器报错，否则证明不了「增量价值」。
 *
 * ⚠️ **红线：这些夹具只喂本地库测试与纯函数，禁止指向生产 / 远程库。**
 * 见 `assertLoopbackPgHost()` —— 它不是注释，是运行时硬闸。
 */

import { eq, or, inArray } from 'drizzle-orm';
import type { WenlvCondition } from '../db/schema/wenlv.js';
import {
  pmsBuiWenlvEvents,
  pmsBuiWenlvFlows,
  pmsBuiWenlvChapters,
  pmsBuiWenlvScriptRooms,
  pmsBuiWenlvProducts,
  pmsBuiWenlvProgress,
  pmsBuiWenlvScenes,
} from '../db/schema/wenlv.js';

// ────────────────────────────── 纯数据构造器（不碰库） ──────────────────────────────

export interface FixtureNode {
  id: string;
  nodeType: 'scene' | 'puzzle';
  title: string;
  requires: WenlvCondition | null;
  grants: string[];
}

export interface FixtureEnding {
  id: string;
  title: string;
  triggerCondition: WenlvCondition;
  /**
   * 结局解析优先级（数值大者胜；平手按 id 字典序，小的赢）。
   * **省略 = 不写这一列**，让 DB 默认值（0）生效 —— 既有夹具一个都不传，
   * 行为逐字不变。`selectEnding` 的排序契约见 `services/wenlv-engine.ts:128-145`。
   */
  priority?: number;
}

export interface NarrativeFixture {
  nodes: FixtureNode[];
  endings: FixtureEnding[];
}

/**
 * 条件叶子构造器。
 *
 * ⚠️ **判别式字段是 `type` 不是 `kind`**：`WenlvCondition` 外层用 `type`
 * （`ref` / `all` / `any` / `nofM`），只有叶子 `WenlvCondRef` 用 `kind`
 * （`visited` / `collected` / `completed`）。见 `db/schema/wenlv.ts:45-50`。
 * 引擎全程**无 `not` / `xor`** —— 表达力就这么窄，模拟器不必实现更多。
 */
export function ref(kind: 'visited' | 'collected' | 'completed', id: string): WenlvCondition {
  return { type: 'ref', ref: { kind, id } };
}

/** 正例：三个 scene 串成链，到访即标记 visited。三个都能走到，结局可达。 */
export function fixtureLinear(p: string): NarrativeFixture {
  return {
    nodes: [
      { id: `${p}-n1`, nodeType: 'scene', title: '第一幕',
        requires: null, grants: [] },
      { id: `${p}-n2`, nodeType: 'scene', title: '第二幕',
        requires: ref('visited', `${p}-n1`), grants: [] },
      { id: `${p}-n3`, nodeType: 'scene', title: '第三幕',
        requires: ref('visited', `${p}-n2`), grants: [] },
    ],
    endings: [{ id: `${p}-e1`, title: '通关', triggerCondition: ref('visited', `${p}-n3`) }],
  };
}

/**
 * 反例 A：n1 本应发放 `brk-key` 却没发 ⇒ n2（要 `brk-key`）不可达，n3（要 n2 发的 `brk-pass`）随之不可达。
 * **静态闸也抓得到**（`grantableIds` 里没有该线索）—— 用它证明两侧结论一致。
 */
export function fixtureBrokenChain(p: string): NarrativeFixture {
  const f = fixtureLinear(p);
  // n1 不发 brk-key（断在源头）
  f.nodes[0].grants = [];
  // n2 要一条 n1 没发的线索
  f.nodes[1].requires = ref('collected', `${p}-key`);
  f.nodes[1].grants = [`${p}-pass`];
  // n3 要 n2 发的 pass —— 但 n2 自己不可达，pass 永远不发
  f.nodes[2].requires = ref('collected', `${p}-pass`);
  return f;
}

/**
 * 反例 B：互相依赖的环。双方 `requires` 都要求对方先到访 ⇒ 动态**一步走不动**。
 * grants 为空 ⇒ 静态闸**全绿**（无悬空引用）；
 * 这条是模拟器相对静态闸的**全部增量价值**，必须成为可执行断言。
 */
export function fixtureCycle(p: string): NarrativeFixture {
  return {
    nodes: [
      { id: `${p}-a`, nodeType: 'scene', title: '甲',
        requires: ref('visited', `${p}-b`), grants: [] },
      { id: `${p}-b`, nodeType: 'scene', title: '乙',
        requires: ref('visited', `${p}-a`), grants: [] },
    ],
    endings: [{ id: `${p}-e9`, title: '永远到不了', triggerCondition: ref('visited', `${p}-a`) }],
  };
}

/**
 * 升级阶梯：**两档结局先后脚满足**，中间隔一次触发 —— 专为「`endingId` 只升不降」造。
 *
 * ⚠️ 为什么必须新造夹具：既有三个夹具**每产品恰好 1 个结局**，一旦满足就再没有更高档，
 * 升级路径构造上走不到。（`wenlv-simulate-parity.test.ts` 里那条「首次盖章」用例断言
 * `ending_id` **不变** —— 改完守卫后它照样绿，**零判别力**，不能拿它当验收。）
 *
 * 形态（刻意复刻线上受害剧本 `WENLV_1790582980` 的致病结构）：
 * - `n1` 发放 `c1` 并 self-complete ⇒ 第 1 关一过，**低档 `e-low` 就满足了**；
 * - `n2` 发放 `c2` 并 self-complete ⇒ 第 2 关再满足**高档 `e-high`**（要求 `c1 ∧ c2`）。
 *
 * 线上那本的入口关发放的线索恰好等于最低档结局的条件，而结局一落库就被冻死 ⇒
 * 游客过完第 1 关就永久停在最低档、后面的档位结构上不可达。本夹具的 `e-low`
 * 就是那一档：`priority` 0 对 5，且条件真的是「入口关发的那条线索」。
 */
export function fixtureUpgradeLadder(p: string): NarrativeFixture {
  return {
    nodes: [
      { id: `${p}-n1`, nodeType: 'scene', title: '第一幕',
        requires: null,
        grants: [`${p}-c1`] },
      { id: `${p}-n2`, nodeType: 'scene', title: '第二幕',
        requires: ref('visited', `${p}-n1`),
        grants: [`${p}-c2`] },
    ],
    endings: [
      { id: `${p}-e-low`, title: '过客', priority: 0,
        triggerCondition: ref('collected', `${p}-c1`) },
      { id: `${p}-e-high`, title: '真相', priority: 5,
        triggerCondition: { type: 'all', conditions: [ref('collected', `${p}-c1`), ref('collected', `${p}-c2`)] } },
    ],
  };
}

// ────────────────────────────── 落库 helper（仅测试用） ──────────────────────────────

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost', '']);

/**
 * 运行时红线（不是注释）：夹具的落库路径会 `DELETE` 同名 productId 的全部行，
 * 打在生产 / 远程库上就是**真实数据丢失**。本仓库存在一个指向生产库的
 * `vitest.db.config.ts`（`PG_HOST=132.232.166.40`，明令禁用），与本文件只差一个
 * `--config` 参数 —— 所以这里用**加载即抛错**兜底，而不是指望调用方读到上面的注释。
 *
 * 本机开发库请用 `--config vitest.local.config.ts`（该配置自身也有 `assertLoopback` 硬闸）。
 * `PG_HOST` 为空时不在这里拦截：`db/index.ts` 的 `required('PG_HOST')` 会先抛出更明确的错。
 */
function assertLoopbackPgHost(): void {
  const host = process.env.PG_HOST ?? '';
  if (LOOPBACK_HOSTS.has(host)) return;
  throw new Error(
    `narrative 夹具拒绝连接非回环 PG（PG_HOST=${host}）：它会 DELETE 同名 productId 的全部行，` +
      '指向生产 / 远程库将造成真实数据丢失。本地库测试请用 vitest.local.config.ts（PG_HOST=127.0.0.1）。',
  );
}

/** 子 → 父删除。无外键，顺序只是习惯，但保持与既有测试的清理约定一致。
 *  0079 统一模型：nodes/endings 合并为 scenes；flows 连 scenes；chapters→script_rooms。 */
async function removeRows(db: any, productId: string): Promise<void> {
  const roomIds = (await db.select({ id: pmsBuiWenlvScriptRooms.id })
    .from(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.contentId, productId)))
    .map((r: any) => r.id);
  const chapterIds = roomIds.length
    ? (await db.select({ id: pmsBuiWenlvChapters.id }).from(pmsBuiWenlvChapters)
        .where(eq(pmsBuiWenlvChapters.scriptRoomId, roomIds[0])))
        .map((r: any) => r.id)
    : [];
  await db.delete(pmsBuiWenlvProgress).where(eq(pmsBuiWenlvProgress.productId, productId));
  await db.delete(pmsBuiWenlvEvents).where(eq(pmsBuiWenlvEvents.productId, productId));
  if (chapterIds.length) {
    // 先删 flow（fromSceneId/toSceneId 指向 scenes），再删 scenes
    const sceneIds = (await db.select({ id: pmsBuiWenlvScenes.id }).from(pmsBuiWenlvScenes)
      .where(eq(pmsBuiWenlvScenes.chapterId, chapterIds[0])))
      .map((r: any) => r.id);
    if (sceneIds.length) {
      await db.delete(pmsBuiWenlvFlows).where(or(
        inArray(pmsBuiWenlvFlows.fromSceneId, sceneIds),
        inArray(pmsBuiWenlvFlows.toSceneId, sceneIds),
      ));
    }
    await db.delete(pmsBuiWenlvScenes).where(eq(pmsBuiWenlvScenes.chapterId, chapterIds[0]));
    await db.delete(pmsBuiWenlvChapters).where(eq(pmsBuiWenlvChapters.id, chapterIds[0]));
  }
  for (const rid of roomIds) {
    await db.delete(pmsBuiWenlvScriptRooms).where(eq(pmsBuiWenlvScriptRooms.id, rid));
  }
  await db.delete(pmsBuiWenlvProducts).where(eq(pmsBuiWenlvProducts.id, productId));
}

export interface SeedNarrativeOptions {
  /**
   * 产品状态。**默认 `published`，与 `products.status` 的 schema 默认 `draft` 刻意相反**：
   * `POST /api/mini/wenlv/:id/start` 只服务 `status='published'` 的产品
   * （`routes/mini/wenlv.ts:243-246`，非 published 直接 404「产品不存在或未发布」）。
   * 默认 draft 会让走 HTTP 真实路由的用例**静默 404**，而纯函数用例照旧全绿 ——
   * 正是本仓「判据恒绿」那一类缺陷。需要草稿语义时再显式传 `status: 'draft'`。
   */
  status?: string;
  name?: string;
  /** 默认 `narrative`。集章线请勿用本夹具（它没有 stamp 可收集物与档位，发布闸必红）。 */
  mode?: string;
  /** 默认 `null`。非空时才会触发发布闸的点位归属校验（夹具无 venuePointId，恒 null 即可）。 */
  venueId?: string | null;
}

/**
 * 把夹具落进**本地**库，返回 productId。**仅供本地 DB 测试**。
 *
 * 用 `db.insert` 逐表写；**不写 progress**（那是被测流程自己建的，夹具只铺设内容）。
 * 写入前先清同名残留 ⇒ 崩溃 / 重跑幂等。
 *
 * 只写五张表，列全部按 `db/schema/wenlv.ts` 的实际声明取（0079 统一模型）：
 * - `products`：必填仅 `id` / `name`（`status` / `mode` / `theme` / `config` / `published_version` 均有默认）；
 * - `script_rooms`：`content_id` 关联产品，`mode` 透传；
 * - `chapters`：归属于剧本房；
 * - `scenes`：nodes → type='narrative'/'puzzle'；endings → type='ending'（triggerCondition 列存结局条件）；
 *   `order` 由夹具下标补齐（不参与引擎判定，只定客户端卡片顺序）。
 */
export async function seedNarrativeFixture(
  db: any,
  fixture: NarrativeFixture,
  productId: string,
  opts: SeedNarrativeOptions = {},
): Promise<string> {
  assertLoopbackPgHost();
  const { status = 'published', name, mode = 'narrative', venueId = null } = opts;

  await removeRows(db, productId);

  await db.insert(pmsBuiWenlvProducts).values({
    id: productId,
    name: name ?? `夹具剧本 ${productId}`,
    status,
    mode,
    venueId,
  });

  // 剧本房 + 单章节（夹具不关心分章，全部场景挂在第一章）
  const roomId = `room-${productId}`;
  const chapterId = `ch-${productId}`;
  await db.insert(pmsBuiWenlvScriptRooms).values({
    id: roomId, contentId: productId, name: name ?? `夹具剧本房 ${productId}`, mode,
  });
  await db.insert(pmsBuiWenlvChapters).values({
    id: chapterId, scriptRoomId: roomId, title: '第一章', order: 0,
  });

  if (fixture.nodes.length > 0) {
    await db.insert(pmsBuiWenlvScenes).values(
      fixture.nodes.map((n, i) => ({
        id: n.id,
        chapterId,
        type: n.nodeType === 'puzzle' ? 'puzzle' : 'narrative',
        title: n.title,
        requires: n.requires,
        grants: n.grants,
        puzzle: null,
        order: i,
      })),
    );
  }

  if (fixture.endings.length > 0) {
    await db.insert(pmsBuiWenlvScenes).values(
      fixture.endings.map((e, i) => ({
        id: e.id,
        chapterId,
        type: 'ending',
        title: e.title,
        triggerCondition: e.triggerCondition,
        // 省略 `priority` 时不写这个键，让列默认值 0 生效。
        ...(e.priority === undefined ? {} : { priority: e.priority }),
        order: fixture.nodes.length + i,
      })),
    );
  }

  return productId;
}

/**
 * 清掉某夹具 productId 的全部行（含测试跑出来的 progress / events）。
 * 供 `afterAll` 用 —— 本地库是大家的开发库，别留垃圾。同样受回环硬闸保护。
 */
export async function deleteNarrativeFixture(db: any, productId: string): Promise<void> {
  assertLoopbackPgHost();
  await removeRows(db, productId);
}
