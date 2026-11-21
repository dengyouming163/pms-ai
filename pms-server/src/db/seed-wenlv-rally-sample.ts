/**
 * 文旅「芦野寻踪·秋」集章（rally）样例内容 seed（pms-server 内容层）
 *
 * 用途：为 S1 集章链（打卡/答题/档位兑换/员工补印）与 scripts/wenlv-rally-e2e.mjs 冒烟
 * 准备一份固定 id、固定结构的集章样例。mode='rally'：无 ending（保非终局，用 reward_tiers 兑奖），
 * 全部按主键 `INSERT ... ON CONFLICT (id) DO UPDATE`（drizzle onConflictDoUpdate）upsert，可重复执行。
 *
 * 运行：cd pms-server && PUBLISH=1 npx tsx --env-file=.env src/db/seed-wenlv-rally-sample.ts
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
  pmsBuiWenlvProducts, pmsBuiWenlvScriptRooms, pmsBuiWenlvChapters, pmsBuiWenlvScenes,
  pmsBuiWenlvCollectibles, pmsBuiWenlvRewardTiers, pmsBuiWenlvRewards,
  pmsBuiWenlvVenues, pmsBuiWenlvVenuePoints,
} from './schema/index.js';
import type { WenlvCondition, WenlvInteraction } from './schema/wenlv.js';
import { loadRuntimeGraph } from '../services/wenlv/script-room.js';

/** 固定 id：内容产品 + 子资源（与 scripts/wenlv-rally-e2e.mjs 对齐） */
const CONTENT_PRODUCT_ID = 'wenlv-rally-sample-001';
const ROOM_ID = 'room-rally-sample-001';
const CHAPTER_ID = 'ch-rally-sample-001';
/** 场地与六个点位：集章的商业承诺是「到场才能盖章」，故每个发章节点都绑定一个带码点位 */
const VENUE_ID = 'wenlv-rally-sample-venue';
/** 六枚印章可收集物 id（档位 nofM 的 of 全集） */
const STAMP_IDS = ['rs-stamp-1', 'rs-stamp-2', 'rs-stamp-3', 'rs-stamp-4', 'rs-stamp-5', 'rs-stamp-6'];

/** 档位达成条件：收集 STAMP_IDS 中任意 n 枚（nofM 语义由引擎按 state.collected 求值） */
function nofMCond(n: number): WenlvCondition {
  return {
    type: 'nofM', n,
    of: STAMP_IDS.map((id) => ({ type: 'ref', ref: { kind: 'collected', id } } as WenlvCondition)),
  };
}

/** 六个点位（每个发章节点一个，name 与节点标题对应）；code = 现场二维码里原样编码的到场凭证 */
const POINTS: { id: string; name: string; code: string }[] = [
  { id: 'rs-pt-1', name: '秋野识花', code: 'WLP-RS0001' },
  { id: 'rs-pt-2', name: '溪水问答', code: 'WLP-RS0002' },
  { id: 'rs-pt-3', name: '民俗辨踪', code: 'WLP-RS0003' },
  { id: 'rs-pt-4', name: '村口晒秋', code: 'WLP-RS0004' },
  { id: 'rs-pt-5', name: '村口闻声', code: 'WLP-RS0005' },
  { id: 'rs-pt-6', name: '枫香树王', code: 'WLP-RS0006' },
];

/** 场景行（顺序即 order）；venuePointId 指向 POINTS，保证每个发章场景都须到场。
 *  0079 统一模型：场景 type 统一 'narrative'；答题场景以非空 puzzle 列表达
 *  （mini 投影对非空 puzzle 的 narrative 场景仍报 'puzzle'，见 routes/mini/wenlv.ts）。 */
