import { describe, it, expect } from 'vitest';
import { findCorruptedTextFields } from '../text-integrity.js';

// 闸**涉及的坏字节**一律用 fromCharCode 写（不落字面字符、也不用反斜杠转义），
// 免得被编码问题反噬；本包 enqueue.test.ts:112 同一写法。
// （夹具里的正常中文是必需的实际输入数据，不在此列。）
const FFFD = String.fromCharCode(0xfffd);   // U+FFFD REPLACEMENT CHARACTER
const YA = String.fromCharCode(0x042f);     // U+042F —— GBK 的 D0 AF 按 UTF-8 解出来的字

describe('findCorruptedTextFields —— 拦住上游「非致命解码」留下的坏字节', () => {
  it('抓得住这条通路的真实产物：GBK 字节被按 UTF-8 非致命解码', () => {
    // 「携程」两个字的 GBK 字节，按 UTF-8 非致命解码。这不是合成的字符串，
    // 而是与生产 pms_bui_competitor_config.platform 那 4 行**逐字节同形**的构造：
    //   D0 AF → 恰好凑成一对合法 UTF-8 双字节 ⇒ 解出 U+042F（不是「携」）
    //   B3    → 孤立续字节 ⇒ U+FFFD
    //   CC    → 前导字节却没有续字节 ⇒ U+FFFD
    const decoded = Buffer.from([0xd0, 0xaf, 0xb3, 0xcc]).toString('utf8');
    expect(decoded).toBe(`${YA}${FFFD}${FFFD}`);   // 前提：这条通路确实产出 U+FFFD
    expect(findCorruptedTextFields({ platform: decoded })).toEqual(['platform']);
  });

  it('抓得住生产 platform 列的实际取值形状', () => {
    expect(findCorruptedTextFields({ platform: `${YA}${FFFD}${FFFD}` })).toEqual(['platform']);
  });

  it('多个字段损坏时全部列出，不是只报第一个', () => {
    const body = {
      hotelName: `JW万豪${FFFD}酒店`,
      platform: `${YA}${FFFD}${FFFD}`,
      competitorRoomType: `商务${FFFD}床房`,
    };
    expect(findCorruptedTextFields(body).sort()).toEqual(['competitorRoomType', 'hotelName', 'platform']);
  });

  // 同一类脏值的**孪生形态**：孤立代理项在内存里不是 U+FFFD，但落库那一刻被
  // Buffer.from 编成 EF BF BD（U+FFFD）—— 与 enqueue.ts 的 fitName 同一条口径。
  // JSON 里可以用 \uD800 转义把它送进来，所以闸只查 U+FFFD 是不够的。
  it('拒绝孤立代理项 —— 它在落库那一刻才会变成 U+FFFD', () => {
    const lone = String.fromCharCode(0xd800);
    expect(findCorruptedTextFields({ hotelName: `杭州${lone}西湖` })).toEqual(['hotelName']);
  });

  // 阴性对照：闸只该拦损坏值。拦宽了会挡住正常录入，那不是修复而是新故障。
  it('正常中文与各平台名照旧通过', () => {
    expect(findCorruptedTextFields({
      hotelName: '杭州西湖希尔顿', platform: '携程',
      platformHotelId: '436378', platformUrl: 'https://hotels.ctrip.com/hotel/436378.html',
      competitorRoomType: '商务大床房',
    })).toEqual([]);
  });

  // emoji 走代理对，是**合法**的双码元序列 —— 决不能和孤立代理项一起被误伤。
  it('emoji（合法代理对）照旧通过', () => {
    expect(findCorruptedTextFields({ hotelName: `杭州西湖希尔顿${String.fromCodePoint(0x1f600)}` })).toEqual([]);
  });

  // ⚠️ 空串**必须**放行：前端表单把三个非必填字段初始化成 ''（competitor/page.tsx:30），
  //    且只校验 hotelName/platform（:57）。拦空串等于让「只填名称和平台」的正当录入 400。
  it('空串放行 —— 三个非必填字段前端就是送空串的', () => {
    expect(findCorruptedTextFields({
      hotelName: '亚朵', platform: '美团',
      platformHotelId: '', platformUrl: '', competitorRoomType: '',
    })).toEqual([]);
  });

  it('非字符串与嵌套结构一律不碰', () => {
    expect(findCorruptedTextFields({
      hotelName: '亚朵', platform: '飞猪',
      lastPrice: 0, status: true, id: null,
      nested: { a: FFFD }, list: [FFFD],
    })).toEqual([]);
  });

  it('无损坏字段与空 body 返回空数组', () => {
    expect(findCorruptedTextFields({})).toEqual([]);
    expect(findCorruptedTextFields(null)).toEqual([]);
  });
});
