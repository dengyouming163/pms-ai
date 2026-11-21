/**
 * 文旅「龙门镇·合成验收」样例内容 seed（pms-server 内容层）
 *
 * 0079 统一模型：剧情走 script_rooms/chapters/scenes/flows 四表（节点=scenes，结局=type='ending' 的 scenes，边=flows）。
 *
 * 用途：为 Task 16 的合成验收与 E2E 冒烟准备一份固定 id、固定结构的剧情样例。
 * 固定 contentProductId='wenlv-sample-001'，节点/线索/结局/奖励 id 各带固定前缀，
 * 全部按主键 `INSERT ... ON CONFLICT (id) DO UPDATE`（drizzle onConflictDoUpdate）upsert，可重复执行。
 *
 * 运行：cd pms-server && PUBLISH=1 npx tsx --env-file=.env src/db/seed-wenlv-sample.ts
 *   - PUBLISH 环境变量（或 argv 传 `publish`）置真 → 样例置 published（供 E2E/线上验收直接读取）；
 *   - 不传 PUBLISH 且为全新样例 → 落到低位态 draft；已存在更高位（published/preview）则保持不变，
 *     即重复跑不会把已发布样例打回 draft（同 id upsert 覆盖仍保留发布态，保证幂等）。
 *   - 脚本只应连 .env 指向的本机 dev 库；连接失败会输出中文提示后退出。
 *
 * 安全红线：禁止指向远程/共享/生产库。
 */
import { eq } from 'drizzle-orm';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  pmsBuiWenlvProducts, pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes, pmsBuiWenlvFlows,
  pmsBuiWenlvCollectibles, pmsBuiWenlvRewards,
} from './schema/index.js';
import type { WenlvCondition, WenlvInteraction } from './schema/wenlv.js';

/** 固定 id：内容产品 + 子资源（与 Task 16 平台门票样例 / scripts/wenlv-e2e.mjs 对齐） */
const CONTENT_PRODUCT_ID = 'wenlv-sample-001';
const ROOM_ID = 'room-sample-001';
const CHAPTER_ID = 'ch-sample-001';
const ID_SCENE = 'scene-1';      // 场景节点：村口（入口）
const ID_PUZZLE = 'puzzle-1';    // 携谜题的场景节点（type='narrative' + puzzle 列）：对暗号（答对 grant clue-1）
const ID_FLOW = 'flow-1';        // 流转：村口 → 对暗号
const ID_CLUE = 'clue-1';        // 可收集物：神秘地图
const ID_ENDING = 'end-1';       // 结局场景（type='ending'）：大侠圆满
const ID_REWARD = 'reward-1';    // 奖励：锦囊

/** 是否显式要求发布态（PUBLISH=1/true/yes/publish/on 或 argv 含 publish） */
function wantPublish(): boolean {
  const env = (process.env.PUBLISH || '').toLowerCase();
  if (['1', 'true', 'yes', 'publish', 'on'].includes(env)) return true;
  return process.argv.includes('publish');
}

/** 入口判定：仅当本文件作为脚本执行时才跑 main；作为模块被 import（如 tsx --eval 载入自检）时不连库 */
const isEntry = !!process.argv[1]
  && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;

