import { describe, it, expect } from 'vitest';
import { SUBSCRIBE_REPLY, KEYWORD_REPLIES, DEFAULT_REPLY } from '../../config/mp-reply.js';
import { parseMpMessage, buildTextReply, handleMpMessage, escapeXml, type MpConfig } from '../mp-reply.js';

/** 订阅事件（带 CDATA 包装，模拟微信真实报文） */
const subXml = `<xml>
<ToUserName><![CDATA[gh_official_abc]]></ToUserName>
<FromUserName><![CDATA[openid_user_1]]></FromUserName>
<CreateTime>1348831860</CreateTime>
<MsgType><![CDATA[event]]></MsgType>
<Event><![CDATA[subscribe]]></Event>
<EventKey><![CDATA[]]></EventKey>
</xml>`;

/** 文本消息（订单关键词） */
function textXml(content: string) {
  return `<xml><ToUserName><![CDATA[gh_official_abc]]></ToUserName><FromUserName><![CDATA[openid_user_1]]></FromUserName><CreateTime>1348831860</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${content}]]></Content><MsgId>1234567890123456</MsgId></xml>`;
}

/** 注入种子等价的配置（handleMpMessage 纯函数路径，不触碰 DB） */
const seedConfig: MpConfig = {
  welcome: SUBSCRIBE_REPLY,
  keywordReplies: KEYWORD_REPLIES,
  defaultReply: DEFAULT_REPLY,
};

describe('parseMpMessage', () => {
  it('解析 CDATA 包装的事件报文', () => {
    const msg = parseMpMessage(subXml);
    expect(msg.toUserName).toBe('gh_official_abc');
    expect(msg.fromUserName).toBe('openid_user_1');
    expect(msg.msgType).toBe('event');
    expect(msg.event).toBe('subscribe');
  });
  it('解析文本消息的 Content', () => {
    const msg = parseMpMessage(textXml('我想查我的订单'));
    expect(msg.msgType).toBe('text');
    expect(msg.content).toBe('我想查我的订单');
  });
  it('异常报文不抛异常，返回空字段', () => {
    // 直接调用：若实现抛异常则本用例自然失败（此处不使用 toThrow 断言，避免依赖不稳定的 matcher 类型）
    const msg = parseMpMessage('<garbage>');
    expect(msg.msgType).toBe('');
    expect(msg.fromUserName).toBe('');
  });
});

describe('buildTextReply', () => {
  it('构造标准被动回复 XML 结构', () => {
    const xml = buildTextReply('openid_user_1', 'gh_official_abc', '你好', 1700000000);
    expect(xml.startsWith('<xml>')).toBe(true);
    expect(xml).toContain('<ToUserName>openid_user_1</ToUserName>');
    expect(xml).toContain('<FromUserName>gh_official_abc</FromUserName>');
    expect(xml).toContain('<CreateTime>1700000000</CreateTime>');
    expect(xml).toContain('<MsgType>text</MsgType>');
    expect(xml).toContain('<Content>你好</Content>');
  });
  it('Content 含 XML 特殊字符时正确转义', () => {
    const xml = buildTextReply('to', 'from', 'A & B < C > D "E" \'F\'');
    expect(xml).toContain('<Content>A &amp; B &lt; C &gt; D &quot;E&quot; &apos;F&apos;</Content>');
    // 原文特殊字符不应原样出现
    expect(xml.includes('< C')).toBe(false);
    expect(xml.includes('& B')).toBe(false);
  });
});

describe('escapeXml', () => {
  it('转义全部 5 个特殊字符', () => {
    expect(escapeXml(`&<>"'`)).toBe('&amp;&lt;&gt;&quot;&apos;');
  });
  it('普通文本原样返回', () => {
    expect(escapeXml('普通中文 hello 123')).toBe('普通中文 hello 123');
  });
});

describe('handleMpMessage 分发（注入 config，纯函数）', () => {
  it('订阅事件 → 关注欢迎语', async () => {
    const reply = await handleMpMessage(subXml, seedConfig);
    expect(reply).not.toBe(null);
    // 被动回复 ToUserName = 入站 FromUserName，FromUserName = 入站 ToUserName
    expect(reply).toContain('<ToUserName>openid_user_1</ToUserName>');
    expect(reply).toContain('<FromUserName>gh_official_abc</FromUserName>');
    expect(reply).toContain(`<Content>${escapeXml(SUBSCRIBE_REPLY)}</Content>`);
  });
  it('关键词「订单」命中订单回复', async () => {
    const reply = await handleMpMessage(textXml('我想查我的订单在哪里'), seedConfig);
    expect(reply).toContain('我的订单');
  });
  it('关键词「优惠」命中优惠回复', async () => {
    const reply = await handleMpMessage(textXml('有没有优惠券'), seedConfig);
    expect(reply).toContain('优惠');
  });
  it('关键词「你好」命中问候回复', async () => {
    const reply = await handleMpMessage(textXml('你好'), seedConfig);
    expect(reply).toContain('欢迎来到智宿管家');
  });
  it('未命中任何关键词 → 默认回复', async () => {
    const reply = await handleMpMessage(textXml('随便聊聊天气'), seedConfig);
    expect(reply).toContain(`<Content>${escapeXml(DEFAULT_REPLY)}</Content>`);
  });
  it('非文本非订阅（如取消关注/图片）→ null（路由回 success）', async () => {
    const unsubscribe = subXml.replace('subscribe', 'unsubscribe');
    expect(await handleMpMessage(unsubscribe, seedConfig)).toBe(null);
    const imageXml = subXml.replace('event', 'image').replace('subscribe', '');
    expect(await handleMpMessage(imageXml, seedConfig)).toBe(null);
  });
  it('空/异常报文 → null 不抛异常', async () => {
    expect(await handleMpMessage('', seedConfig)).toBe(null);
    expect(await handleMpMessage('<xml>broken</xml>', seedConfig)).toBe(null);
  });
});

describe('handleMpMessage 注入自定义配置覆盖种子', () => {
  it('订阅 → 使用配置的欢迎语而非种子', async () => {
    const reply = await handleMpMessage(subXml, { welcome: '自定义欢迎语' });
    expect(reply).toContain('<Content>自定义欢迎语</Content>');
    expect(reply).not.toContain(SUBSCRIBE_REPLY);
  });
  it('关键词 → 命中自定义关键词回复（自定义列表优先于种子）', async () => {
    const reply = await handleMpMessage(textXml('我想订房'), {
      keywordReplies: [{ keywords: ['订房'], reply: '自定义订房回复' }],
      defaultReply: '自定义默认回复',
    });
    expect(reply).toContain('自定义订房回复');
  });
  it('未命中自定义关键词 → 自定义默认回复', async () => {
    const reply = await handleMpMessage(textXml('随便聊聊天气'), {
      keywordReplies: [{ keywords: ['订房'], reply: '自定义订房回复' }],
      defaultReply: '自定义默认回复',
    });
    expect(reply).toContain('自定义默认回复');
  });
  it('subscribe 事件配置空欢迎语 → null（不回复空内容）', async () => {
    expect(await handleMpMessage(subXml, { welcome: '' })).toBe(null);
  });
});
