// 微信订房文本 → 结构化字段解析器（规则正则，无外部依赖）
// 输入示例：
//   姓名：  吴冲
//   联系电话：13101368827
//   入住人数：2大
//   房型：星空房
//   入住日期：8月14
//   退房日期：8月17号
//   入住天数：3晚

export interface CheckinFields {
  guestName: string;
  guestPhone: string;
  adultCount: number;
  childCount: number;
  roomType: string;
  checkInDate: string;   // YYYY-MM-DD
  checkOutDate: string;  // YYYY-MM-DD
  nights: number;
  staffName: string;
}

export interface ParsedCheckin {
  fields: CheckinFields;
  missing: string[];
  warnings: string[];
}

const NAME_RE = /姓名[:：]\s*(\S+)/;
const PHONE_RE = /(?:联系电话|手机号|手机号码)[:：]\s*(\d{11})/;
const PEOPLE_RE = /入住人数[:：]\s*(\d+)大(?:\s*(\d+)小)?/;
const ROOM_RE = /房型[:：]\s*(\S+)/;
const CHECKIN_DATE_RE = /入住日期[:：]\s*(\d{1,2})月(\d{1,2})(?:日|号)?/;
const CHECKOUT_DATE_RE = /退房日期[:：]\s*(\d{1,2})月(\d{1,2})(?:日|号)?/;
const NIGHTS_RE = /入住天数[:：]\s*(\d+)晚/;

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

function m2d(month: number, day: number, year: number): string {
  return `${year}-${pad2(month)}-${pad2(day)}`;
}

export function parseCheckinText(text: string): ParsedCheckin {
  const raw = String(text || '');
  const fields: CheckinFields = {
    guestName: '',
    guestPhone: '',
    adultCount: 1,
    childCount: 0,
    roomType: '',
    checkInDate: '',
    checkOutDate: '',
    nights: 1,
    staffName: '',
  };
  const missing: string[] = [];
  const warnings: string[] = [];
  const year = new Date().getFullYear();

  const nameM = raw.match(NAME_RE);
  if (nameM) fields.guestName = nameM[1].trim();
  else missing.push('guestName');

  const phoneM = raw.match(PHONE_RE);
  if (phoneM) fields.guestPhone = phoneM[1];
  else missing.push('guestPhone');

  const peopleM = raw.match(PEOPLE_RE);
  if (peopleM) {
    fields.adultCount = parseInt(peopleM[1], 10) || 1;
    if (peopleM[2]) fields.childCount = parseInt(peopleM[2], 10) || 0;
  }

  const roomM = raw.match(ROOM_RE);
  if (roomM) fields.roomType = roomM[1].trim();
  else missing.push('roomType');

  const ciM = raw.match(CHECKIN_DATE_RE);
  if (ciM) fields.checkInDate = m2d(parseInt(ciM[1], 10), parseInt(ciM[2], 10), year);
  else missing.push('checkInDate');

  const coM = raw.match(CHECKOUT_DATE_RE);
  if (coM) fields.checkOutDate = m2d(parseInt(coM[1], 10), parseInt(coM[2], 10), year);
  else missing.push('checkOutDate');

  const nighM = raw.match(NIGHTS_RE);
  if (nighM) fields.nights = parseInt(nighM[1], 10) || 1;

  // 交叉校验：日期区间 vs 入住天数（只要日期区间可算出正差值，就自动以日期为准计算间夜数）
  if (fields.checkInDate && fields.checkOutDate) {
    let dIn = new Date(fields.checkInDate + 'T00:00:00Z');
    let dOut = new Date(fields.checkOutDate + 'T00:00:00Z');
    let diff = Math.round((dOut.getTime() - dIn.getTime()) / 86400000);
    if (diff <= 0) {
      // 跨年：退房日期 +1 年
      const ny = dOut.getUTCFullYear() + 1;
      fields.checkOutDate = `${ny}-${pad2(dOut.getUTCMonth() + 1)}-${pad2(dOut.getUTCDate())}`;
      dOut = new Date(fields.checkOutDate + 'T00:00:00Z');
      diff = Math.round((dOut.getTime() - dIn.getTime()) / 86400000);
      warnings.push('退房日期早于入住日期，已自动按跨年处理');
    }
    if (diff > 0) {
      // 未写入住天数或与日期区间不一致时，均以日期区间为准自动计算间夜数
      if (nighM && diff !== fields.nights) {
        warnings.push(`入住天数与日期区间不一致（${diff}晚 vs ${fields.nights}晚），以日期为准`);
      }
      fields.nights = diff;
    }
  }

  return { fields, missing, warnings };
}
