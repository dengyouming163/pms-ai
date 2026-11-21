import { z } from 'zod';

// 订单上报单条记录
export const otaOrderSchema = z.object({
  source: z.enum(['meituan', 'ctrip']),
  sourceOrderId: z.string().min(1).max(128),
  sourceStoreId: z.string().max(128).optional(),
  guestName: z.string().min(1).max(128),
  guestPhone: z.string().max(32),
  roomType: z.string().max(256),
  roomCount: z.number().int().min(1).default(1),
  checkIn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  checkOut: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  totalAmount: z.number().min(0),
  status: z.enum(['new', 'confirmed', 'checked_in', 'cancelled', 'completed']),
  breakfast: z.boolean().optional(),
  remark: z.string().optional(),
  guestIdNumber: z.string().max(64).optional(),
  createdAt: z.string().datetime({ offset: true }),
  updatedAt: z.string().datetime({ offset: true }).optional(),
  capturedAt: z.string().datetime({ offset: true }),
  clientVersion: z.string().max(16),
  commission: z.number().min(0).optional(),
  arrivalTime: z.string().max(30).optional(),
  orderLabel: z.string().max(20).optional(),
});

// 批量上报请求体
export const otaOrdersBatchSchema = z.object({
  orders: z.array(otaOrderSchema).min(1).max(100),
});

// 心跳上报请求体
export const otaHeartbeatSchema = z.object({
  storeId: z.string().min(1).max(64),
  platform: z.enum(['meituan', 'ctrip']),
  clientVersion: z.string().max(16),
  deviceId: z.string().min(1).max(128),
  sessionValid: z.boolean(),
  lastCaptureAt: z.string().datetime({ offset: true }).optional(),
  lastCaptureCount: z.number().int().min(0).optional(),
  lastError: z.string().optional(),
  status: z.enum(['ok', 'error', 'session_expired']),
});

// 心跳响应
export const otaHeartbeatResponseSchema = z.object({
  ok: z.boolean(),
  serverTime: z.string(),
  capture: z.object({
    minIntervalMin: z.number(),
    maxIntervalMin: z.number(),
    enabled: z.boolean(),
  }),
});
