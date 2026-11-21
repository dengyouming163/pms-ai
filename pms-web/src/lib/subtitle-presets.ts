/**
 * 字幕风格预设（火山引擎 MediaKit add-subtitle-to-video API 参数）
 *
 * API 支持的参数（共 4 个）：
 *   subtitle_font_type   — ali_puhui | sy_black | pm_zhengdao | zhanku_kuaile
 *   subtitle_font_size   — 整数 px（建议 36~72）
 *   subtitle_font_color  — RGBA 十六进制 #RRGGBBAA（FF=不透明）
 *   subtitle_pos_preset  — bottom_center | top_center | center | lower_third
 *
 * 注意：火山引擎不支持描边/阴影/发光/气泡，通过加大字号 + 高对比度颜色来保证清晰度。
 */

export interface SubtitlePreset {
  key: string;
  name: string;
  desc: string;
  config: {
    fontType: string;
    fontSize: number;
    fontColor: string;
    posPreset: string;
  };
}

export const SUBTITLE_PRESETS: SubtitlePreset[] = [
  {
    key: 'clean-white',
    name: '极简白字',
    desc: '白色大号黑体，经典干净',
    config: { fontType: 'sy_black', fontSize: 56, fontColor: '#FFFFFFFF', posPreset: 'bottom_center' },
  },
  {
    key: 'douyin-gold',
    name: '抖音爆款',
    desc: '金黄标题体，短视频流量密码',
    config: { fontType: 'pm_zhengdao', fontSize: 60, fontColor: '#FFD700FF', posPreset: 'bottom_center' },
  },
  {
    key: 'soft-purple',
    name: '柔光霓虹',
    desc: '纯白粗体 + 稍大字号，模拟发光感',
    config: { fontType: 'ali_puhui', fontSize: 58, fontColor: '#FFFFFFFF', posPreset: 'bottom_center' },
  },
  {
    key: 'bold-pink',
    name: '粗体玫红',
    desc: '玫红大字，少女心动',
    config: { fontType: 'pm_zhengdao', fontSize: 56, fontColor: '#EC4899FF', posPreset: 'bottom_center' },
  },
  {
    key: 'minimal-vlog',
    name: '极简Vlog',
    desc: '偏小字号居下，日系vlog风',
    config: { fontType: 'ali_puhui', fontSize: 40, fontColor: '#FFFFFFFF', posPreset: 'lower_third' },
  },
  {
    key: 'cinema',
    name: '影院字幕',
    desc: '白色思源黑体居中，电影质感',
    config: { fontType: 'sy_black', fontSize: 48, fontColor: '#FFFFFFFF', posPreset: 'center' },
  },
  {
    key: 'warm-orange',
    name: '暖橙氛围',
    desc: '白色大字，温暖民宿首选',
    config: { fontType: 'ali_puhui', fontSize: 56, fontColor: '#FFFFFFF2', posPreset: 'bottom_center' },
  },
  {
    key: 'elegant-gold',
    name: '优雅金字',
    desc: '金色大号，高端民宿首选',
    config: { fontType: 'ali_puhui', fontSize: 60, fontColor: '#FFFBEBFF', posPreset: 'bottom_center' },
  },
  {
    key: 'fresh-green',
    name: '清新翠绿',
    desc: '纯白大字，自然治愈',
    config: { fontType: 'ali_puhui', fontSize: 56, fontColor: '#FFFFFFFF', posPreset: 'bottom_center' },
  },
  {
    key: 'tech-blue',
    name: '科技蓝光',
    desc: '浅蓝思源黑体，现代科技感',
    config: { fontType: 'sy_black', fontSize: 54, fontColor: '#60A5FAFF', posPreset: 'bottom_center' },
  },
  {
    key: 'luxury-gold',
    name: '奢华金箔',
    desc: '金色标题体大号，高端质感',
    config: { fontType: 'pm_zhengdao', fontSize: 62, fontColor: '#FBBF24FF', posPreset: 'bottom_center' },
  },
  {
    key: 'playful',
    name: '活泼弹幕',
    desc: '站酷快乐体，年轻有趣',
    config: { fontType: 'zhanku_kuaile', fontSize: 50, fontColor: '#FFFFFFFF', posPreset: 'bottom_center' },
  },
];

/** 根据 key 获取预设配置 */
export function getSubtitlePreset(key: string): SubtitlePreset | undefined {
  return SUBTITLE_PRESETS.find(p => p.key === key);
}

/** 预设配置转为 API 请求参数 */
export function presetToApiParams(config: SubtitlePreset['config']) {
  return {
    fontType: config.fontType,
    fontSize: config.fontSize,
    fontColor: config.fontColor,
    posPreset: config.posPreset,
  };
}
