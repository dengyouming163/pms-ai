/**
 * 公众号自定义菜单（miniprogram 跳小程序，url 保留作为老版本微信降级打开 H5）。
 * 【种子默认值】菜单配置已后台化：首次 GET /api/admin/mp-config 会以此初始化 pms_bui_mp_config.menu，
 * 运营可在平台后台修改；回调/同步菜单读 DB（services/mp-reply.ts getMpConfig），无配置时回落本常量。
 * appid = WX_MINI_APPID（小程序 AppID，与 pms-nimi manifest.json mp-weixin.appid 一致）；
 * pagepath 对应 pms-nimi pages.json 的小程序页面路径。
 */
export const MP_MENU = {
  button: [
    {
      name: '精选民宿',
      sub_button: [
        { type: 'miniprogram', name: '精选民宿', url: 'https://pmsapi.kyyp.cn/h5/', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/discover/index' },
        { type: 'miniprogram', name: '需求匹配', url: 'https://pmsapi.kyyp.cn/h5/#/pages/match/index', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/match/index' },
        { type: 'miniprogram', name: '我的优惠', url: 'https://pmsapi.kyyp.cn/h5/#/pages/mine/coupons', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/mine/coupons' },
      ],
    },
    {
      name: '我的服务',
      sub_button: [
        { type: 'miniprogram', name: '我的订单', url: 'https://pmsapi.kyyp.cn/h5/#/pages/orders/index', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/orders/index' },
        { type: 'miniprogram', name: '售后中心', url: 'https://pmsapi.kyyp.cn/h5/#/pages/mine/service', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/mine/service' },
        { type: 'miniprogram', name: '联系客服', url: 'https://pmsapi.kyyp.cn/h5/#/pages/mine/service', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/mine/service' },
      ],
    },
    {
      name: '关于我们',
      sub_button: [
        { type: 'miniprogram', name: '民宿合集', url: 'https://pmsapi.kyyp.cn/h5/#/pages/discover/index', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/discover/index' },
        { type: 'miniprogram', name: '入住指南', url: 'https://pmsapi.kyyp.cn/h5/#/pages/store/home', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/orders/guide' },
        { type: 'miniprogram', name: '帮助反馈', url: 'https://pmsapi.kyyp.cn/h5/#/pages/mine/terms', appid: 'wx0e5fc1f7fa23d1fe', pagepath: 'pages/mine/terms' },
      ],
    },
  ],
};
