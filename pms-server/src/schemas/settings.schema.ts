import { z } from 'zod';

// ============ 基础信息 ============

export const BasicSettingsSchema = z.object({
  name: z.string(),
  shortName: z.string(),
  phone: z.string(),
  email: z.string(),
  address: z.string(),
  website: z.string(),
  description: z.string(),
  logo: z.string(),
  businessLicense: z.string(),
  legalPerson: z.string(),
}).describe('基础信息');

// ============ 业务参数 ============

export const BookingSettingsSchema = z.object({
  advanceDays: z.number(),
  maxAdvanceDays: z.number(),
  cancelDeadline: z.string(),
  cancelFeeRate: z.number(),
  noShowFeeRate: z.number(),
  requireGuarantee: z.boolean(),
  guaranteeAmount: z.number(),
  autoConfirm: z.boolean(),
  allowOverBooking: z.boolean(),
  overBookingRate: z.number(),
}).describe('预订设置');

export const CheckInSettingsSchema = z.object({
  checkInTime: z.string(),
  checkOutTime: z.string(),
  earlyCheckInFee: z.number(),
  lateCheckOutFee: z.number(),
  requireDeposit: z.boolean(),
  depositAmount: z.number(),
  allowEarlyCheckIn: z.boolean(),
  allowLateCheckOut: z.boolean(),
  idCardRequired: z.boolean(),
  faceRecognition: z.boolean(),
}).describe('入住设置');

export const BusinessSettingsSchema = z.object({
  booking: BookingSettingsSchema,
  checkIn: CheckInSettingsSchema,
}).describe('业务参数');

// ============ 订阅管理 ============

export const SubscriptionSchema = z.object({
  plan: z.string(),
  planName: z.string(),
  status: z.enum(['active', 'expired', 'trial']),
  startDate: z.string(),
  endDate: z.string(),
  autoRenew: z.boolean(),
  modules: z.array(z.string()),
  storeLimit: z.number(),
  usedStores: z.number(),
  roomLimit: z.number(),
  usedRooms: z.number(),
  staffLimit: z.number(),
  usedStaff: z.number(),
}).describe('订阅信息');

// ============ 安全设置 ============

export const SecuritySettingsSchema = z.object({
  passwordPolicy: z.object({
    minLength: z.number(),
    requireUppercase: z.boolean(),
    requireLowercase: z.boolean(),
    requireNumber: z.boolean(),
    requireSpecialChar: z.boolean(),
    expiryDays: z.number(),
  }),
  loginPolicy: z.object({
    maxAttempts: z.number(),
    lockDuration: z.number(),
    sessionTimeout: z.number(),
    twoFactorAuth: z.boolean(),
    ipWhitelist: z.array(z.string()),
  }),
  dataPolicy: z.object({
    backupFrequency: z.string(),
    retentionDays: z.number(),
    encryptionEnabled: z.boolean(),
    auditLogRetention: z.number(),
  }),
}).describe('安全设置');

// ============ 查询参数 ============

export const SettingsQuerySchema = z.object({
  type: z.enum(['basic', 'business', 'subscription', 'security']).describe('设置类型'),
}).describe('设置查询参数');

// ============ 路由定义 ============

export const getSettings = {
  method: 'get' as const,
  path: '/',
  summary: '获取系统设置',
  description: '根据type返回基础信息/业务参数/订阅/安全设置',
  tags: ['系统设置'],
  request: { query: SettingsQuerySchema },
  responses: {
    200: { description: '设置数据', content: { 'application/json': { schema: z.any() } } },
  },
};

export const updateSettings = {
  method: 'post' as const,
  path: '/',
  summary: '更新系统设置',
  description: '保存设置变更',
  tags: ['系统设置'],
  request: {
    body: { content: { 'application/json': { schema: z.any() } } },
  },
  responses: {
    200: { description: '更新成功', content: { 'application/json': { schema: z.object({ success: z.boolean(), message: z.string() }) } } },
  },
};
