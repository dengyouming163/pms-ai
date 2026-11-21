// 场地与点位的领域纯逻辑（无 DB 依赖，可直接单测）。
// 场地状态机的合法流转与盖章规则是 spec §5.1 的唯一实现 —— 路由只做接线，不重复判断。

export const VENUE_STAGES = ['lead', 'surveying', 'deploying', 'pilot', 'live', 'archived'] as const;
export type VenueStage = (typeof VENUE_STAGES)[number];

export function isVenueStage(v: unknown): v is VenueStage {
  return typeof v === 'string' && (VENUE_STAGES as readonly string[]).includes(v);
}

// 邻接表。跳级一律拒绝；打回上一阶段放行（现场常发生）；任何非归档态都可归档；归档可复活。
const VENUE_TRANSITIONS: Record<VenueStage, readonly VenueStage[]> = {
  lead: ['surveying', 'archived'],
  surveying: ['deploying', 'lead', 'archived'],
  deploying: ['pilot', 'surveying', 'archived'],
  pilot: ['live', 'deploying', 'archived'],
  live: ['archived'],
  archived: ['live'],
};

export function canTransitionVenueStage(from: VenueStage, to: VenueStage): boolean {
  if (from === to) return false;
  return VENUE_TRANSITIONS[from].includes(to);
}

export type VenueStampKey = 'surveyStartedAt' | 'surveyedAt' | 'deployedAt' | 'liveAt';

/**
 * 进入某阶段该盖哪个章。返回 null = 不盖章。
 * 按命名口径分两类：`surveyStartedAt`（采风开始）与 `liveAt`（正式运营开始）记**进入时刻**，
 * `surveyedAt`（采风完成）与 `deployedAt`（部署完成）记**上一阶段完成的时刻**。
 * 阶段流转是瞬时的，所以这两类落在同一个时间点上，区分的是命名口径而非两个时刻。详见 spec §5.1。
 */
export function stampForStage(stage: VenueStage): VenueStampKey | null {
  switch (stage) {
    case 'surveying': return 'surveyStartedAt';
    case 'deploying': return 'surveyedAt';
    case 'pilot': return 'deployedAt';
    case 'live': return 'liveAt';
    case 'lead':
    case 'archived': return null;
    default: {
      const _exhaustive: never = stage; // 新增阶段时在此编译报错，而不是静默不盖章
      return null;
    }
  }
}

/**
 * 计算本次流转要写的时间戳补丁。
 * **已在的章不覆盖**（`??=` 语义）：度量的是「从第一次动手到上线」的端到端时长，
 * 返工应当让它变长、被看见，而不是被掩盖。
 * 只补本次进入阶段对应的那一个章，不为「未经手的前序阶段」凭空补章。
 */
export function computeStagePatch(
  current: Partial<Record<VenueStampKey, Date | null | undefined>>,
  to: VenueStage,
  now: Date,
): Partial<Record<VenueStampKey, Date>> {
  const key = stampForStage(to);
  if (!key) return {};
  if (current[key]) return {};
  return { [key]: now };
}

// 短码上限。**这个上限由蓝牙信标的 UUID 决定，不是由印刷短码决定的。**
// `code` 这一列被两种语义共用：
//   - triggerType='qrcode' —— 印在物料上、游客用眼睛读用手输的短码。
//     生成器产出 WLP-XXXXXXXXXXXX（16 位）；现场口头念码的舒适区大约在 20 位内。
//   - triggerType='beacon' —— 现场硬件的 iBeacon UUID，**36 位**，没人会去念它。
// 取 64 是为了让 UUID 有富余，同时仍然挡掉明显失控的输入。
// 字符集 `[A-Za-z0-9_-]` 对两者都成立：UUID 是十六进制加连字符，
// 且这几种字符都能安全放进 URL query，无需再转义。
export const POINT_CODE_MAX_LENGTH = 64;
/** 字母 / 数字 / 下划线 / 连字符。**允许空串（`*` 不是笔误）** ——
 *  空串必须先过正则、再由 pointCodeSchema 归一为 null；若这里写成 `+`，
 *  用户清空短码时会收到「含非法字符」这种莫名其妙的报错。
 *  另：UUID 是十六进制 + 连字符，落在本字符集内。 */
export const POINT_CODE_RE = /^[A-Za-z0-9_-]*$/;

// Crockford 风格 base32：剔除 I / L / O / U，避免现场口头念码时听错。
// （Crockford 原表为 0-9 A-Z 去 I L O U，共 32 位。）
const CODE_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const CODE_LENGTH = 12;

/** 生成点位码。`random` 可注入，便于测试确定性输出。 */
export function generatePointCode(random: () => number = Math.random): string {
  let out = '';
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
  }
  return `WLP-${out}`;
}