interface SeedScene {
  id: string;
  title: string;
  content: string;
  /** 绑定的物理点位（必填）：集章的发章场景不绑点位即「可远程集章」，发布闸会拦下 */
  venuePointId: string;
  grants: string[];
  puzzle: WenlvInteraction | null;
}
const NODES: SeedScene[] = [
  {
    id: 'rs-p1', title: '秋野识花', venuePointId: 'rs-pt-1',
    content: '田埂边立着一块科普牌，请选出芦野秋天田野里会盛开的野花颜色。',
    grants: ['rs-stamp-1'],
    puzzle: { type: 'multiple', question: '芦野秋天盛开的野花颜色组合是？', options: ['金', '红', '蓝'], answer: ['金', '红'] },
  },
  {
    id: 'rs-p2', title: '溪水问答', venuePointId: 'rs-pt-2',
    content: '石桥下溪水潺潺，守桥人打趣问你一句关于溪水的秋日常识。',
    grants: ['rs-stamp-2'],
    puzzle: { type: 'judge', question: '芦野的溪水在秋季是枯水期。', answer: 'false' },
  },
  {
    id: 'rs-p3', title: '民俗辨踪', venuePointId: 'rs-pt-3',
    content: '村文化墙前，阿婆请你指出芦野世代相传的特色民俗。',
    grants: ['rs-stamp-3'],
    puzzle: { type: 'single', question: '以下哪项是芦野特色民俗？', options: ['板凳龙', '舞狮'], answer: '板凳龙' },
  },
  {
    id: 'rs-s1', title: '村口晒秋', venuePointId: 'rs-pt-4',
    content: '谷场铺满金黄的稻谷与红辣椒，晒秋正当时。到此打卡，得「村口晒秋」章。',
    grants: ['rs-stamp-4'],
    puzzle: null,
  },
  {
    id: 'rs-p4', title: '村口闻声', venuePointId: 'rs-pt-5',
    content: '闭上眼，向导让你猜猜走进芦野村口时，最先听见的是什么声音。',
    grants: ['rs-stamp-5'],
    puzzle: { type: 'input', question: '走进芦野村口你会先听到？', answer: '溪声' },
  },
  {
    id: 'rs-s2', title: '枫香树王', venuePointId: 'rs-pt-6',
    content: '千年枫香树下，满地落叶如红毯。到此打卡，得「枫香树王」章。',
    grants: ['rs-stamp-6'],
    puzzle: null,
  },
];

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
  console.log(`🌱 文旅集章样例 seed（内容层）开始，产品：${CONTENT_PRODUCT_ID}（mode=rally）`);

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

  // 1) 内容产品头（集章模式）
  await db.insert(pmsBuiWenlvProducts).values({
    id: CONTENT_PRODUCT_ID,
    merchantId: 'default',
    name: '芦野寻踪·秋（样例）',
    subtitle: '芦野村秋日集章体验（固定样例，用于集章 E2E 冒烟）',
    coverImage: null,
    status,
    mode: 'rally',
    venueId: VENUE_ID,
    theme: { primaryColor: '#B5651D', font: '楷体', mascotIp: '芦野向导' },
    config: { checkinRule: '到点位打卡/答对谜题集章', collectRule: '集齐对应印数即可在兑奖台兑换秋日好礼' },
    validDays: 30,
    publishedVersion,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvProducts.id,
    set: {
      merchantId: 'default', name: '芦野寻踪·秋（样例）',
      subtitle: '芦野村秋日集章体验（固定样例，用于集章 E2E 冒烟）',
      coverImage: null, status, mode: 'rally', venueId: VENUE_ID,
      theme: { primaryColor: '#B5651D', font: '楷体', mascotIp: '芦野向导' },
      config: { checkinRule: '到点位打卡/答对谜题集章', collectRule: '集齐对应印数即可在兑奖台兑换秋日好礼' },
      validDays: 30,
      publishedVersion, updatedAt: new Date(),
    },
  });
  console.log(`  产品 ${CONTENT_PRODUCT_ID} → ${status}（mode=rally，publishedVersion=${publishedVersion}）`);

  // 1.2) 剧本房（mode=rally，contentId 关联产品）+ 章节
  await db.insert(pmsBuiWenlvScriptRooms).values({
    id: ROOM_ID, contentId: CONTENT_PRODUCT_ID, name: '芦野寻踪·剧本房',
    intro: '芦野村秋日集章体验样例剧本房', mode: 'rally', difficulty: 'normal',
  }).onConflictDoUpdate({
    target: pmsBuiWenlvScriptRooms.id,
    set: { contentId: CONTENT_PRODUCT_ID, name: '芦野寻踪·剧本房', intro: '芦野村秋日集章体验样例剧本房', mode: 'rally', updatedAt: new Date() },
  });
  console.log(`  剧本房 ${ROOM_ID} 就绪`);
  await db.insert(pmsBuiWenlvChapters).values({
    id: CHAPTER_ID, scriptRoomId: ROOM_ID, title: '第一章·芦野寻秋', order: 0,
  }).onConflictDoUpdate({
    target: pmsBuiWenlvChapters.id,
    set: { scriptRoomId: ROOM_ID, title: '第一章·芦野寻秋', order: 0, updatedAt: new Date() },
  });
  console.log(`  章节 ${CHAPTER_ID} 就绪`);

  // 1.5) 场地 + 六个带码点位：集章的商业承诺是「到场才能盖章」。
  // 每个发章节点都绑定一个点位，游客必须现场扫该点位的码才能触发。
  await db.insert(pmsBuiWenlvVenues).values({
    id: VENUE_ID, name: '芦野村集章场地', city: '黔南',
    remark: '集章样例场地：六个点位各贴一张二维码，码值即 POINTS.code',
  }).onConflictDoUpdate({
    target: pmsBuiWenlvVenues.id,
    set: { name: '芦野村集章场地', city: '黔南', updatedAt: new Date() },
  });
  console.log(`  场地 ${VENUE_ID}（芦野村集章场地）就绪`);
  for (const p of POINTS) {
    await db.insert(pmsBuiWenlvVenuePoints).values({
      id: p.id, venueId: VENUE_ID, name: p.name, code: p.code, triggerType: 'qrcode',
    }).onConflictDoUpdate({
      target: pmsBuiWenlvVenuePoints.id,
      set: { venueId: VENUE_ID, name: p.name, code: p.code, triggerType: 'qrcode', updatedAt: new Date() },
    });
    console.log(`  点位 ${p.id}（${p.name}，code=${p.code}）就绪`);
  }

  // 2) 六枚印章 collectible（type=stamp，带盖章视觉元数据）
  const STAMPS: { id: string; name: string; shape: string; color: string; icon: string; description: string }[] = [
    { id: 'rs-stamp-1', name: '金穗野花', shape: 'circle', color: '#E6A23C', icon: 'flower', description: '田埂边盛开的金红野花。' },
    { id: 'rs-stamp-2', name: '秋溪清波', shape: 'rect', color: '#5C9CE6', icon: 'wave', description: '桥下秋溪仍潺潺流淌。' },
    { id: 'rs-stamp-3', name: '板凳龙纹', shape: 'triangle', color: '#C0392B', icon: 'dragon', description: '夜幕下翻腾的板凳龙。' },
    { id: 'rs-stamp-4', name: '村口晒秋', shape: 'circle', color: '#D9822B', icon: 'sun', description: '谷场晒秋的金色场景。' },
    { id: 'rs-stamp-5', name: '溪声回响', shape: 'rect', color: '#2E9E6B', icon: 'sound', description: '村口最先入耳的溪水声。' },
    { id: 'rs-stamp-6', name: '枫香树王', shape: 'circle', color: '#B5651D', icon: 'tree', description: '千年枫香树下的红毯落叶。' },
  ];
  for (const s of STAMPS) {
    await db.insert(pmsBuiWenlvCollectibles).values({
      id: s.id, productId: CONTENT_PRODUCT_ID, name: s.name,
      type: 'stamp', rarity: 'common', image: null,
      stampMeta: { shape: s.shape, color: s.color, icon: s.icon },
      description: s.description,
    }).onConflictDoUpdate({
      target: pmsBuiWenlvCollectibles.id,
      set: {
        productId: CONTENT_PRODUCT_ID, name: s.name, type: 'stamp', rarity: 'common', image: null,
        stampMeta: { shape: s.shape, color: s.color, icon: s.icon },
        description: s.description, updatedAt: new Date(),
      },
    });
    console.log(`  印章 ${s.id}（${s.name}）就绪`);
  }

  // 3) 发章场景（每个都绑定一个带码点位；到场判定靠 venuePointId，requires null，order 递增 1..6）
  for (let i = 0; i < NODES.length; i++) {
    const n = NODES[i];
    const order = i + 1;
    await db.insert(pmsBuiWenlvScenes).values({
      id: n.id, chapterId: CHAPTER_ID, type: 'narrative',
      title: n.title, content: n.content, venuePointId: n.venuePointId,
      requires: null, grants: n.grants, puzzle: n.puzzle, order,
    }).onConflictDoUpdate({
      target: pmsBuiWenlvScenes.id,
      set: {
        chapterId: CHAPTER_ID, type: 'narrative', title: n.title, content: n.content,
        venuePointId: n.venuePointId,
        requires: null, grants: n.grants, puzzle: n.puzzle, order,
        updatedAt: new Date(),
      },
    });
    // puzzle 非空即答题场景（统一存 narrative，靠 puzzle 列区分）
    console.log(`  场景 ${n.id}（narrative${n.puzzle ? '+puzzle' : ''}：${n.title} → 点位 ${n.venuePointId}）就绪`);
  }

  // 4) 奖励 rs-reward-1..3（digital/coupon/merchant_rights 各一档）
  const REWARDS: { id: string; name: string; type: string; value: string | null; description: string }[] = [
    { id: 'rs-reward-1', name: '芦野秋日电子纪念徽章', type: 'digital', value: 'digital-badge', description: '集 2 印即可领取的电子纪念徽章。' },
    { id: 'rs-reward-2', name: '邻水茶室 9 折券', type: 'coupon', value: '9折', description: '集 4 印兑换：村口邻水茶室消费 9 折。' },
    { id: 'rs-reward-3', name: '芦野掌柜贵宾权益', type: 'merchant_rights', value: 'rights', description: '集齐 6 印：芦野村民宿掌柜专属贵宾权益。' },
  ];
  for (const r of REWARDS) {
    await db.insert(pmsBuiWenlvRewards).values({
      id: r.id, productId: CONTENT_PRODUCT_ID, name: r.name,
      type: r.type, merchantId: null, storeId: null, value: r.value, description: r.description,
    }).onConflictDoUpdate({
      target: pmsBuiWenlvRewards.id,
      set: {
        productId: CONTENT_PRODUCT_ID, name: r.name, type: r.type,
        merchantId: null, storeId: null, value: r.value, description: r.description,
      },
    });
    console.log(`  奖励 ${r.id}（${r.name}）就绪`);
  }

  // 5) 档位 rs-tier-1/2/3（nofM n=2/4/6 over rs-stamp-1..6）
  const TIERS: { id: string; name: string; n: number; rewardId: string }[] = [
    { id: 'rs-tier-1', name: '两枚印', n: 2, rewardId: 'rs-reward-1' },
    { id: 'rs-tier-2', name: '四枚印', n: 4, rewardId: 'rs-reward-2' },
    { id: 'rs-tier-3', name: '集齐六印', n: 6, rewardId: 'rs-reward-3' },
  ];
  for (let i = 0; i < TIERS.length; i++) {
    const t = TIERS[i];
    const order = i + 1;
    await db.insert(pmsBuiWenlvRewardTiers).values({
      id: t.id, productId: CONTENT_PRODUCT_ID, name: t.name,
      description: `集齐任意 ${t.n} 枚芦野印章可领取`,
      order, condition: nofMCond(t.n), rewardId: t.rewardId,
    }).onConflictDoUpdate({
      target: pmsBuiWenlvRewardTiers.id,
      set: {
        productId: CONTENT_PRODUCT_ID, name: t.name,
        description: `集齐任意 ${t.n} 枚芦野印章可领取`,
        order, condition: nofMCond(t.n), rewardId: t.rewardId, updatedAt: new Date(),
      },
    });
    console.log(`  档位 ${t.id}（${t.name}，nofM n=${t.n}）就绪`);
  }

  // 6) 自检（P0 便利，不阻塞）：调纯函数完整性校验并打印错误（若有）
  try {
    const [product] = await db.select().from(pmsBuiWenlvProducts)
      .where(eq(pmsBuiWenlvProducts.id, CONTENT_PRODUCT_ID)).limit(1);
    // 0079：nodes/endings 从规范图投影取（scenes→nodes/endings）。
    const runtime = await loadRuntimeGraph(CONTENT_PRODUCT_ID);
    const [collectibles, rewards, tiers, points] = await Promise.all([
      db.select().from(pmsBuiWenlvCollectibles).where(eq(pmsBuiWenlvCollectibles.productId, CONTENT_PRODUCT_ID)),
      db.select().from(pmsBuiWenlvRewards).where(eq(pmsBuiWenlvRewards.productId, CONTENT_PRODUCT_ID)),
      db.select().from(pmsBuiWenlvRewardTiers).where(eq(pmsBuiWenlvRewardTiers.productId, CONTENT_PRODUCT_ID)),
      // 传 points 才会连同「点位存在/有码/属于本场地」一起自检（省略 = 不校验点位引用）
      db.select().from(pmsBuiWenlvVenuePoints).where(eq(pmsBuiWenlvVenuePoints.venueId, VENUE_ID)),
    ]);
    const { validateWenlvIntegrity } = await import('../services/wenlv-integrity.js');
    const errs = validateWenlvIntegrity({
      product, nodes: runtime.nodes, collectibles, endings: runtime.endings, rewards, tiers, points,
    });
    if (errs.length > 0) {
      console.error('⚠️ 集章内容自检未通过：');
      for (const e of errs) console.error('  - ' + e);
    } else {
      console.log('✅ 集章内容完整性自检通过（无 ending / 档位/印章/点位齐全 / 谜题可判定）');
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn(`⚠️ 集章内容自检跳过（${msg}）`);
  }

  console.log('✅ 文旅集章样例 seed（内容层）完成');
}

if (isEntry) {
  main().then(() => process.exit(0)).catch((e) => {
    console.error('❌ 文旅集章样例 seed（内容层）失败：', e instanceof Error ? e.message : e);
    process.exit(1);
  });
}
