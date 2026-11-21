import { SUBSCRIBE_REPLY, KEYWORD_REPLIES, DEFAULT_REPLY } from '../config/mp-reply.js';
import { MP_MENU } from '../config/mp-menu.js';

/** 公众号运营配置（DB 可配置；缺省字段回落到 config/mp-menu.ts、config/mp-reply.ts 的种子默认值） */
export interface MpConfig {
  /** 自定义菜单（{ button: [...] }） */
  menu?: any;
  /** 关注欢迎语 */
  welcome?: string;
  /** 关键词回复：关键词（含关键字即命中，优先首个匹配）→ 文案 */
  keywordReplies?: { keywords: string[]; reply: string }[];
  /** 默认回复（未命中关键词） */
  defaultReply?: string;
}

/** 公众号运营配置内存缓存（60s TTL） */
let mpConfigCache: { data: MpConfig; expireAt: number } | null = null;

/** 构建种子默认配置（常量降级为种子：首次 GET /api/admin/mp-config 会以此兜底） */
export function buildSeedConfig(): MpConfig {
  return {
    menu: MP_MENU,
    welcome: SUBSCRIBE_REPLY,
    keywordReplies: KEYWORD_REPLIES,
    defaultReply: DEFAULT_REPLY,
  };
}

/** DB 配置行（各字段可空，兼容 pms_bui_mp_config 查询结果） */
export type MpConfigRow = Partial<{ [K in keyof MpConfig]: MpConfig[K] | null }>;

/**
 * 合并 DB 配置行与种子默认：行内字段缺失/null 时回落到种子默认。
 * 纯函数，供 CRUD 与回调共用，也便于单测（覆盖「无行→种子初始化」「部分字段→逐项回落」）。
 */
export function getEffectiveConfig(row?: MpConfigRow | null): MpConfig {
  const seed = buildSeedConfig();
  return {
    menu: row?.menu ?? seed.menu,
    welcome: row?.welcome ?? seed.welcome,
    keywordReplies: row?.keywordReplies?.length ? row.keywordReplies : seed.keywordReplies,
    defaultReply: row?.defaultReply ?? seed.defaultReply,
  };
}

/** 读公众号运营配置：优先 DB（pms_bui_mp_config id=1），无行/读取失败用种子默认兜底；内存缓存 60s */
export async function getMpConfig(): Promise<MpConfig> {
  if (mpConfigCache && Date.now() < mpConfigCache.expireAt) return mpConfigCache.data;
  let config = buildSeedConfig();
  try {
    // 惰性 import：handleMpMessage 注入 config 时（纯函数路径）不触碰 DB，保持可测
    const { pmsBuiMpConfig } = await import('../db/schema/mp-config.js');
    const { db } = await import('../db/index.js');
    const { eq } = await import('drizzle-orm');
    const [row] = await db.select().from(pmsBuiMpConfig).where(eq(pmsBuiMpConfig.id, 1)).limit(1);
    config = getEffectiveConfig(row);
  } catch {
    // DB 不可用/未建表 → 兜底种子常量，不影响回调可用性
  }
  mpConfigCache = { data: config, expireAt: Date.now() + 60 * 1000 };
  return config;
}

/** 清空运营配置内存缓存（后台 PUT 配置后调用，使新配置立即生效） */
export function clearMpConfigCache(): void {
  mpConfigCache = null;
}

/** 解析后的公众号消息结构 */
export interface MpMessage {
  /** 公众号原始 ID（被动回复时作为 FromUserName） */
  toUserName: string;
  /** 用户 openid（被动回复时作为 ToUserName） */
  fromUserName: string;
  /** 消息类型：text / event / image 等 */
  msgType: string;
  /** 事件类型（subscribe / unsubscribe / CLICK 等） */
  event?: string;
  /** 事件参数（菜单 key 等） */
  eventKey?: string;
  /** 文本消息内容 */
  content?: string;
}

/** 简易 XML 字段提取：匹配 <tag>value</tag>（值可为多行），并去除 CDATA 包装 */
function extractField(xml: string, tag: string): string {
  const m = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  if (!m) return '';
  const raw = m[1].trim();
  // 微信消息部分字段用 <![CDATA[...]]> 包装，需去除后再 trim
  const cdata = raw.match(/^<!\[CDATA\[([\s\S]*?)\]\]>$/);
  return (cdata ? cdata[1] : raw).trim();
}

/** 解析公众号消息 XML（简易正则解析，不引第三方库；解析失败返回空字段不抛异常） */
export function parseMpMessage(xml: string): MpMessage {
  return {
    toUserName: extractField(xml, 'ToUserName'),
    fromUserName: extractField(xml, 'FromUserName'),
    msgType: extractField(xml, 'MsgType'),
    event: extractField(xml, 'Event') || undefined,
    eventKey: extractField(xml, 'EventKey') || undefined,
    content: extractField(xml, 'Content') || undefined,
  };
}

/** XML 特殊字符转义（被动回复 Content 防注入：& < > " '） */
export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/**
 * 构造文本被动回复 XML
 * @param toUser 接收方（用户 openid，来自入站消息 FromUserName）
 * @param fromUser 发送方（公众号原始 ID，来自入站消息 ToUserName）
 * @param content 回复文本（自动 XML 转义）
 * @param createTime Unix 秒时间戳（默认当前时间，测试可传入固定值）
 */
export function buildTextReply(toUser: string, fromUser: string, content: string, createTime = Math.floor(Date.now() / 1000)): string {
  return [
    '<xml>',
    `<ToUserName>${escapeXml(toUser)}</ToUserName>`,
    `<FromUserName>${escapeXml(fromUser)}</FromUserName>`,
    `<CreateTime>${createTime}</CreateTime>`,
    '<MsgType>text</MsgType>',
    `<Content>${escapeXml(content)}</Content>`,
    '</xml>',
  ].join('');
}

/**
 * 处理公众号消息/事件：解析 → 分发 → 返回被动回复 XML
 * - subscribe 事件 → 关注欢迎语（config.welcome，兜底 SUBSCRIBE_REPLY）
 * - text 消息 → 关键词匹配（config.keywordReplies 含关键字即命中，优先首个匹配）→ 命中回复 / config.defaultReply
 * - 其他事件/消息 → 返回 null（无被动回复，路由回 success）
 *
 * @param xml 入站消息 XML
 * @param config 运营配置（可注入，保持纯函数可测；不传时走 getMpConfig() DB 缓存，兜底种子常量）
 */
export async function handleMpMessage(xml: string, config?: MpConfig): Promise<string | null> {
  const msg = parseMpMessage(xml);
  const cfg = config ?? (await getMpConfig());

  // 事件：仅关注事件有欢迎语
  if (msg.msgType === 'event') {
    if (msg.event === 'subscribe') {
      const welcome = cfg.welcome;
      return welcome ? buildTextReply(msg.fromUserName, msg.toUserName, welcome) : null;
    }
    return null; // 取消关注/菜单点击等事件暂无被动回复
  }

  // 文本：关键词匹配
  if (msg.msgType === 'text') {
    const content = msg.content || '';
    const keywordReplies = cfg.keywordReplies || [];
    const hit = keywordReplies.find((entry) => entry.keywords.some((kw) => content.includes(kw)));
    const reply = hit ? hit.reply : cfg.defaultReply;
    return reply ? buildTextReply(msg.fromUserName, msg.toUserName, reply) : null;
  }

  return null; // 图片/语音等其它消息类型暂无回复
}
