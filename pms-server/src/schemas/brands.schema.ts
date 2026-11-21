import { z } from 'zod';

// ============ 子模型 ============

export const BrandSchema = z.object({
  id: z.string().describe('品牌ID'),
  name: z.string().describe('品牌名称'),
  logo: z.string().describe('品牌Logo'),
  storeCount: z.number().describe('旗下门店数'),
  totalRooms: z.number().describe('总房间数'),
  contactName: z.string().describe('联系人'),
  contactPhone: z.string().describe('联系电话'),
  status: z.enum(['active', 'inactive']).describe('状态'),
  createdAt: z.string().describe('创建时间'),
  description: z.string().describe('品牌描述'),
}).describe('品牌');

// ============ 响应 ============

export const BrandListResponseSchema = z.object({
  brands: z.array(BrandSchema).describe('品牌列表'),
}).describe('品牌列表');

export const BrandCreateRequestSchema = z.object({
  name: z.string().describe('品牌名称'),
  logo: z.string().optional().describe('品牌Logo'),
  contactName: z.string().optional().describe('联系人'),
  contactPhone: z.string().optional().describe('联系电话'),
  description: z.string().optional().describe('品牌描述'),
}).describe('创建品牌请求');

// ============ 路由定义 ============

export const getBrands = {
  method: 'get' as const,
  path: '/',
  summary: '获取品牌列表',
  description: '返回所有品牌及其门店统计信息',
  tags: ['品牌管理'],
  responses: {
    200: {
      description: '品牌列表',
      content: { 'application/json': { schema: z.any() } },
    },
  },
};

export const createBrand = {
  method: 'post' as const,
  path: '/',
  summary: '创建品牌',
  description: '创建新品牌',
  tags: ['品牌管理'],
  request: {
    body: {
      content: { 'application/json': { schema: z.any() } },
    },
  },
  responses: {
    200: {
      description: '创建成功',
      content: { 'application/json': { schema: z.any() } },
    },
  },
};
