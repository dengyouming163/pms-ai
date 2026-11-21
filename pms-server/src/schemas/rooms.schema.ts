import { z } from 'zod';

// ============ 子模型 ============

export const DailyRoomSchema = z.object({
  id: z.string(),
  roomTypeId: z.string(),
  roomTypeName: z.string(),
  roomNumber: z.string(),
  floor: z.number(),
  status: z.enum(['available', 'occupied', 'dirty', 'maintenance', 'locked', 'booked']),
  price: z.number(),
  guestName: z.string().optional(),
  checkInDate: z.string().optional(),
  checkOutDate: z.string().optional(),
  bookingSource: z.string().optional(),
  remark: z.string().optional(),
}).describe('日房态房间');

export const DailySummarySchema = z.object({
  total: z.number(),
  available: z.number(),
  booked: z.number(),
  occupied: z.number(),
  dirty: z.number(),
  maintenance: z.number(),
  locked: z.number(),
  occupancyRate: z.number(),
}).describe('日房态汇总');

export const MonthlyRoomTypeSchema = z.object({
  roomTypeId: z.string(),
  roomTypeName: z.string(),
  totalRooms: z.number(),
  dailyStatus: z.array(z.object({
    date: z.string(),
    day: z.number(),
    total: z.number(),
    available: z.number(),
    booked: z.number(),
    occupied: z.number(),
    blocked: z.number(),
    isWeekend: z.boolean(),
    isPast: z.boolean(),
    isToday: z.boolean(),
  })),
}).describe('月房态房型');

export const MonthSummarySchema = z.object({
  totalRooms: z.number(),
  todayOccupied: z.number(),
  todayBooked: z.number(),
  todayAvailable: z.number(),
  todayOccupancyRate: z.number(),
  avgOccupancyRate: z.number(),
}).describe('月汇总');

// ============ 查询参数 ============

export const RoomQuerySchema = z.object({
  type: z.enum(['daily', 'monthly', 'bookings']).describe('查询类型'),
  date: z.string().optional().describe('日期(日房态)'),
  year: z.string().optional().describe('年份(月房态)'),
  month: z.string().optional().describe('月份(月房态)'),
}).describe('房态查询参数');

// ============ 响应 ============

export const DailyRoomResponseSchema = z.object({
  rooms: z.array(DailyRoomSchema),
  summary: DailySummarySchema,
  floors: z.array(z.number()),
}).describe('日房态响应');

export const MonthlyRoomResponseSchema = z.object({
  roomTypes: z.array(MonthlyRoomTypeSchema),
  monthSummary: MonthSummarySchema,
}).describe('月房态响应');

// ============ 路由定义 ============

export const getRooms = {
  method: 'get' as const,
  path: '/',
  summary: '获取房态数据',
  description: '根据type参数返回日房态/月房态/预订数据',
  tags: ['房态管理'],
  request: {
    query: RoomQuerySchema,
  },
  responses: {
    200: {
      description: '房态数据',
      content: {
        'application/json': {
          schema: z.union([DailyRoomResponseSchema, MonthlyRoomResponseSchema]),
        },
      },
    },
  },
};
