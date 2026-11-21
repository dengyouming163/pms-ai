/** 拍摄要求：每个拍摄类型需达标数量 */
export interface ShotRequirement {
  shotType: string;
  count: number;
  mediaType?: 'image' | 'video';
  name?: string;
  guideText?: string;
  movementText?: string;
  avoidText?: string;
  durationMin?: number;
  durationMax?: number;
  exampleImageUrl?: string;
  exampleVideoUrl?: string;
}

/** 素材元信息（用于判定，仅需 shotType + mediaType） */
export interface AssetMeta {
  shotType?: string | null;
  mediaType?: string | null;
}

/** 判定任务是否完成：每类素材数 ≥ 要求数（按 shotType+mediaType 双键，避免同类型图文互污染） */
export function isTaskCompleted(requirements: ShotRequirement[], assets: AssetMeta[]): boolean {
  if (!requirements || requirements.length === 0) return assets.length > 0;
  return requirements.every((req) => {
    const mt = req.mediaType || 'image';
    const n = assets.filter(a => a.shotType === req.shotType && (a.mediaType || 'image') === mt).length;
    return n >= req.count;
  });
}

/** 从模板列表组装拍摄清单（每模板一条要求，countMap 按模板 id 覆盖默认数量1） */
export function buildShotRequirements(
  templateRefs: string[],
  templates: Array<{ id: string; shotType: string; name: string; mediaType?: string; exampleImageUrl?: string; exampleVideoUrl?: string; guideText?: string; movementText?: string; avoidText?: string; durationMin?: number; durationMax?: number }>,
  countMap: Record<string, number> = {},
): ShotRequirement[] {
  return (templateRefs || []).map((tid) => {
    const t = templates.find(t => t.id === tid);
    return {
      shotType: t?.shotType || tid,
      mediaType: (t?.mediaType as 'image' | 'video') || 'image',
      count: countMap[tid] || 1,
      name: t?.name,
      guideText: t?.guideText,
      movementText: t?.movementText,
      avoidText: t?.avoidText,
      durationMin: t?.durationMin,
      durationMax: t?.durationMax,
      exampleImageUrl: t?.exampleImageUrl,
      exampleVideoUrl: t?.exampleVideoUrl,
    };
  });
}

/** 单个员工统计行 */
export interface StaffStatsRow {
  staffId: string;
  staffName: string;
  status: 'pending' | 'submitted' | 'completed';
  assetCount: number;
}

/** 按员工汇总打卡统计 */
export function computeTaskStats(
  staff: Array<{ id: string; name: string }>,
  submissions: Array<{ staffId: string; status: string; assetIds?: string[] }>,
): StaffStatsRow[] {
  return staff.map((s) => {
    const sub = submissions.find(x => x.staffId === s.id);
    const status = (sub?.status as StaffStatsRow['status']) || 'pending';
    return {
      staffId: s.id,
      staffName: s.name,
      status,
      assetCount: sub?.assetIds?.length || 0,
    };
  });
}
