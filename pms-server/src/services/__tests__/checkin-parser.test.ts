import { describe, it, expect } from 'vitest';
import { parseCheckinText } from '../checkin-parser.js';

describe('parseCheckinText', () => {
  const SAMPLE = `姓名：  吴冲
联系电话：13101368827
入住人数：2大
房型：星空房
入住日期：8月14
退房日期：8月17号
入住天数：3晚`;

  it('解析完整示例', () => {
    const r = parseCheckinText(SAMPLE);
    expect(r.fields.guestName).toBe('吴冲');
    expect(r.fields.guestPhone).toBe('13101368827');
    expect(r.fields.adultCount).toBe(2);
    expect(r.fields.childCount).toBe(0);
    expect(r.fields.roomType).toBe('星空房');
    expect(r.fields.checkInDate).toMatch(/^\d{4}-08-14$/);
    expect(r.fields.checkOutDate).toMatch(/^\d{4}-08-17$/);
    expect(r.fields.nights).toBe(3);
    expect(r.missing.length).toBe(0);
    expect(r.warnings.length).toBe(0);
  });

  it('缺电话号码时 missing 含 guestPhone', () => {
    const r = parseCheckinText('姓名：张三\n房型：大床房');
    expect(r.missing).toContain('guestPhone');
  });

  it('2大1小 分别解析大人儿童', () => {
    const r = parseCheckinText('姓名：李四\n入住人数：2大1小\n入住天数：1晚');
    expect(r.fields.adultCount).toBe(2);
    expect(r.fields.childCount).toBe(1);
  });

  it('日期兼容 日/号 后缀', () => {
    const r = parseCheckinText('姓名：王五\n入住日期：12月1日\n退房日期：1月3号\n入住天数：2晚');
    expect(r.fields.checkInDate).toMatch(/12-01$/);
    expect(r.fields.checkOutDate).toMatch(/01-03$/);
  });

  it('退房早于入住自动跨年并提示', () => {
    const r = parseCheckinText('姓名：赵六\n入住日期：12月30日\n退房日期：1月2号\n入住天数：3晚');
    expect(r.fields.checkInDate).toMatch(/12-30$/);
    expect(r.fields.checkOutDate).toMatch(/^\d{4}-01-02$/);
    expect(r.fields.checkOutDate > r.fields.checkInDate).toBe(true);
    expect(r.warnings.some((w) => w.includes('跨年'))).toBe(true);
  });

  it('空文本所有字段 missing', () => {
    const r = parseCheckinText('');
    expect(r.missing).toContain('guestName');
    expect(r.missing).toContain('checkInDate');
  });
});
