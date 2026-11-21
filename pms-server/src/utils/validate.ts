import type { ZodSchema } from 'zod';

/**
 * 校验请求体是否符合Zod Schema。
 * 校验通过返回解析后的数据；失败返回null并通过c.json返回400错误。
 */
export async function validateBody<T>(body: unknown, schema: ZodSchema<T>): Promise<{ success: true; data: T } | { success: false; error: string }> {
  const result = schema.safeParse(body);
  if (!result.success) {
    const messages = result.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
    return { success: false, error: messages };
  }
  return { success: true, data: result.data };
}
