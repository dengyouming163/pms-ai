/**
 * pms-server 内部短信接口 —— 供平台服务代发验证码
 * 注册场景验证码由平台侧生成并存储，本接口仅负责调用阿里云短信发送
 * （与 /api/auth/send-sms 登录场景不同：注册允许任意手机号，不做已开通账号校验）
 */
import { Hono } from 'hono';
import { z } from 'zod';
import { sendSmsCode } from '../../services/sms.js';

const route = new Hono();

/** 代发验证码请求校验 */
const sendSchema = z.object({
  phone: z.string().regex(/^1[3-9]\d{9}$/, '手机号格式不正确'),
  code: z.string().regex(/^\d{4,6}$/, '验证码格式不正确'),
});

/**
 * POST /api/internal/sms/send — 发送验证码短信
 */
route.post('/send', async (c) => {
  const parsed = sendSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) {
    return c.json({ success: false, error: parsed.error.issues[0].message }, 400);
  }

  const { phone, code } = parsed.data;

  try {
    await sendSmsCode(phone, code);
  } catch (err: any) {
    console.error('[internal-sms] 短信发送失败:', err.message);
    return c.json({ success: false, error: '短信发送失败，请稍后重试' }, 502);
  }

  return c.json({ success: true, message: '验证码发送成功' });
});

export default route;
