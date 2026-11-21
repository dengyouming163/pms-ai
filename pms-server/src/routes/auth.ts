import { Hono } from 'hono';
import { z } from 'zod';
import { db } from '../db/index.js';
import { pmsBuiStaff, pmsBuiRoles, pmsBuiStores, pmsBuiStaffStorePermissions } from '../db/schema/index.js';
import { pmsBuiSessions } from '../db/schema/sessions.js';
import { eq, and, desc, sql } from 'drizzle-orm';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { validateBody } from '../utils/validate.js';
import { JWT_SECRET } from '../constants.js';
import { isAllStoresScope } from '../utils/scope.js';
import { sendSmsCode } from '../services/sms.js';
import { serverError } from '../lib/http-error.js';

const auth = new Hono();
const TOKEN_EXPIRES = '7d';

// 短信验证码内存存储（phone -> {code, expires}），5分钟过期
const smsCodeStore = new Map<string, { code: string; expires: number }>();
const SMS_CODE_EXPIRES = 5 * 60 * 1000; // 5 分钟

function generateSmsCode(): string {
  return String(Math.floor(100000 + Math.random() * 900000)); // 6位数字
}

function verifySmsCode(phone: string, code: string): boolean {
  const record = smsCodeStore.get(phone);
  if (!record) return false;
  if (Date.now() > record.expires) {
    smsCodeStore.delete(phone);
    return false;
  }
  if (record.code !== code) return false;
  smsCodeStore.delete(phone); // 一次性使用
  return true;
}

// Zod 请求体验证 schema
const loginSchema = z.object({
  phone: z.string().min(1, '请输入手机号'),
  password: z.string().optional(),
  code: z.string().optional(),
});

const changePasswordSchema = z.object({
  oldPassword: z.string().min(1, '请输入原密码'),
  newPassword: z.string().min(6, '新密码至少6位'),
});

const sendSmsSchema = z.object({
  phone: z.string().min(1, '请输入手机号'),
});

const switchRoleSchema = z.object({
  roleType: z.string().min(1, '请指定角色类型'),
});

