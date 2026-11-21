/** 关注欢迎语（【种子默认值】自动回复已后台化：回调读 DB pms_bui_mp_config，无配置时回落本常量） */
export const SUBSCRIBE_REPLY = '欢迎来到智宿管家 ✨\n精选住宿套餐 · 官方直订更优惠\n请点击下方菜单，或回复「订单/优惠/入住/客服」获取帮助';

/** 关键词回复：关键词 → 文案（含关键字即命中，优先首个匹配；【种子默认值】见 SUBSCRIBE_REPLY 说明） */
export const KEYWORD_REPLIES: { keywords: string[]; reply: string }[] = [
  { keywords: ['订单', '我的订单'], reply: '点击下方菜单「我的服务-我的订单」查看您的订单～' },
  { keywords: ['优惠', '券'], reply: '点击下方菜单「精选套餐-我的优惠」领取优惠～' },
  { keywords: ['入住', '指南'], reply: '点击下方菜单「关于我们-入住指南」查看～' },
  { keywords: ['客服', '人工'], reply: '点击下方菜单「我的服务-联系客服」，或到 H5 售后中心反馈～' },
  { keywords: ['你好', 'hi', 'hello'], reply: '您好，欢迎来到智宿管家！回复 订单/优惠/入住/客服 或点击下方菜单～' },
];

/** 默认回复（【种子默认值】见 SUBSCRIBE_REPLY 说明） */
export const DEFAULT_REPLY = '您可以回复：订单 / 优惠 / 入住 / 客服，或点击下方菜单';
