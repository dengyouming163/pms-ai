import { describe, it, expect } from 'vitest';
import { MP_MENU } from '../mp-menu.js';

describe('MP_MENU 菜单结构', () => {
  it('3 个一级菜单，且每个都有非空 sub_button 子菜单', () => {
    expect(MP_MENU.button.length).toBe(3);
    for (const btn of MP_MENU.button) {
      expect(btn.name.length > 0).toBe(true);
      expect(btn.sub_button !== undefined).toBe(true);
      expect(btn.sub_button!.length > 0).toBe(true);
    }
  });

  it('所有按钮均为 miniprogram 类型且指向小程序页面（url 保留降级）', () => {
    for (const btn of MP_MENU.button) {
      for (const sub of btn.sub_button || []) {
        expect(sub.type).toBe('miniprogram');
        expect(sub.name.length > 0).toBe(true);
        // 小程序 appid 与 pms-nimi manifest mp-weixin.appid 一致
        expect(sub.appid).toBe('wx0e5fc1f7fa23d1fe');
        // pagepath 必须是非空且为 pages/ 开头的小程序页面路径
        expect(sub.pagepath).toMatch(/^pages\/[\w/-]+$/);
        // url 保留：老版本微信无小程序环境时降级打开 H5
        expect(sub.url!.startsWith('https://')).toBe(true);
      }
    }
  });

  it('菜单结构与预期一致（精选民宿/我的服务/关于我们）', () => {
    expect(MP_MENU.button.map((b) => b.name)).toEqual(['精选民宿', '我的服务', '关于我们']);
    expect(MP_MENU.button[0].sub_button?.map((s) => s.name)).toEqual(['精选民宿', '需求匹配', '我的优惠']);
    expect(MP_MENU.button[1].sub_button?.map((s) => s.name)).toEqual(['我的订单', '售后中心', '联系客服']);
    expect(MP_MENU.button[2].sub_button?.map((s) => s.name)).toEqual(['民宿合集', '入住指南', '帮助反馈']);
  });
});
