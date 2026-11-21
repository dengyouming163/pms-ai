import { Hono } from 'hono';
import bcrypt from 'bcryptjs';
import { db } from '../../db/index.js';
import { pmsBuiRoles, pmsBuiStaff, pmsBuiBrands, pmsBuiStores, pmsBuiStaffStorePermissions } from '../../db/schema/index.js';
import { PRESET_ROLE_PERMISSIONS } from '../../utils/permissions.js';
import { serverError } from '../../lib/http-error.js';

const route = new Hono();

/**
 * PUT /api/internal/merchants/init
 * 平台审核通过商户后，初始化该商户的种子数据（角色、管理员、品牌）
 * 需 internalAuthMiddleware 验证 X-Internal-Service-Token
 */
route.put('/', async (c) => {
  const body = await c.req.json();
  const { merchantId, companyName, contactName, contactPhone } = body;

  if (!merchantId || !companyName || !contactName) {
    return c.json({ success: false, error: '缺少必要参数' }, 400);
  }

  const now = new Date();
  const ts = Date.now();

  try {
    await db.transaction(async (tx) => {
      // 1. 创建默认品牌
      const brandId = `brand-${ts}`;
      await tx.insert(pmsBuiBrands).values({
        id: brandId,
        merchantId,
        name: companyName,
        type: 'brand',
        status: 'active',
        contactName: contactName || null,
        contactPhone: contactPhone || null,
      });

      // 2. 创建默认门店
      const storeId = `store-${ts}`;
      await tx.insert(pmsBuiStores).values({
        id: storeId,
        merchantId,
        brandId,
        brandName: companyName,
        name: `${companyName}总店`,
        address: '',
        phone: contactPhone || '',
        status: 'active',
        roomCount: 0,
      });

      // 3. 创建 5 个预置角色
      const roleNames = ['超级管理员', '酒店经理', '前台接待', '财务专员', '渠道运营'];
      const roleScopes = ['tenant', 'store', 'store', 'brand', 'brand'];
      const roles = roleNames.map((name, i) => ({
        id: `role-${ts}-${i + 1}`,
        name,
        scope: roleScopes[i],
        permissions: PRESET_ROLE_PERMISSIONS[name] || [],
        isPreset: true,
      }));

      for (const r of roles) {
        await tx.insert(pmsBuiRoles).values({
          ...r,
          merchantId,
          staffCount: 0,
        });
      }

      // 4. 创建初始管理员员工（默认密码 888888）
      const staffId = `staff-${ts}`;
      const hashedPassword = await bcrypt.hash('888888', 10);
      await tx.insert(pmsBuiStaff).values({
        id: staffId,
        merchantId,
        name: contactName,
        phone: contactPhone || '',
        department: '管理部',
        position: '管理员',
        roleName: '超级管理员',
        roleId: roles[0].id,
        scope: 'tenant',
        status: 'active',
        password: hashedPassword,  // 默认密码 888888，首次登录后可修改
      });

      // 5. 关联管理员 → 门店
      await tx.insert(pmsBuiStaffStorePermissions).values({
        id: `ssp-${ts}`,
        merchantId,
        staffId,
        storeId,
      });
    });

    return c.json({ success: true, merchantId, message: '商户数据初始化成功' });
  } catch (error: any) {
    return serverError(c, error, '初始化失败');
  }
});

export default route;
