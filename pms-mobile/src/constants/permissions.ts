export interface MenuItem {
  path: string
  icon: string
  text: string
  badge?: number | (() => number)
}

export const ROLE_PERMISSIONS: Record<string, string[]> = {
  owner: ['dashboard', 'approval', 'employee', 'notification', 'settings'],
  admin: ['dashboard', 'approval', 'employee', 'notification', 'settings'],
  manager: ['dashboard', 'approval', 'employee', 'notification', 'settings'],
  assistant: ['orders', 'performance', 'notification', 'checkin', 'settings', 'schedule'],
  employee: ['checkin', 'notification', 'apply', 'settings', 'schedule']
}

export const MENU_CONFIG: Record<string, MenuItem[]> = {
  owner: [
    { path: '/pages/index/index', icon: '🏠', text: '首页' },
    { path: '/pages/notification/index', icon: '🔔', text: '通知' },
    { path: '/pages/approval/index', icon: '📋', text: '审批' },
    { path: '/pages/profile/index', icon: '👤', text: '我' }
  ],
  admin: [
    { path: '/pages/index/index', icon: '🏠', text: '首页' },
    { path: '/pages/notification/index', icon: '🔔', text: '通知' },
    { path: '/pages/approval/index', icon: '📋', text: '审批' },
    { path: '/pages/profile/index', icon: '👤', text: '我' }
  ],
  manager: [
    { path: '/pages/index/index', icon: '🏠', text: '首页' },
    { path: '/pages/notification/index', icon: '🔔', text: '通知' },
    { path: '/pages/approval/index', icon: '📋', text: '审批' },
    { path: '/pages/profile/index', icon: '👤', text: '我' }
  ],
  assistant: [
    { path: '/pages/index/index', icon: '📱', text: '订单' },
    { path: '/pages/notification/index', icon: '🔔', text: '通知' },
    { path: '/pages/performance/index', icon: '📊', text: '统计' },    
    { path: '/pages/checkin/index', icon: '📍', text: '打卡' },
    { path: '/pages/profile/index', icon: '👤', text: '我' }
  ],
  employee: [
    { path: '/pages/index/index', icon: '🏠', text: '首页' },
    { path: '/pages/checkin/index', icon: '📍', text: '打卡' },
    { path: '/pages/notification/index', icon: '🔔', text: '通知' },
    { path: '/pages/profile/index', icon: '👤', text: '我' }
  ]
}

export const PAGE_TITLE: Record<string, string> = {
  '/pages/index/index': '数据看板',
  '/pages/notification/index': '预警通知',
  '/pages/notification/detail': '通知详情',
  '/pages/approval/index': '审批中心',
  '/pages/approval/detail': '审批详情',
  '/pages/employee/list': '员工列表',
  '/pages/employee/detail': '员工详情',
  '/pages/orders/index': '接单中心',
  '/pages/orders/active': '进行中订单',
  '/pages/performance/index': '我的业绩',
  '/pages/checkin/index': '打卡签到',
  '/pages/checkin/record': '打卡记录',
  '/pages/checkin/outwork': '外勤申请',
  '/pages/schedule/index': '排班查询',
  '/pages/apply/checkin': '补签申请',
  '/pages/apply/leave': '请假申请',
  '/pages/apply/record': '申请记录',
  '/pages/profile/index': '个人资料',
  '/pages/settings/index': '设置',
  '/pages/settings/about': '关于'
}
