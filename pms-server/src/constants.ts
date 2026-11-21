/** JWT 签名密钥 — 生产环境通过环境变量注入 */
export const JWT_SECRET = (() => {
  const secret = process.env.JWT_SECRET;
  if (!secret) throw new Error('FATAL: JWT_SECRET 环境变量未设置！请检查 .env 文件');
  return secret;
})();

/** Token 过期时间 */
export const TOKEN_EXPIRES = '7d';

/** 内部服务间认证 Token */
export const INTERNAL_SERVICE_TOKEN = process.env.INTERNAL_SERVICE_TOKEN || (() => { throw new Error('FATAL: INTERNAL_SERVICE_TOKEN 环境变量未设置！'); })();

/** Redis 连接 URL */
export const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379';

/** pms-agent 服务地址 */
export const AGENT_API_URL = process.env.AGENT_API_URL || 'http://localhost:8000';

/** 按需读取环境变量（调用时才校验，避免未配置微信参数时服务无法启动） */
export function requireEnv(key: string): string {
  const val = process.env[key];
  if (!val) throw new Error(`FATAL: ${key} 环境变量未设置！请检查 .env 文件`);
  return val;
}

/** C端小程序 Token 有效期 */
export const MINI_TOKEN_EXPIRES = '30d';

/** 平台化需求匹配：固定偏好标签库（平台后台配置与需求匹配向导共用，保证两端一致） */
export const PREFERENCE_TAGS = [
  '亲子', '宠物', '情侣', '温泉', '海景',
  '古镇', '夜泊', '聚会', '商务', '长住', '山景', '自驾',
] as const;

/** 偏好标签联合类型 */
export type PreferenceTag = typeof PREFERENCE_TAGS[number];

/** 地域标签库（贵州市场）：城市级，依据贵州行政地级行政区（地级市 + 自治州） */
export const REGION_CITIES = [
  '贵阳', '遵义', '安顺', '黔东南', '黔南', '黔西南', '铜仁', '毕节', '六盘水',
] as const;

/** 地域标签库（贵州市场）：热门目的地级，依据贵州旅游热度（5A/4A 景区、世界遗产等） */
export const REGION_DESTINATIONS = [
  '黄果树', '荔波小七孔', '西江千户苗寨', '镇远古镇', '梵净山', '肇兴侗寨',
  '青岩古镇', '万峰林', '百里杜鹃', '织金洞', '龙宫', '赤水丹霞',
] as const;

/** 地域标签全量（门店绑定值必须取自此处；城市级在前、目的地级在后） */
export const REGION_TAGS = [...REGION_CITIES, ...REGION_DESTINATIONS] as const;

/** 地域标签联合类型 */
export type RegionTag = typeof REGION_TAGS[number];

/** pms-platform-server（BFF）内部地址，用于文旅门票校验 */
export const PLATFORM_SERVER_URL = process.env.PLATFORM_SERVER_URL || 'http://pms-platform-server:9092';
