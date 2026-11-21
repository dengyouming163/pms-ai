// scripts/seed-asset-templates.ts
// 运行：tsx --env-file=.env scripts/seed-asset-templates.ts（独立脚本，无 npm script 别名）
// 为民宿行业写入「点位 SOP 库」（15 点位 × 图/视频双模板 = 30 条）
// 幂等：按 (source='system', shotType, mediaType) 补集更新——存在则刷新 SOP 字段，不存在则插入。
import { db } from '../src/db/index.js';
import { assetTemplates } from '../src/db/schema/index.js';
import { eq, and, notInArray } from 'drizzle-orm';

interface Tmpl {
  shotType: string; mediaType: 'image' | 'video'; name: string; category: string;
  guideText: string; movementText?: string; avoidText?: string;
  durationMin?: number; durationMax?: number; sortOrder: number;
}

const DEFAULTS: Tmpl[] = [
  // ===== 外部环境 =====
  { shotType: 'entrance', mediaType: 'image', name: '门头招牌', category: 'view', guideText: '正对门头完整露出招牌与店名；开灯或白天自然光', avoidText: '招牌被遮挡、逆光发黑、车辆行人乱入', sortOrder: 1 },
  { shotType: 'entrance', mediaType: 'video', name: '门头招牌（视频）', category: 'view', guideText: '门头全景 → 近景招牌', movementText: '「摇」原地从右扫到左 /「推」由街对面走近', avoidText: '不用变焦、避开人流高峰期', durationMin: 5, durationMax: 10, sortOrder: 2 },
  { shotType: 'courtyard', mediaType: 'image', name: '庭院全景', category: 'view', guideText: '院子中央站立横拍，纳入绿植桌椅装饰', avoidText: '装修材料/保洁工具入镜、阴天灰暗', sortOrder: 3 },
  { shotType: 'courtyard', mediaType: 'video', name: '庭院全景（视频）', category: 'view', guideText: '院子全景环视', movementText: '「摇」原地环视一圈 /「移」沿院边走拍', avoidText: '杂物入镜、阴天', durationMin: 5, durationMax: 10, sortOrder: 4 },
  { shotType: 'surrounding', mediaType: 'image', name: '周边环境', category: 'view', guideText: '门口街景、道路、远处地标/打卡位', avoidText: '纯风景网图、无主体', sortOrder: 5 },
  { shotType: 'surrounding', mediaType: 'video', name: '周边环境（视频）', category: 'view', guideText: '带到民宿与周边的关系', movementText: '「移」沿路走拍', avoidText: '纯风景、无主体', durationMin: 5, durationMax: 10, sortOrder: 6 },
  // ===== 公共区域 =====
  { shotType: 'lobby', mediaType: 'image', name: '接待大厅', category: 'view', guideText: '正对前台横拍，带入沙发茶几装饰', avoidText: '人物特写、杂物', sortOrder: 7 },
  { shotType: 'lobby', mediaType: 'video', name: '接待大厅（视频）', category: 'view', guideText: '大厅整体 → 前台', movementText: '「推」门口→前台 /「摇」大厅环视', avoidText: '人物特写、杂物', durationMin: 5, durationMax: 10, sortOrder: 8 },
  { shotType: 'garden', mediaType: 'image', name: '花园露台', category: 'view', guideText: '花园/露台全景，带花木与休闲椅', avoidText: '枯萎植物、杂物', sortOrder: 9 },
  { shotType: 'garden', mediaType: 'video', name: '花园露台（视频）', category: 'view', guideText: '花园/露台环视', movementText: '「移」沿花径走拍 /「摇」露台环视', avoidText: '枯萎植物、杂物', durationMin: 5, durationMax: 10, sortOrder: 10 },
  { shotType: 'dining', mediaType: 'image', name: '餐厅茶歇', category: 'food', guideText: '餐桌摆台/茶歇区全景，暖色调', avoidText: '空盘乱桌、闪光灯直射', sortOrder: 11 },
  { shotType: 'dining', mediaType: 'video', name: '餐厅茶歇（视频）', category: 'food', guideText: '用餐区 → 餐桌特写', movementText: '「推」餐厅门口→餐桌特写 /「摇」用餐区', avoidText: '空盘乱桌、闪光灯', durationMin: 5, durationMax: 10, sortOrder: 12 },
  { shotType: 'facility', mediaType: 'image', name: '配套设施', category: 'view', guideText: '泳池/儿童区/棋牌设施全景，水质清澈', avoidText: '脏乱无人维护、乱入人物', sortOrder: 13 },
  { shotType: 'facility', mediaType: 'video', name: '配套设施（视频）', category: 'view', guideText: '设施区环视', movementText: '「移」沿泳池边拍水面 /「摇」设施区', avoidText: '脏乱、乱入人物', durationMin: 5, durationMax: 10, sortOrder: 14 },
  // ===== 服务过程 =====
  { shotType: 'breakfast', mediaType: 'image', name: '早餐下午茶', category: 'other', guideText: '摆盘完成的早餐/下午茶特写，光线柔和', avoidText: '手挡镜头、餐具杂乱', sortOrder: 15 },
  { shotType: 'breakfast', mediaType: 'video', name: '早餐下午茶（视频）', category: 'other', guideText: '餐桌 → 食物特写（由近到远）', movementText: '「推」桌子全景→食物特写', avoidText: '手挡镜头、餐具杂乱', durationMin: 5, durationMax: 10, sortOrder: 16 },
  { shotType: 'housekeeping', mediaType: 'image', name: '客房整理', category: 'other', guideText: '铺床完成后整体照/细节照', avoidText: '整理中途杂物、人影入镜', sortOrder: 17 },
  { shotType: 'housekeeping', mediaType: 'video', name: '客房整理（视频）', category: 'other', guideText: '记录铺床流程（枕头归位→铺平→盖被）', movementText: '「移」匀速跟随流程', avoidText: '整理中途杂物、人影', durationMin: 5, durationMax: 10, sortOrder: 18 },
  { shotType: 'transfer', mediaType: 'image', name: '停车接送', category: 'other', guideText: '停车位/接驳车/礼宾服务场景', avoidText: '乱停车、隐私', sortOrder: 19 },
  { shotType: 'transfer', mediaType: 'video', name: '停车接送（视频）', category: 'other', guideText: '服务过程记录', movementText: '「移」跟随服务过程 /「摇」停车区', avoidText: '乱停车、隐私', durationMin: 5, durationMax: 10, sortOrder: 20 },
  // ===== 房间细节 =====
  { shotType: 'full_view', mediaType: 'image', name: '房间全景', category: 'room', guideText: '门口中央横拍、开灯、略仰角，完整纳入床窗家具', avoidText: '房内杂物、倾斜超 45°', sortOrder: 21 },
  { shotType: 'full_view', mediaType: 'video', name: '房间全景（视频）', category: 'room', guideText: '房间全景 → 细节（从左到右）', movementText: '「移」门口慢速走入房间 /「摇」环视', avoidText: '房内杂物、倾斜超 45°', durationMin: 5, durationMax: 10, sortOrder: 22 },
  { shotType: 'bedding', mediaType: 'image', name: '床品特写', category: 'room', guideText: '俯拍枕头被褥纹理，光线柔和', avoidText: '褶皱杂乱、阴天', sortOrder: 23 },
  { shotType: 'bedding', mediaType: 'video', name: '床品特写（视频）', category: 'room', guideText: '床整体 → 被褥细节特写', movementText: '「推」床整体→被褥细节', avoidText: '褶皱杂乱、阴天', durationMin: 5, durationMax: 10, sortOrder: 24 },
  { shotType: 'bathroom', mediaType: 'image', name: '卫浴细节', category: 'room', guideText: '对焦洗手台/淋浴区，拍出干净明亮', avoidText: '水渍污渍、暗光', sortOrder: 25 },
  { shotType: 'bathroom', mediaType: 'video', name: '卫浴细节（视频）', category: 'room', guideText: '浴室门口 → 洗手台/浴缸特写', movementText: '「推」浴室门口→洗手台/浴缸', avoidText: '水渍污渍、暗光、水汽', durationMin: 5, durationMax: 10, sortOrder: 26 },
  { shotType: 'window', mediaType: 'image', name: '窗景', category: 'room', guideText: '窗外景色，带窗帘质感', avoidText: '反光、逆光黑窗', sortOrder: 27 },
  { shotType: 'window', mediaType: 'video', name: '窗景（视频）', category: 'room', guideText: '室内窗户 → 窗外景色', movementText: '「摇」从室内窗户缓慢摇向窗外', avoidText: '反光、逆光黑窗', durationMin: 5, durationMax: 10, sortOrder: 28 },
  { shotType: 'amenity', mediaType: 'image', name: '洗护软装', category: 'room', guideText: '洗护用品/茶具/特色摆件特写', avoidText: '无意义小物堆砌', sortOrder: 29 },
  { shotType: 'amenity', mediaType: 'video', name: '洗护软装（视频）', category: 'room', guideText: '洗护套装/茶具细节展示', movementText: '「推」/「移」绕行展示细节', avoidText: '无意义小物堆砌', durationMin: 5, durationMax: 10, sortOrder: 30 },
  // ===== 兼容保留（其他行业） =====
  { shotType: 'food', mediaType: 'image', name: '美食', category: 'food', guideText: '菜品摆盘特写，暖色调', avoidText: '滤镜过重、闪光灯', sortOrder: 31 },
  { shotType: 'event', mediaType: 'image', name: '活动纪实', category: 'other', guideText: '住客活动/特色服务瞬间', avoidText: '未授权人物正面', sortOrder: 32 },
];

