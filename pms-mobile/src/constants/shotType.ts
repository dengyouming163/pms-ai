// 拍摄类型（shotType）英文 → 中文显示映射
// 对应系统默认模板（scripts/seed-asset-templates.ts 的 17 个点位 SOP + 兼容保留 public）
export const SHOT_TYPE_LABELS: Record<string, string> = {
  full_view: '房间全景',
  bathroom: '卫浴细节',
  bedding: '床品特写',
  window: '窗景',
  // 旧版兼容保留：seed 已不产出该点位，仅供存量资产显示
  public: '公共区域',
  surrounding: '周边环境',
  food: '美食',
  event: '活动纪实',
  entrance: '门头招牌',
  courtyard: '庭院全景',
  lobby: '接待大厅',
  garden: '花园露台',
  dining: '餐厅茶歇',
  facility: '配套设施',
  breakfast: '早餐下午茶',
  housekeeping: '客房整理',
  transfer: '停车接送',
  amenity: '洗护软装',
}

/** 拍摄类型英文 → 中文显示；未映射的类型返回原值（兼容店长自定义类型） */
export function shotTypeLabel(type?: string | null): string {
  return (type && SHOT_TYPE_LABELS[type]) || type || ''
}