async function main(): Promise<void> {
  // db/pool 动态引入：把 db/index.ts 里 required(PG_*) 与连接初始化延迟到真正执行时，
  // 便于给出清晰中文报错，也避免静态 import 载入即抛 FATAL。
  const { db, pool } = await import('./index.js');
  console.log(`🌱 文旅样例 seed（内容层·0079 统一模型）开始，产品：${CONTENT_PRODUCT_ID}`);

  try {
    await pool.query('select 1');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`❌ 无法连接 PostgreSQL（${msg}）`);
    console.error('   请确认 .env 指向的本机 dev 库已启动（禁止连远程/共享/生产库）。');
    throw e;
  }

  const [existing] = await db.select()
    .from(pmsBuiWenlvProducts)
    .where(eq(pmsBuiWenlvProducts.id, CONTENT_PRODUCT_ID))
    .limit(1);

  // 幂等状态策略：显式 PUBLISH → published；全新样例无 PUBLISH → draft；
  // 已存在 published/preview 的样例重复跑保持不变（不降级，保证 E2E/验收可重复执行）。
  const forcePublish = wantPublish();
  const status = forcePublish ? 'published' : (existing?.status ?? 'draft');
  const publishedVersion = forcePublish
    ? (existing && existing.status === 'published' ? existing.publishedVersion : (existing?.publishedVersion ?? 0) + 1)
    : (existing?.publishedVersion ?? 0);

  // 1) 内容产品头
  await db.insert(pmsBuiWenlvProducts).values({
    id: CONTENT_PRODUCT_ID,
    merchantId: 'default',
    name: '龙门镇·合成验收',
    subtitle: '武侠剧情体验（占位样例，用于合成验收与 E2E 冒烟）',
    coverImage: null,
    status,
    theme: { primaryColor: '#6B3E26', font: '楷体', mascotIp: '龙门少侠' },
    config: { checkinRule: '抵达村口触发剧情', collectRule: '答对暗号获得线索' },
    validDays: 30,
    publishedVersion,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvProducts.id,
    set: {
      merchantId: 'default', name: '龙门镇·合成验收',
      subtitle: '武侠剧情体验（占位样例，用于合成验收与 E2E 冒烟）',
      coverImage: null, status, theme: { primaryColor: '#6B3E26', font: '楷体', mascotIp: '龙门少侠' },
      config: { checkinRule: '抵达村口触发剧情', collectRule: '答对暗号获得线索' },
      validDays: 30,
      publishedVersion, updatedAt: new Date(),
    },
  });
  console.log(`  产品 ${CONTENT_PRODUCT_ID} → ${status}（publishedVersion=${publishedVersion}）`);

  // 2) 剧本房（contentId 关联产品）
  await db.insert(pmsBuiWenlvScriptRooms).values({
    id: ROOM_ID, contentId: CONTENT_PRODUCT_ID, name: '龙门镇·剧本房',
    intro: '武侠剧情体验样例剧本房', mode: 'standard', difficulty: 'normal',
  }).onConflictDoUpdate({
    target: pmsBuiWenlvScriptRooms.id,
    set: { contentId: CONTENT_PRODUCT_ID, name: '龙门镇·剧本房', intro: '武侠剧情体验样例剧本房', updatedAt: new Date() },
  });
  console.log(`  剧本房 ${ROOM_ID} 就绪`);

  // 3) 章节
  await db.insert(pmsBuiWenlvChapters).values({
    id: CHAPTER_ID, scriptRoomId: ROOM_ID, title: '第一章·龙门风云', order: 0,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvChapters.id,
    set: { scriptRoomId: ROOM_ID, title: '第一章·龙门风云', order: 0, updatedAt: new Date() },
  });
  console.log(`  章节 ${CHAPTER_ID} 就绪`);

  // 4) 场景 scene-1（村口，入口无解锁条件）
  await db.insert(pmsBuiWenlvScenes).values({
    id: ID_SCENE, chapterId: CHAPTER_ID, type: 'narrative',
    title: '村口', content: '青石牌坊下，一位老掌柜正等着有缘人。他压低声音：「龙门镇的风水，都在那句暗号里。」',
    requires: null, grants: [], puzzle: null, order: 1,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvScenes.id,
    set: {
      chapterId: CHAPTER_ID, type: 'narrative', title: '村口',
      content: '青石牌坊下，一位老掌柜正等着有缘人。他压低声音：「龙门镇的风水，都在那句暗号里。」',
      requires: null, grants: [], puzzle: null, order: 1, updatedAt: new Date(),
    },
  });
  console.log(`  场景 ${ID_SCENE} 就绪`);

  // 5) 携谜题的场景 puzzle-1（对暗号：先访问过 scene-1 才解锁；答对 grant clue-1）
  const puzzleUnlock: WenlvCondition = { type: 'ref', ref: { kind: 'visited', id: ID_SCENE } };
  const puzzleQ: WenlvInteraction = {
    type: 'single', question: '天王盖地虎？',
    options: ['宝塔镇河妖', '天王盖地虎'], answer: '宝塔镇河妖',
  };
  await db.insert(pmsBuiWenlvScenes).values({
    id: ID_PUZZLE, chapterId: CHAPTER_ID, type: 'narrative',
    title: '对暗号', content: '老掌柜捻须一笑：「既然到了村口，对得上暗号，我便告诉你地图的下落。」',
    requires: puzzleUnlock, grants: [ID_CLUE], puzzle: puzzleQ, order: 2,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvScenes.id,
    set: {
      chapterId: CHAPTER_ID, type: 'narrative', title: '对暗号',
      content: '老掌柜捻须一笑：「既然到了村口，对得上暗号，我便告诉你地图的下落。」',
      requires: puzzleUnlock, grants: [ID_CLUE], puzzle: puzzleQ, order: 2, updatedAt: new Date(),
    },
  });
  console.log(`  场景 ${ID_PUZZLE} 就绪`);

  // 6) 流转：村口 → 对暗号（auto 边，剧情自然推进）
  await db.insert(pmsBuiWenlvFlows).values({
    id: ID_FLOW, fromSceneId: ID_SCENE, toSceneId: ID_PUZZLE, type: 'auto',
    choiceText: null, condition: null, grants: [], sanDelta: 0, sortOrder: 0,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvFlows.id,
    set: { fromSceneId: ID_SCENE, toSceneId: ID_PUZZLE, type: 'auto', updatedAt: new Date() },
  });
  console.log(`  流转 ${ID_FLOW} 就绪`);

  // 7) 线索 collectible clue-1（神秘地图）
  await db.insert(pmsBuiWenlvCollectibles).values({
    id: ID_CLUE, productId: CONTENT_PRODUCT_ID, name: '神秘地图',
    type: 'clue', rarity: 'rare', image: null,
    description: '从老掌柜手里换来的古镇手绘地图，标注着「龙门镇旧宅」的位置。',
  }).onConflictDoUpdate({
    target: pmsBuiWenlvCollectibles.id,
    set: {
      productId: CONTENT_PRODUCT_ID, name: '神秘地图', type: 'clue', rarity: 'rare', image: null,
      description: '从老掌柜手里换来的古镇手绘地图，标注着「龙门镇旧宅」的位置。', updatedAt: new Date(),
    },
  });
  console.log(`  线索 ${ID_CLUE} 就绪`);

  // 8) 结局场景 end-1（type='ending'：大侠圆满，收集到 clue-1 即触发，领取 reward-1）
  const endingCond: WenlvCondition = { type: 'ref', ref: { kind: 'collected', id: ID_CLUE } };
  await db.insert(pmsBuiWenlvScenes).values({
    id: ID_ENDING, chapterId: CHAPTER_ID, type: 'ending',
    title: '大侠圆满', content: '循着神秘地图推开旧宅大门，你为龙门镇寻回了失传多年的剑谱。江湖路远，侠名长留。',
    triggerCondition: endingCond, image: null, rewardId: ID_REWARD, priority: 0, order: 3,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvScenes.id,
    set: {
      chapterId: CHAPTER_ID, type: 'ending', title: '大侠圆满',
      content: '循着神秘地图推开旧宅大门，你为龙门镇寻回了失传多年的剑谱。江湖路远，侠名长留。',
      triggerCondition: endingCond, image: null, rewardId: ID_REWARD, priority: 0, order: 3, updatedAt: new Date(),
    },
  });
  console.log(`  结局 ${ID_ENDING} 就绪`);

  // 9) 奖励 reward-1（锦囊）
  await db.insert(pmsBuiWenlvRewards).values({
    id: ID_REWARD, productId: CONTENT_PRODUCT_ID, name: '锦囊',
    type: 'coupon', merchantId: null, storeId: null, value: '满100减10',
    description: '闯关圆满的犒赏：任意门店消费满 100 减 10。',
  }).onConflictDoUpdate({
    target: pmsBuiWenlvRewards.id,
    set: {
      productId: CONTENT_PRODUCT_ID, name: '锦囊', type: 'coupon',
      merchantId: null, storeId: null, value: '满100减10',
      description: '闯关圆满的犒赏：任意门店消费满 100 减 10。',
    },
  });
  console.log(`  奖励 ${ID_REWARD} 就绪`);

  console.log('✅ 文旅样例 seed（内容层·0079 统一模型）完成');
}

if (isEntry) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ 文旅样例 seed（内容层）失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