/** 补集更新：同 (source,shotType,mediaType) 存在则刷新字段，否则插入 */
async function upsert(t: Tmpl): Promise<void> {
  const [exist] = await db.select({ id: assetTemplates.id }).from(assetTemplates)
    .where(and(
      eq(assetTemplates.source, 'system'),
      eq(assetTemplates.shotType, t.shotType),
      eq(assetTemplates.mediaType, t.mediaType),
    )).limit(1);
  if (exist) {
    await db.update(assetTemplates).set({ ...t, updatedAt: new Date() }).where(eq(assetTemplates.id, exist.id));
  } else {
    await db.insert(assetTemplates).values({
      id: `tmpl_${t.shotType}_${t.mediaType}`, merchantId: 'default', storeId: 'default_store',
      source: 'system', purposeTags: ['短视频剪辑'], ...t,
    } as any);
  }
}

async function main() {
  for (const t of DEFAULTS) await upsert(t);
  // 清理旧版 seed 遗留的孤儿系统模板（shotType 不在新 SOP 库内，如旧 public）
  const validShotTypes = [...new Set(DEFAULTS.map(t => t.shotType))];
  await db.delete(assetTemplates)
    .where(and(
      eq(assetTemplates.source, 'system'),
      notInArray(assetTemplates.shotType, validShotTypes),
    ));
  console.log(`系统模板库同步完成：${DEFAULTS.length} 条点位 SOP`);
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