// POST /api/auth/login（支持密码登录和短信验证码登录）
auth.post('/login', async (c) => {
  try {
    const body = await c.req.json();
    const validation = await validateBody(body, loginSchema);
    if (!validation.success) {
      return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
    }
    const { phone, password, code } = validation.data;

    // 查找用户
    const users = await db.select().from(pmsBuiStaff).where(eq(pmsBuiStaff.phone, phone)).limit(1);
    const user = users[0];

    if (!user) {
      return c.json({ success: false, error: '账号不存在' }, 401);
    }

    if (user.status !== 'active') {
      return c.json({ success: false, error: '账号已被禁用，请联系管理员' }, 403);
    }

    // 短信验证码登录
    if (code) {
      if (!verifySmsCode(phone, String(code))) {
        return c.json({ success: false, error: '验证码错误或已过期' }, 401);
      }
    } else if (password) {
      // 密码登录
      const isValid = await bcrypt.compare(password, user.password);
      if (!isValid) {
        return c.json({ success: false, error: '密码错误' }, 401);
      }
    } else {
      return c.json({ success: false, error: '请输入密码或验证码' }, 400);
    }

    // 加载用户角色权限（requirePermission 优先读 JWT.permissions；预置超管 role_admin 无对应角色行时授予全权限）
    let rolePerms: string[] = [];
    if (user.roleId) {
      const [role] = await db.select({ permissions: pmsBuiRoles.permissions })
        .from(pmsBuiRoles).where(eq(pmsBuiRoles.id, user.roleId)).limit(1);
      rolePerms = (role?.permissions as string[]) || [];
      if (rolePerms.length === 0 && user.roleId === 'role_admin') rolePerms = ['all'];
    }

    // 生成 JWT
    const token = jwt.sign(
      {
        userId: user.id,
        name: user.name,
        phone: user.phone,
        roleId: user.roleId,
        scope: user.scope,
        merchantId: user.merchantId,
        permissions: rolePerms,
      },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES }
    );

    // 更新最后登录时间
    await db.update(pmsBuiStaff)
      .set({ lastLoginAt: new Date() })
      .where(eq(pmsBuiStaff.id, user.id));

    // 记录登录会话
    const sessionId = `sess_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const userAgent = c.req.header('User-Agent') || '未知设备';
    const clientIp = c.req.header('X-Forwarded-For') || c.req.header('X-Real-IP') || '0.0.0.0';

    // 解析设备信息
    let device = '未知设备';
    if (userAgent.includes('Chrome')) device = 'Chrome';
    else if (userAgent.includes('Safari')) device = 'Safari';
    else if (userAgent.includes('Firefox')) device = 'Firefox';
    if (userAgent.includes('Windows')) device += ' / Windows';
    else if (userAgent.includes('Mac')) device += ' / macOS';
    else if (userAgent.includes('iPhone')) device += ' / iPhone';
    else if (userAgent.includes('Android')) device += ' / Android';

    // 将该用户之前的会话标记为非当前
    await db.update(pmsBuiSessions)
      .set({ current: false })
      .where(eq(pmsBuiSessions.userId, user.id));

    await db.insert(pmsBuiSessions).values({
      id: sessionId,
      userId: user.id,
      device,
      ip: clientIp,
      token,
      current: true,
      createdAt: new Date(),
      lastActiveAt: new Date(),
    });

    // 获取当前账号可见的门店列表：
    //   tenant/全部门店  → 商户下所有门店（兼容历史中文值）
    //   brand   → 同品牌下的门店
    //   store   → 从 pms_bui_staff_store_permissions 关联查询
    let userStores: Array<{ id: string; name: string }> = [];
    const mId = user.merchantId || 'default';

    if (isAllStoresScope(user.scope)) {
      userStores = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
        .from(pmsBuiStores)
        .where(eq(pmsBuiStores.merchantId, mId));
    } else if (user.scope === 'brand') {
      // 取该员工所属品牌的门店（通过 staff 表的 brand 关联或 stores 字段中的 brandId）
      userStores = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
        .from(pmsBuiStores)
        .where(and(eq(pmsBuiStores.merchantId, mId), eq(pmsBuiStores.brandId, 'default')));
    } else {
      // store 级：从权限关联表查已分配的门店
      const rows = await db.select({ id: pmsBuiStores.id, name: pmsBuiStores.name })
        .from(pmsBuiStaffStorePermissions)
        .innerJoin(pmsBuiStores, eq(pmsBuiStaffStorePermissions.storeId, pmsBuiStores.id))
        .where(eq(pmsBuiStaffStorePermissions.staffId, user.id));
      userStores = rows;
    }

    return c.json({
      success: true,
      data: {
        token,
        userInfo: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          avatar: user.avatar,
          role: user.roleName || 'staff',
          storeId: userStores?.[0]?.id,
          storeName: userStores?.[0]?.name,
        },
        stores: userStores,
      },
    });
  } catch (error: unknown) {
    console.error('[auth/login]', error);
    const msg = error instanceof Error ? error.message : '登录失败';
    return c.json({ success: false, error: msg }, 500);
  }
});

// GET /api/auth/me - 获取当前用户信息
auth.get('/me', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: '未登录' }, 401);
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; phone: string };

    const users = await db.select().from(pmsBuiStaff).where(eq(pmsBuiStaff.id, decoded.userId)).limit(1);
    const user = users[0];

    if (!user || user.status !== 'active') {
      return c.json({ success: false, error: '用户不存在或已禁用' }, 401);
    }

    const roles = await db.select().from(pmsBuiRoles).where(eq(pmsBuiRoles.id, user.roleId)).limit(1);
    const role = roles[0];

    return c.json({
      success: true,
      data: {
        id: user.id,
        name: user.name,
        phone: user.phone,
        email: user.email,
        avatar: user.avatar,
        department: user.department,
        position: user.position,
        roleName: user.roleName,
        roleId: user.roleId,
        scope: user.scope,
        merchantId: user.merchantId,
        stores: user.stores,
        role: role ? {
          id: role.id,
          name: role.name,
          scope: role.scope,
          permissions: role.permissions,
        } : null,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Token无效或已过期' }, 401);
  }
});

// POST /api/auth/reset-password — 短信验证码重置密码
auth.post('/reset-password', async (c) => {
  const { phone, code, newPassword } = await c.req.json() as any;
  if (!phone || !code || !newPassword) return c.json({ success: false, error: '缺少参数' }, 400);
  if (newPassword.length < 6) return c.json({ success: false, error: '新密码至少6位' }, 400);
  if (!verifySmsCode(phone, String(code))) return c.json({ success: false, error: '验证码错误或已过期' }, 400);
  const users = await db.select().from(pmsBuiStaff).where(eq(pmsBuiStaff.phone, phone)).limit(1);
  if (!users[0]) return c.json({ success: false, error: '用户不存在' }, 404);
  const hashed = await bcrypt.hash(newPassword, 10);
  await db.update(pmsBuiStaff).set({ password: hashed }).where(eq(pmsBuiStaff.id, users[0].id));
  return c.json({ success: true, message: '密码修改成功' });
});

// POST /api/auth/change-password
auth.post('/change-password', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: '未登录' }, 401);
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    const body = await c.req.json();
    const validation = await validateBody(body, changePasswordSchema);
    if (!validation.success) {
      return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
    }
    const { oldPassword, newPassword } = validation.data;

    const users = await db.select().from(pmsBuiStaff).where(eq(pmsBuiStaff.id, decoded.userId)).limit(1);
    const user = users[0];

    if (!user) {
      return c.json({ success: false, error: '用户不存在' }, 401);
    }

    const isValid = await bcrypt.compare(oldPassword, user.password);
    if (!isValid) {
      return c.json({ success: false, error: '原密码错误' }, 401);
    }

    const hashedPassword = await bcrypt.hash(newPassword, 10);
    await db.update(pmsBuiStaff)
      .set({ password: hashedPassword, updatedAt: new Date() })
      .where(eq(pmsBuiStaff.id, decoded.userId));

    return c.json({ success: true, message: '密码修改成功' });
  } catch {
    return c.json({ success: false, error: 'Token无效或已过期' }, 401);
  }
});

// POST /api/auth/send-sms
auth.post('/send-sms', async (c) => {
  try {
    const body = await c.req.json();
    const validation = await validateBody(body, sendSmsSchema);
    if (!validation.success) {
      return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
    }
    const { phone } = validation.data;

    // 校验手机号是否已开通
    const [staff] = await db.select({ id: pmsBuiStaff.id, status: pmsBuiStaff.status })
      .from(pmsBuiStaff).where(eq(pmsBuiStaff.phone, phone)).limit(1);
    if (!staff) {
      return c.json({ success: false, error: '该手机号尚未开通，请先完成商户入驻' }, 400);
    }
    if (staff.status !== 'active') {
      return c.json({ success: false, error: '该账号已被禁用，请联系管理员' }, 403);
    }

    const code = generateSmsCode();
    smsCodeStore.set(phone, {
      code,
      expires: Date.now() + SMS_CODE_EXPIRES,
    });

    // 调用阿里云短信服务发送验证码
    try {
      await sendSmsCode(phone, code);
    } catch (smsErr: any) {
      console.error('[SMS] 短信发送失败:', smsErr.message);
      return c.json({ success: false, error: '短信发送失败，请稍后重试' }, 500);
    }

    return c.json({ success: true, message: '验证码发送成功' });
  } catch {
    return c.json({ success: false, error: '发送失败' }, 500);
  }
});

// POST /api/auth/logout
auth.post('/logout', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (authHeader?.startsWith('Bearer ')) {
      const token = authHeader.substring(7);
      // 标记该 token 对应的 session 为非活跃
      await db.update(pmsBuiSessions)
        .set({ current: false })
        .where(eq(pmsBuiSessions.token, token));
    }
    return c.json({ success: true, message: '退出成功' });
  } catch {
    return c.json({ success: true, message: '退出成功' });
  }
});

// GET /api/auth/sessions — 获取当前用户活跃会话
auth.get('/sessions', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: '未登录' }, 401);
    }
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    const sessions = await db.select().from(pmsBuiSessions)
      .where(eq(pmsBuiSessions.userId, decoded.userId))
      .orderBy(desc(pmsBuiSessions.lastActiveAt));

    const formatted = sessions.map(s => ({
      id: s.id,
      device: s.device,
      ip: s.ip,
      time: s.current ? '当前会话' : formatRelativeTime(s.lastActiveAt),
      current: s.current,
    }));

    return c.json({ success: true, data: formatted });
  } catch (err: any) {
    // 原 console.error 只带静态标签且传的是 err.message（丢堆栈），
    // serverError 内部会 console.error 完整错误对象，故删去避免重复日志
    return serverError(c, err, '获取会话失败');
  }
});

// 辅助函数：格式化相对时间
function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - new Date(date).getTime();
  const diffMins = Math.floor(diffMs / 60000);
  if (diffMins < 60) return `${diffMins}分钟前`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}小时前`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}天前`;
}

// POST /api/auth/sessions — 撤销指定会话
auth.post('/sessions', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: '未登录' }, 401);
    }
    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string };

    const body = await c.req.json();
    const { action, sessionId } = body;

    if (action === 'revoke' && sessionId) {
      const [session] = await db.select().from(pmsBuiSessions)
        .where(and(eq(pmsBuiSessions.id, sessionId), eq(pmsBuiSessions.userId, decoded.userId)));
      if (!session) {
        return c.json({ success: false, error: '会话不存在' }, 404);
      }
      await db.delete(pmsBuiSessions).where(eq(pmsBuiSessions.id, sessionId));
      return c.json({ success: true, message: '会话已撤销' });
    }

    return c.json({ success: false, error: '无效操作' }, 400);
  } catch {
    return c.json({ success: false, error: '操作失败' }, 500);
  }
});

// POST /api/auth/switch-role
auth.post('/switch-role', async (c) => {
  try {
    const authHeader = c.req.header('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return c.json({ success: false, error: '未登录' }, 401);
    }

    const token = authHeader.substring(7);
    const decoded = jwt.verify(token, JWT_SECRET) as { userId: string; roleId: string; phone: string; scope: string };

    const body = await c.req.json();
    const validation = await validateBody(body, switchRoleSchema);
    if (!validation.success) {
      return c.json({ success: false, error: `参数校验失败: ${validation.error}` }, 400);
    }
    const { roleType } = validation.data;

    // 查询用户信息
    const users = await db.select().from(pmsBuiStaff).where(eq(pmsBuiStaff.id, decoded.userId)).limit(1);
    const user = users[0];

    if (!user) {
      return c.json({ success: false, error: '用户不存在' }, 401);
    }

    if (user.status !== 'active') {
      return c.json({ success: false, error: '账号已被禁用' }, 403);
    }

    // 校验请求的角色是否存在，且用户有权使用
    const [targetRole] = await db.select().from(pmsBuiRoles).where(eq(pmsBuiRoles.name, roleType)).limit(1);

    if (!targetRole) {
      return c.json({ success: false, error: '无效的角色类型' }, 400);
    }

    // 验证用户当前角色与目标角色是否匹配（用户只能切换到自己的角色）
    if (user.roleId !== targetRole.id) {
      return c.json({ success: false, error: '您没有权限切换到此角色' }, 403);
    }

    // 重新签发 JWT（含正确角色信息与权限）
    const newToken = jwt.sign(
      {
        userId: user.id,
        name: user.name,
        phone: user.phone,
        roleId: targetRole.id,
        scope: targetRole.scope,
        merchantId: user.merchantId,
        permissions: targetRole.permissions as string[],
      },
      JWT_SECRET,
      { expiresIn: TOKEN_EXPIRES }
    );

    return c.json({
      success: true,
      data: {
        token: newToken,
        userInfo: {
          id: user.id,
          name: user.name,
          phone: user.phone,
          avatar: user.avatar,
          role: targetRole.name,
          roleId: targetRole.id,
          stores: user.stores || [],
        },
        stores: user.stores || [],
      },
    });
  } catch {
    return c.json({ success: false, error: 'Token无效或已过期' }, 401);
  }
});

export default auth;
