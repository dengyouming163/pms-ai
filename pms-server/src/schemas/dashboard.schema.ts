import { z } from 'zod';

// ============ 子模型 ============

export const TodoItemSchema = z.object({
  id: z.string().describe('待办ID'),
  type: z.enum(['order', 'review', 'task', 'subscription']).describe('待办类型'),
  title: z.string().describe('待办标题'),
  count: z.number().describe('待办数量'),
}).describe('待办事项');

export const WeeklyTrendItemSchema = z.object({
  date: z.string().describe('日期'),
  revenue: z.number().describe('营收'),
  rooms: z.number().describe('售出房间数'),
  occupancyRate: z.number().describe('入住率(%)'),
  revpar: z.number().describe('RevPAR'),
}).describe('周趋势数据');

// ============ 响应 ============

export const DashboardResponseSchema = z.object({
  todayRevenue: z.number().describe('今日营收'),
  revenueChange: z.number().describe('营收环比变化(%)'),
  soldRooms: z.number().describe('已售房间数'),
  totalRooms: z.number().describe('总房间数'),
  occupancyRate: z.number().describe('入住率(%)'),
  occupancyChange: z.number().describe('入住率环比变化(%)'),
  adr: z.number().describe('平均房价ADR'),
  adrChange: z.number().describe('ADR环比变化(%)'),
  revpar: z.number().describe('RevPAR'),
  revparChange: z.number().describe('RevPAR环比变化(%)'),
  pendingOrders: z.number().describe('待处理订单数'),
  expectedArrivals: z.number().describe('今日预计到店间数(预抵)'),
  inHouse: z.number().describe('当前在住房间数(在住)'),
  expectedDepartures: z.number().describe('今日预计离店间数(预离)'),
  availableRooms: z.number().describe('当前可售房间数(可售)'),
  todos: z.array(TodoItemSchema).describe('待办事项列表'),
  weeklyTrend: z.array(WeeklyTrendItemSchema).describe('近7天经营趋势'),
}).describe('工作台数据');

// ============ 路由定义 ============

export const getDashboard = {
  method: 'get' as const,
  path: '/',
  summary: '获取工作台数据',
  description: '返回KPI指标、待办事项、周趋势等工作台全部数据',
  tags: ['工作台'],
  responses: {
    200: {
      description: '工作台数据',
      content: {
        'application/json': {
          schema: DashboardResponseSchema,
        },
      },
    },
  },
};
