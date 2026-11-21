import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import { db } from '../../db/index.js';
import { pmsBuiTenantModeConfig, pmsBuiModuleModeConfig } from '../../db/schema/ai.js';
import { getTenantScope } from '../../utils/tenant.js';

const mode = new Hono();

mode.get('/', async (c) => {
  const scope = getTenantScope(c);
  const [tenantConfig] = await db.select().from(pmsBuiTenantModeConfig)
    .where(eq(pmsBuiTenantModeConfig.merchantId, scope.merchantId)).limit(1);
  const moduleConfigs = await db.select().from(pmsBuiModuleModeConfig)
    .where(eq(pmsBuiModuleModeConfig.storeId, scope.storeId));

  return c.json({
    systemMode: tenantConfig?.systemMode || 'saas',
    aiTrialUntil: tenantConfig?.aiTrialUntil || null,
    modules: {
      pricing: moduleConfigs.find(m => m.module === 'pricing')?.mode !== 'saas',
      customer: moduleConfigs.find(m => m.module === 'customer')?.mode !== 'saas',
      housekeeping: moduleConfigs.find(m => m.module === 'housekeeping')?.mode !== 'saas',
      ota_bridge: moduleConfigs.find(m => m.module === 'ota_bridge')?.mode !== 'saas',
      report: moduleConfigs.find(m => m.module === 'report')?.mode !== 'saas',
      chat: moduleConfigs.find(m => m.module === 'chat')?.mode !== 'saas',
    },
  });
});

mode.post('/switch', async (c) => {
  const scope = getTenantScope(c);
  const { mode: newMode } = await c.req.json();
  if (!['saas', 'ai_agent', 'hybrid'].includes(newMode)) {
    return c.json({ success: false, error: '无效模式' }, 400);
  }
  await db.insert(pmsBuiTenantModeConfig)
    .values({ merchantId: scope.merchantId, systemMode: newMode })
    .onConflictDoUpdate({
      target: pmsBuiTenantModeConfig.merchantId,
      set: { systemMode: newMode, updatedAt: new Date() },
    });
  return c.json({ success: true, mode: newMode });
});

mode.put('/module', async (c) => {
  const scope = getTenantScope(c);
  const { module: modName, enabled } = await c.req.json();
  const newMode = enabled ? 'ai_agent' : 'saas';
  const id = `mod_${scope.storeId}_${modName}`;
  await db.insert(pmsBuiModuleModeConfig)
    .values({ id, storeId: scope.storeId, module: modName, mode: newMode })
    .onConflictDoUpdate({
      target: pmsBuiModuleModeConfig.id,
      set: { mode: newMode, updatedAt: new Date() },
    });
  return c.json({ success: true, module: modName, enabled });
});

export default mode;
