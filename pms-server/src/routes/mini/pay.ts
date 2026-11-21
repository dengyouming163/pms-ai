import { Hono } from 'hono';
import { z } from 'zod';
import { eq, and } from 'drizzle-orm';
import { db } from '../../db/index.js';
import {
  pmsBuiOrders, pmsBuiMiniPayments, pmsBuiMerchantApplications, pmsBuiCustomers, pmsBuiMiniUsers,
  pmsBuiMiniStoreConfig, pmsBuiCouponRecords,
} from '../../db/schema/index.js';
import { getMiniUser } from '../../middleware/mini-auth.js';
import {
  jsapiPartnerOrder, buildMiniPayParams, decryptNotifyResource, verifyNotifySignature, toRfc3339Cst,
  refundOrder, closeOrder, queryRefund, WxpayApiError, effectiveAmountFen, getWxpayPrivateKey,
} from '../../services/wechat-pay.js';
import {
  createOrder as dyCreateOrder,
  createRefund as dyCreateRefund,
  queryRefund as dyQueryRefund,
  verifyNotify as dyVerifyNotify,
  DyPayApiError,
  DY_REFUND_REJECTED_ERRNOS,
} from '../../services/douyin-pay.js';
import { calcRefundAmount } from '../../utils/cancel-policy.js';
import { requireEnv } from '../../constants.js';
import { confirmPlatformProductOrderPaid, confirmPlatformProductOrderRefund, getPlatformProductOrder, getPlatformProduct, confirmWenlvOrderPaid, confirmWenlvOrderRefund } from '../../services/platform-client.js';
import { syncOrderToEngine } from '../../services/engine-sync.js';
import { classifyRefundTarget } from '../../services/refund-target.js';
import { ensurePromoter, applyParentBinding, freezeDistCommission, getDistConfig, resolveDistRates, syncCustomerFromOrder, cancelCommissionByOrder } from '../../services/distribution-engine.js';
import { serverError } from '../../lib/http-error.js';
import { refundWenlvOrder } from '../../services/wenlv-refund.js';

const route = new Hono();

const jsapiSchema = z.object({ orderId: z.string().min(1) });

// JSAPI 下单：预订单 → 微信 prepay_id → 小程序调起参数
route.post('/jsapi', async (c) => {
  const miniUser = getMiniUser(c);
  const parsed = jsapiSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：缺少 orderId' }, 400);

  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, parsed.data.orderId), eq(pmsBuiOrders.guestId, miniUser.miniUserId))).limit(1);
  if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
  if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
    return c.json({ success: false, error: '订单状态不可支付' }, 400);
  }
  if (order.otaTimeout && order.otaTimeout.getTime() < Date.now()) {
    return c.json({ success: false, error: '订单已超时，请重新下单' }, 400);
  }

  // 门店必须已完成进件
  const [application] = await db.select().from(pmsBuiMerchantApplications)
    .where(eq(pmsBuiMerchantApplications.storeId, order.storeId!)).limit(1);
  if (!application?.subMchid || application.status !== 'finished') {
    return c.json({ success: false, error: '该门店收款配置未完成' }, 400);
  }

  // 幂等：同订单复用未支付的支付单，否则新建
  const amountFen = effectiveAmountFen(order.totalPrice * 100); // 元 → 分（唯一换算点）
  let payment: typeof pmsBuiMiniPayments.$inferSelect | undefined = (await db.select().from(pmsBuiMiniPayments)
    .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1))[0];
  // 复用前金额一致性检查：旧 pending 支付单金额与当前订单价不一致（防御性），关旧单建新单
  if (payment && payment.amount !== amountFen) {
    await db.update(pmsBuiMiniPayments).set({ status: 'closed', updatedAt: new Date() })
      .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));
    // 同步失效微信侧 prepay，防旧单被继续支付；失败不阻塞新单创建（旧单本地已 closed，回调会短路）
    try {
      await closeOrder(application.subMchid, payment.outTradeNo);
    } catch (err) {
      console.error('[mini-pay] 微信关单失败（不阻塞新单）', payment.outTradeNo, err);
    }
    payment = undefined;
  }
  if (!payment) {
    // 部分唯一索引 uniq_mini_payments_order_pending 保证同订单最多一条 pending 支付单；
    // 并发插入冲突时 onConflictDoNothing 返回空，回读复用对方刚建的支付单
    [payment] = await db.insert(pmsBuiMiniPayments).values({
      id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId: order.merchantId,
      storeId: order.storeId!,
      orderId: order.id,
      orderNo: order.orderNo,
      outTradeNo: `${order.orderNo}T${Date.now().toString().slice(-6)}`,
      amount: amountFen,
    }).onConflictDoNothing().returning();
    if (!payment) {
      [payment] = await db.select().from(pmsBuiMiniPayments)
        .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1);
    }
    if (!payment) return c.json({ success: false, error: '支付单创建失败，请重试' }, 500);
  }

  const prepayId = await jsapiPartnerOrder({
    subMchid: application.subMchid,
    description: `${order.roomType} ${order.checkIn}入住 ${order.nights}晚`,
    outTradeNo: payment.outTradeNo,
    amountFen: payment.amount,
    openid: miniUser.openid,
    timeExpire: order.otaTimeout ? toRfc3339Cst(order.otaTimeout) : undefined,
  });

  const payParams = buildMiniPayParams(
    requireEnv('WX_MINI_APPID'), prepayId, getWxpayPrivateKey(),
  );
  return c.json({ success: true, data: payParams });
});

// 支付结果回调（公开路径；验签 + 幂等 + 事务确认订单）
route.post('/notify', async (c) => {
  const bodyStr = await c.req.text();
  const verified = await verifyNotifySignature({
    serial: c.req.header('Wechatpay-Serial') || '',
    timestamp: c.req.header('Wechatpay-Timestamp') || '',
    nonce: c.req.header('Wechatpay-Nonce') || '',
    signature: c.req.header('Wechatpay-Signature') || '',
  }, bodyStr);
  if (!verified) return c.json({ code: 'FAIL', message: '验签失败' }, 401);

  const notify = JSON.parse(bodyStr);
  // 非支付成功事件（如退款回调误投递到本端点）提前确认，不进入支付确认流程
  if (notify.event_type !== 'TRANSACTION.SUCCESS') return c.json({ code: 'SUCCESS' });
  const resource = decryptNotifyResource(requireEnv('WXPAY_APIV3_KEY'), notify.resource);
  if (resource.trade_state !== 'SUCCESS') return c.json({ code: 'SUCCESS' }); // 非成功态仅确认收到

  const [payment] = await db.select().from(pmsBuiMiniPayments)
    .where(eq(pmsBuiMiniPayments.outTradeNo, resource.out_trade_no)).limit(1);
  if (!payment) return c.json({ code: 'FAIL', message: '支付单不存在' }, 404);
  // 幂等：非 pending（paid/refunding/refunded/closed）一律短路，防迟到的重复回调覆盖后续状态（微信会重试）
  if (payment.status !== 'pending') {
    // 已关闭支付单却收到成功回调：微信关单前用户已完成支付的竞态窗口，需人工对账退款
    if (payment.status === 'closed' && resource.trade_state === 'SUCCESS') {
      console.error('[mini-pay] 警告：已关闭支付单收到成功回调，需人工对账退款', payment.outTradeNo, resource.transaction_id);
    }
    return c.json({ code: 'SUCCESS' });
  }
  // 金额比对：回调实付金额与支付单不一致，拒绝确认（资金安全防线）
  if (resource.amount?.total !== payment.amount) {
    return c.json({ code: 'FAIL', message: '金额不一致' }, 400);
  }

  // 平台套餐订单（orderId 以 po_ 开头）：回调先确认平台订单 paid（幂等），再确认本地支付单。
  // 顺序说明：平台确认失败时返回非 SUCCESS 让微信重试，支付单保持 pending 收敛重试，
  // 避免「先置支付单 paid、平台确认失败后重试被幂等短路」导致平台订单永未确认。
  if (payment.orderId.startsWith('po_')) {
    const confirm = await confirmPlatformProductOrderPaid(payment.orderId, resource.transaction_id);
    if (!confirm.ok) {
      console.error('[mini-pay] 平台订单支付确认失败，微信将重试', payment.outTradeNo, confirm.status, confirm.data?.error);
      return c.json({ code: 'FAIL', message: '平台订单确认失败' }, 502);
    }
    await db.update(pmsBuiMiniPayments).set({
      status: 'paid',
      transactionId: resource.transaction_id,
      paidAt: new Date(),
      notifyRaw: resource,
      updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));

    // 下单即分销 + 冻结佣金（best-effort）
    await onProductOrderPaid(payment.orderId);

    // 订单回写 CDP（复购基础）：异步通知 platform-server，不阻塞支付确认
    // MVP 说明：payment 表不含手机号，payload 暂不传 customerPhone；platform 端会建孤立订单，
    // 后续按手机号/身份合并。若后续订单表能带出 phone，再补传。
    void syncOrderToEngine({
      platformOrderNo: payment.orderId,
      amountFen: payment.amount,
      storeId: payment.storeId || undefined,
      status: 'paid',
      paidAt: new Date().toISOString(),
    });
    return c.json({ code: 'SUCCESS' });
  }

  // 文旅门票订单（wenlv-pay 创建支付单时 storeId 独占占位 'platform'）：先确认文旅订单 paid（幂等，激活券），再确认本地支付单。
  // 用 storeId 而非 orderNo 前缀判别，防 orderNo 数据漂移导致 fail-open（收钱不激活券且不可自愈）
  if (payment.storeId === 'platform') {
    const confirm = await confirmWenlvOrderPaid(payment.orderId, resource.transaction_id);
    if (!confirm.ok) {
      console.error('[mini-pay] 文旅订单支付确认失败，微信将重试', payment.outTradeNo, confirm.status, confirm.data?.error);
      return c.json({ code: 'FAIL', message: '文旅订单确认失败' }, 502);
    }
    await db.update(pmsBuiMiniPayments).set({
      status: 'paid',
      transactionId: resource.transaction_id,
      paidAt: new Date(),
      notifyRaw: resource,
      updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));

    // D1：平台补座失败（钱已收、票无座）⇒ 立刻自动退款。
    // 顺序承重：必须在支付单置 paid 之后 —— 退款编排第 3 步要求本地支付单 status='paid'。
    // miniUserId 只能从响应取：本地 pms_bui_mini_payments 没有该列，而 refundWenlvOrder 的归属校验硬要求它
    //（类型上可选、实际必填：为 undefined 时平台 GET /orders/:id 缺 query 会 400）。
    const d = confirm.data?.data as { seatReacquireFailed?: boolean; miniUserId?: string } | undefined;
    if (d?.seatReacquireFailed) {
      if (d.miniUserId) {
        await refundWenlvOrder(payment.orderId, { miniUserId: d.miniUserId, reason: '场次座位不足，自动退款' })
          .catch((e: any) => console.error('[mini-pay] 自动退款失败，须人工对账', payment.orderId, e?.message || e));
      } else {
        console.error('[mini-pay] 补座失败但响应缺 miniUserId，须人工对账', payment.orderId);
      }
    }
    return c.json({ code: 'SUCCESS' });
  }

  // 同一事务：支付单确认 + 订单确认 + 客户档案 upsert
  await db.transaction(async (tx) => {
    // 带状态条件的 UPDATE：并发重复回调只有一个能从 pending 迁移成功，其余受影响 0 行直接返回
    const updated = await tx.update(pmsBuiMiniPayments).set({
      status: 'paid',
      transactionId: resource.transaction_id,
      paidAt: new Date(),
      notifyRaw: resource,
      updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (updated.length === 0) return; // 已被并发回调处理，跳过订单确认

    await tx.update(pmsBuiOrders).set({
      status: 'confirmed',
      paymentStatus: 'paid',
      paymentMethod: '微信支付',
      confirmedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(pmsBuiOrders.id, payment.orderId));

    // 客户档案：按 门店+小程序用户 upsert（私域客户资产沉淀）
    const [order] = await tx.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.id, payment.orderId)).limit(1);
    if (order?.guestId) {
      const [miniUser] = await tx.select().from(pmsBuiMiniUsers).where(eq(pmsBuiMiniUsers.id, order.guestId)).limit(1);
      const [existing] = await tx.select().from(pmsBuiCustomers)
        .where(and(eq(pmsBuiCustomers.storeId, order.storeId!), eq(pmsBuiCustomers.miniUserId, order.guestId))).limit(1);
      if (!existing) {
        // 并发窗口：同一用户同店两笔订单同时回调可能都过 !existing 检查产生重复客户记录。
        // 无 (storeId, miniUserId) 唯一约束可依赖 onConflictDoNothing —— M1 接受低概率重复，
        // 后续 customers 模块自带去重合并能力。
        await tx.insert(pmsBuiCustomers).values({
          id: `cus_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          merchantId: order.merchantId,
          storeId: order.storeId,
          name: order.guestName,
          phone: order.guestPhone || miniUser?.phone || '',
          source: 'mini',
          miniUserId: order.guestId,
        });
      }
    }
  });

  return c.json({ code: 'SUCCESS' });
});

// 取消已支付订单并按取消政策退款
route.post('/cancel-paid', async (c) => {
  const miniUser = getMiniUser(c);
  const parsed = z.object({ orderId: z.string().min(1) }).safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：缺少 orderId' }, 400);

  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, parsed.data.orderId), eq(pmsBuiOrders.guestId, miniUser.miniUserId))).limit(1);
  if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
  if (order.status !== 'confirmed' || order.paymentStatus !== 'paid') {
    return c.json({ success: false, error: '当前状态不可取消退款' }, 400);
  }

  const [payment] = await db.select().from(pmsBuiMiniPayments)
    .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'paid'))).limit(1);
  if (!payment) return c.json({ success: false, error: '支付单不存在' }, 404);

  const [config] = await db.select().from(pmsBuiMiniStoreConfig)
    .where(eq(pmsBuiMiniStoreConfig.storeId, order.storeId!)).limit(1);
  const policy = config?.cancelPolicy || { freeHours: 24, feeRate: 20 };
  const refundYuan = calcRefundAmount(order.totalPrice, order.checkIn, new Date(), policy);
  if (refundYuan <= 0) return c.json({ success: false, error: '已过可取消时间，如需取消请联系商家' }, 400);

  const [application] = await db.select().from(pmsBuiMerchantApplications)
    .where(eq(pmsBuiMerchantApplications.storeId, order.storeId!)).limit(1);
  if (!application?.subMchid) return c.json({ success: false, error: '门店收款配置异常' }, 500);

  const outRefundNo = `RF${payment.outTradeNo}`;
  // 先条件置退款中（防并发重复申请）；微信退款为异步，最终态由退款回调落定
  const updated = await db.update(pmsBuiMiniPayments).set({
    status: 'refunding', refundNo: outRefundNo, refundAmount: refundYuan * 100, updatedAt: new Date(),
  }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'paid')))
    .returning({ id: pmsBuiMiniPayments.id });
  if (updated.length === 0) return c.json({ success: false, error: '退款已在处理中，请勿重复提交' }, 409);

  // 抖音渠道走抖音支付退款（直连单商户）；微信渠道走原有服务商退款
  if (payment.channel === 'douyin') {
    try {
      await dyCreateRefund({
        outOrderNo: payment.outTradeNo,
        outRefundNo,
        refundAmountFen: refundYuan * 100,
        refundReason: '用户取消订单',
        notifyUrl: `${requireEnv('DY_PAY_NOTIFY_BASE')}/api/mini/pay/dy-refund-notify`,
      });
      // 轻量兜底：申请成功后主动确认受理一次（回调仍是最终落定）
      try {
        await dyQueryRefund(outRefundNo);
      } catch (qErr) {
        console.warn('[mini-pay] 抖音退款主动查询失败（不阻塞，依赖回调）', outRefundNo, qErr);
      }
      return c.json({ success: true, data: { refundAmount: refundYuan, message: '退款已受理，将原路退回' } });
    } catch (err) {
      console.error('[mini-pay] 抖音退款申请异常，查询消歧', payment.outTradeNo, err);
      // 三分支消歧：申请异常 ≠ 申请失败（网络超时可能抖音侧已受理）
      let dyAccepted = false, confirmedRejected = false;
      try {
        await dyQueryRefund(outRefundNo);
        dyAccepted = true;
      } catch (qErr) {
        // 仅当抖音明确返回「退款单不存在」类错误码时才判定申请被拒绝并回滚；
        // 其余 DyPayApiError（含 HTTP 5xx / err_no 缺失）一律视为状态不明，
        // 保守保持退款中待对账，避免误把在途退款回滚为已支付。
        // ⚠️ 联调核对点：错误码以沙箱实测为准，确认后填入 DY_REFUND_REJECTED_ERRNOS。
        if (qErr instanceof DyPayApiError && DY_REFUND_REJECTED_ERRNOS.includes(qErr.errNo)) confirmedRejected = true;
        else console.error('[mini-pay] 抖音退款状态查询失败，状态不明', outRefundNo, qErr);
      }
      if (dyAccepted) return c.json({ success: true, data: { refundAmount: refundYuan, message: '退款已受理，将原路退回' } });
      if (!confirmedRejected) {
        console.error('[mini-pay] 警告：抖音退款申请结果不明，保持退款中待对账', outRefundNo);
        return c.json({ success: false, error: '退款处理中，请稍后查看退款结果' }, 502);
      }
      // 明确拒绝：条件回滚为 paid 让用户可重试（保留 refundNo/refundAmount 便于审计，重试幂等复用）
      const rolledBack = await db.update(pmsBuiMiniPayments).set({
        status: 'paid', updatedAt: new Date(),
      }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
        .returning({ id: pmsBuiMiniPayments.id });
      if (rolledBack.length === 0) {
        // 0 行：并发退款回调已把状态落定（refunded）——退款实际成功，按成功返回
        return c.json({ success: true, data: { refundAmount: refundYuan, message: '退款已受理，将原路退回' } });
      }
      return c.json({ success: false, error: '退款申请失败，请稍后重试' }, 502);
    }
  }

  try {
    await refundOrder({
      subMchid: application.subMchid,
      outTradeNo: payment.outTradeNo,
      outRefundNo,
      refundFen: refundYuan * 100,
      totalFen: payment.amount,
      reason: '用户取消订单',
    });
    // 轻量兜底：申请成功后主动确认受理一次（回调仍是最终落定）
    try {
      await queryRefund(application.subMchid, outRefundNo);
    } catch (qErr) {
      console.warn('[mini-pay] 微信退款主动查询失败（不阻塞，依赖回调）', outRefundNo, qErr);
    }
  } catch (err) {
    console.error('[mini-pay] 微信退款申请异常，查询微信侧退款状态消歧', payment.outTradeNo, err);
    // 三分支消歧：申请异常 ≠ 申请失败（可能网络超时但微信侧已受理，贸然回滚会导致重复退款）
    let wxAccepted = false;      // 微信侧已存在该退款单（申请实际已受理）
    let confirmedRejected = false; // 微信明确 4xx 业务拒绝（退款单不存在/申请被拒）
    try {
      await queryRefund(application.subMchid, outRefundNo);
      wxAccepted = true;
    } catch (qErr) {
      if (qErr instanceof WxpayApiError && qErr.status >= 400 && qErr.status < 500) {
        confirmedRejected = true;
      } else {
        console.error('[mini-pay] 退款状态查询失败，状态不明', outRefundNo, qErr);
      }
    }
    if (wxAccepted) {
      // 分支 1：微信侧已受理——保持 refunding，最终态由退款回调落定
      return c.json({ success: true, data: { refundAmount: refundYuan, message: '退款已受理，将原路退回' } });
    }
    if (!confirmedRejected) {
      // 分支 2：查询也失败，状态不明——保持 refunding（保留 refundNo）等回调或人工对账，不回滚防重复退款
      console.error('[mini-pay] 警告：退款申请结果不明，保持退款中待对账', outRefundNo);
      return c.json({ success: false, error: '退款处理中，请稍后查看退款结果' }, 502);
    }
    // 分支 3：微信明确业务拒绝——条件回滚为 paid 让用户可重试（保留 refundNo/refundAmount 便于审计，
    // 退款单号 RF 前缀确定性生成，重试幂等复用）
    const rolledBack = await db.update(pmsBuiMiniPayments).set({
      status: 'paid', updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (rolledBack.length === 0) {
      // 0 行：并发退款回调已把状态落定（refunded）——退款实际成功，按成功返回
      return c.json({ success: true, data: { refundAmount: refundYuan, message: '退款已受理，将原路退回' } });
    }
    return c.json({ success: false, error: '退款申请失败，请稍后重试' }, 502);
  }

  return c.json({ success: true, data: { refundAmount: refundYuan, message: '退款已受理，将原路退回' } });
});

// 退款结果回调（公开路径；验签 + 幂等 + 释放库存）
route.post('/refund-notify', async (c) => {
  const bodyStr = await c.req.text();
  const verified = await verifyNotifySignature({
    serial: c.req.header('Wechatpay-Serial') || '',
    timestamp: c.req.header('Wechatpay-Timestamp') || '',
    nonce: c.req.header('Wechatpay-Nonce') || '',
    signature: c.req.header('Wechatpay-Signature') || '',
  }, bodyStr);
  if (!verified) return c.json({ code: 'FAIL', message: '验签失败' }, 401);

  const notify = JSON.parse(bodyStr);
  const REFUND_EVENTS = ['REFUND.SUCCESS', 'REFUND.ABNORMAL', 'REFUND.CLOSED'];
  if (notify.event_type && !REFUND_EVENTS.includes(notify.event_type)) return c.json({ code: 'SUCCESS' });
  const resource = decryptNotifyResource(requireEnv('WXPAY_APIV3_KEY'), notify.resource);
  // 退款异常/关闭：告警后 ack（保持 refunding 待人工介入，微信不再重试该事件）
  if (notify.event_type === 'REFUND.ABNORMAL' || notify.event_type === 'REFUND.CLOSED') {
    console.error('[mini-pay] 警告：退款异常/关闭回调，需人工介入处理',
      notify.event_type, resource.out_refund_no, resource.refund_status);
    return c.json({ code: 'SUCCESS' });
  }
  if (resource.refund_status !== 'SUCCESS') return c.json({ code: 'SUCCESS' });

  const [payment] = await db.select().from(pmsBuiMiniPayments)
    .where(eq(pmsBuiMiniPayments.refundNo, resource.out_refund_no)).limit(1);
  if (!payment) return c.json({ code: 'FAIL', message: '退款单不存在' }, 404);
  // ⚠️ 不变量：能走到下面的单，其本地支付单必然已被 wenlv-refund/product-refund 置为 refunding
  //    （即「先预留、后回调落定」）。若将来放宽此状态前置（如支持商户平台手工退款回调），
  //    落定分支会在未预留的情况下把订单改成 refunded，造成钱货不一致 —— 改这里前先想清楚。
  if (payment.status !== 'refunding') return c.json({ code: 'SUCCESS' }); // 幂等：已落定或状态异常均只 ack
  // 落定前金额比对：回调实退金额与本地退款单不一致仅告警（钱已由微信划出，仍落定，留人工对账）
  if (resource.amount?.refund !== undefined && resource.amount.refund !== payment.refundAmount) {
    console.error('[mini-pay] 警告：退款回调金额与本地退款单不一致，需人工对账',
      resource.out_refund_no, resource.amount.refund, payment.refundAmount);
  }

  // 平台套餐订单（po_）：先落定平台订单 refunded（成功才继续），再落支付单+退券，防「钱已退但订单未落定」
  if (classifyRefundTarget(payment) === 'platform-product') {
    const confirm = await confirmPlatformProductOrderRefund(
      payment.orderId, '用户取消（已退款）', (payment.refundAmount || 0) / 100,
    );
    if (!confirm.ok) {
      console.error('[mini-pay] 平台退款落定失败，保持 refunding 待重试', payment.orderId, confirm.status, confirm.data?.error);
      return c.json({ code: 'FAIL', message: '平台退款落定失败' }, 502);
    }
    // 退款回收佣金（best-effort）：frozen/released 未提现佣金置 cancelled
    await cancelCommissionByOrder(payment.orderId).catch((e: any) =>
      console.error('[mini-pay] 退款佣金回收失败', payment.orderId, e?.message || e));
    // 退款退券先行（幂等 status='used' 守卫；若在支付单落定前崩溃，回调重试可自愈重跑）
    await db.update(pmsBuiCouponRecords)
      .set({ status: 'pending', usedAt: null, usedOrderId: null })
      .where(and(eq(pmsBuiCouponRecords.usedOrderId, payment.orderId), eq(pmsBuiCouponRecords.status, 'used')));
    // 支付单落定（.returning() 校验受影响行，0 行=并发已处理）
    const settled = await db.update(pmsBuiMiniPayments).set({ status: 'refunded', refundedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (settled.length === 0) return c.json({ code: 'SUCCESS' }); // 并发已处理，仅 ack
    return c.json({ code: 'SUCCESS' });
  }

  // 文旅门票订单（storeId='platform'）：先落定平台订单 refunded（成功才继续），再落本地支付单。
  // 判别用 storeId 而非 orderId 前缀 —— order.id 是 uuid，与 pay-notify 的文旅分支（:173）同一判别法。
  // 「po_ 优先于 storeId」这一判别顺序不变量由 classifyRefundTarget 承载，并由 refund-target.test.ts 锁定；
  // 若顺序被写反，套餐单会被当文旅单退，落定必然错；即便误判也是 fail-closed（BFF 404 → 保持 refunding，不会错退钱）。
  if (classifyRefundTarget(payment) === 'wenlv') {
    const confirm = await confirmWenlvOrderRefund(
      payment.orderId, '用户申请退款', (payment.refundAmount || 0) / 100,
    );
    if (!confirm.ok) {
      console.error('[mini-pay] 文旅订单退款落定失败，保持 refunding 待重试', payment.orderId, confirm.status, confirm.data?.error);
      return c.json({ code: 'FAIL', message: '文旅订单退款落定失败' }, 502);
    }
    const settled = await db.update(pmsBuiMiniPayments)
      .set({ status: 'refunded', refundedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (settled.length === 0) return c.json({ code: 'SUCCESS' }); // 并发已处理，仅 ack
    return c.json({ code: 'SUCCESS' });
  }

  // 同一事务：退款落定 + 取消订单（cancelled 不在占用状态列表，库存隐式释放）
  await db.transaction(async (tx) => {
    const done = await tx.update(pmsBuiMiniPayments).set({
      status: 'refunded', refundedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (done.length === 0) return; // 并发已处理

    await tx.update(pmsBuiOrders).set({
      status: 'cancelled',
      paymentStatus: 'refunded',
      cancelledAt: new Date(),
      cancelReason: '用户取消（已退款）',
      updatedAt: new Date(),
    }).where(eq(pmsBuiOrders.id, payment.orderId));

    // 退款退券：将已使用的券恢复为 pending 状态
    // M2 简化：退券不校验过期，下次领取/使用时拦截
    await tx.update(pmsBuiCouponRecords)
      .set({ status: 'pending', usedAt: null, usedOrderId: null })
      .where(and(eq(pmsBuiCouponRecords.usedOrderId, payment.orderId), eq(pmsBuiCouponRecords.status, 'used')));
  });

  return c.json({ code: 'SUCCESS' });
});

// ==================== 抖音支付（直连单商户） ====================
// ⚠️ 资金代码：商户号到位后须沙箱联调核对 create_order / 回调字段名与签名规则，
//    当前为可编译骨架，字段映射处均已标注 TODO(douyin)。

/** 解析回调 body（兼容 JSON 与 form-urlencoded 两种投递） */
async function parseNotifyBody(c: any): Promise<Record<string, string | number>> {
  const raw = await c.req.text();
  const ct = c.req.header('content-type') || '';
  if (ct.includes('application/json')) {
    try { return JSON.parse(raw || '{}'); } catch { return {}; }
  }
  return Object.fromEntries(new URLSearchParams(raw));
}

// 抖音支付 JSAPI 下单（直连单商户）：预订单 → 抖音 create_order → 小程序调起参数
route.post('/dy-jsapi', async (c) => {
  const miniUser = getMiniUser(c);
  const parsed = jsapiSchema.safeParse(await c.req.json().catch(() => ({})));
  if (!parsed.success) return c.json({ success: false, error: '参数错误：缺少 orderId' }, 400);

  const [order] = await db.select().from(pmsBuiOrders)
    .where(and(eq(pmsBuiOrders.id, parsed.data.orderId), eq(pmsBuiOrders.guestId, miniUser.miniUserId))).limit(1);
  if (!order) return c.json({ success: false, error: '订单不存在' }, 404);
  if (order.status !== 'pending' || order.paymentStatus !== 'unpaid') {
    return c.json({ success: false, error: '订单状态不可支付' }, 400);
  }
  if (order.otaTimeout && order.otaTimeout.getTime() < Date.now()) {
    return c.json({ success: false, error: '订单已超时，请重新下单' }, 400);
  }

  const amountFen = effectiveAmountFen(order.totalPrice * 100); // 元 → 分
  // 幂等：同订单复用未支付的支付单，否则新建（channel=douyin）
  let payment: typeof pmsBuiMiniPayments.$inferSelect | undefined = (await db.select().from(pmsBuiMiniPayments)
    .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1))[0];
  if (payment && payment.amount !== amountFen) {
    await db.update(pmsBuiMiniPayments).set({ status: 'closed', updatedAt: new Date() })
      .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));
    payment = undefined;
  }
  if (!payment) {
    [payment] = await db.insert(pmsBuiMiniPayments).values({
      id: `pay_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
      merchantId: order.merchantId,
      storeId: order.storeId!,
      orderId: order.id,
      orderNo: order.orderNo,
      channel: 'douyin',
      outTradeNo: `${order.orderNo}D${Date.now().toString().slice(-6)}`,
      amount: amountFen,
    }).onConflictDoNothing().returning();
    if (!payment) {
      [payment] = await db.select().from(pmsBuiMiniPayments)
        .where(and(eq(pmsBuiMiniPayments.orderId, order.id), eq(pmsBuiMiniPayments.status, 'pending'))).limit(1);
    }
    if (!payment) return c.json({ success: false, error: '支付单创建失败，请重试' }, 500);
  }

  let dyPayParams;
  try {
    dyPayParams = await dyCreateOrder({
      outOrderNo: payment.outTradeNo,
      totalAmountFen: payment.amount,
      subject: `${order.roomType} ${order.checkIn}入住 ${order.nights}晚`,
      body: `${order.roomType} ${order.checkIn}入住 ${order.nights}晚`,
      notifyUrl: `${requireEnv('DY_PAY_NOTIFY_BASE')}/api/mini/pay/dy-notify`,
      payerUid: miniUser.openid,
    });
  } catch (e) {
    console.error('[mini-pay] 抖音下单失败', payment.outTradeNo, e);
    return serverError(c, e, '下单失败', 502);
  }
  return c.json({ success: true, data: dyPayParams });
});

// 抖音支付结果回调（公开路径；验签 + 幂等 + 事务确认订单）
route.post('/dy-notify', async (c) => {
  const params = await parseNotifyBody(c);
  if (!dyVerifyNotify(params)) return c.json({ err_no: 1, err_tips: '验签失败' }, 401);

  // 非支付成功事件（err_no != 0）仅 ack
  if (Number(params.err_no) !== 0) return c.json({ err_no: 0, err_tips: 'success' });

  const outTradeNo = String(params.out_order_no || '');
  const amountFen = Number(params.total_amount);
  const [payment] = await db.select().from(pmsBuiMiniPayments)
    .where(eq(pmsBuiMiniPayments.outTradeNo, outTradeNo)).limit(1);
  if (!payment) return c.json({ err_no: 1, err_tips: '支付单不存在' }, 404);
  if (payment.status !== 'pending') return c.json({ err_no: 0, err_tips: 'success' }); // 幂等
  if (amountFen !== payment.amount) {
    return c.json({ err_no: 1, err_tips: '金额不一致' }, 400); // 资金安全防线
  }

  // 平台套餐订单（orderId 以 po_ 开头）：先确认平台订单 paid（幂等），再确认本地支付单
  if (payment.orderId.startsWith('po_')) {
    const confirm = await confirmPlatformProductOrderPaid(payment.orderId, String(params.order_id || ''));
    if (!confirm.ok) {
      console.error('[mini-pay] 平台订单支付确认失败，抖音将重试', payment.outTradeNo, confirm.status, confirm.data?.error);
      return c.json({ err_no: 1, err_tips: '平台订单确认失败' }, 502);
    }
    await db.update(pmsBuiMiniPayments).set({
      status: 'paid',
      transactionId: String(params.order_id || ''),
      paidAt: new Date(),
      notifyRaw: params,
      updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')));

    // 下单即分销 + 冻结佣金（best-effort）
    await onProductOrderPaid(payment.orderId);
    return c.json({ err_no: 0, err_tips: 'success' });
  }

  // 同一事务：支付单确认 + 订单确认 + 客户档案 upsert（与微信支付一致）
  await db.transaction(async (tx) => {
    const updated = await tx.update(pmsBuiMiniPayments).set({
      status: 'paid',
      transactionId: String(params.order_id || ''),
      paidAt: new Date(),
      notifyRaw: params,
      updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'pending')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (updated.length === 0) return; // 并发回调已处理

    await tx.update(pmsBuiOrders).set({
      status: 'confirmed',
      paymentStatus: 'paid',
      paymentMethod: '抖音支付',
      confirmedAt: new Date(),
      updatedAt: new Date(),
    }).where(eq(pmsBuiOrders.id, payment.orderId));

    const [order] = await tx.select().from(pmsBuiOrders).where(eq(pmsBuiOrders.id, payment.orderId)).limit(1);
    if (order?.guestId) {
      const [miniUser] = await tx.select().from(pmsBuiMiniUsers).where(eq(pmsBuiMiniUsers.id, order.guestId)).limit(1);
      const [existing] = await tx.select().from(pmsBuiCustomers)
        .where(and(eq(pmsBuiCustomers.storeId, order.storeId!), eq(pmsBuiCustomers.miniUserId, order.guestId))).limit(1);
      if (!existing) {
        await tx.insert(pmsBuiCustomers).values({
          id: `cus_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
          merchantId: order.merchantId,
          storeId: order.storeId,
          name: order.guestName,
          phone: order.guestPhone || miniUser?.phone || '',
          source: 'mini',
          miniUserId: order.guestId,
        });
      }
    }
  });

  return c.json({ err_no: 0, err_tips: 'success' });
});

// 抖音退款结果回调（公开路径；验签 + 幂等 + 释放库存）
route.post('/dy-refund-notify', async (c) => {
  const params = await parseNotifyBody(c);
  if (!dyVerifyNotify(params)) return c.json({ err_no: 1, err_tips: '验签失败' }, 401);

  const refundNo = String(params.out_refund_no || '');
  // TODO(douyin): 退款成功状态字段名（status/refund_status 及取值）沙箱联调核对
  const status = String(params.status ?? params.refund_status ?? '');
  if (status && status !== 'SUCCESS') return c.json({ err_no: 0, err_tips: 'success' });

  const [payment] = await db.select().from(pmsBuiMiniPayments)
    .where(eq(pmsBuiMiniPayments.refundNo, refundNo)).limit(1);
  if (!payment) return c.json({ err_no: 1, err_tips: '退款单不存在' }, 404);
  if (payment.status !== 'refunding') return c.json({ err_no: 0, err_tips: 'success' });

  // 平台套餐订单（po_）：先落定平台订单 refunded（成功才继续），再落支付单+退券
  if (payment.orderId.startsWith('po_')) {
    const confirm = await confirmPlatformProductOrderRefund(
      payment.orderId, '用户取消（已退款）', (payment.refundAmount || 0) / 100,
    );
    if (!confirm.ok) {
      console.error('[mini-pay] 平台退款落定失败，保持 refunding 待重试', payment.orderId, confirm.status, confirm.data?.error);
      return c.json({ err_no: 1, err_tips: '平台退款落定失败' }, 502);
    }
    // 退款回收佣金（best-effort）：frozen/released 未提现佣金置 cancelled
    await cancelCommissionByOrder(payment.orderId).catch((e: any) =>
      console.error('[mini-pay] 退款佣金回收失败', payment.orderId, e?.message || e));
    // 退款退券先行（幂等 status='used' 守卫；若在支付单落定前崩溃，回调重试可自愈重跑）
    await db.update(pmsBuiCouponRecords)
      .set({ status: 'pending', usedAt: null, usedOrderId: null })
      .where(and(eq(pmsBuiCouponRecords.usedOrderId, payment.orderId), eq(pmsBuiCouponRecords.status, 'used')));
    // 支付单落定（.returning() 校验受影响行，0 行=并发已处理）
    const settled = await db.update(pmsBuiMiniPayments).set({ status: 'refunded', refundedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (settled.length === 0) return c.json({ err_no: 0, err_tips: 'success' }); // 并发已处理，仅 ack
    return c.json({ err_no: 0, err_tips: 'success' });
  }

  await db.transaction(async (tx) => {
    const done = await tx.update(pmsBuiMiniPayments).set({
      status: 'refunded', refundedAt: new Date(), updatedAt: new Date(),
    }).where(and(eq(pmsBuiMiniPayments.id, payment.id), eq(pmsBuiMiniPayments.status, 'refunding')))
      .returning({ id: pmsBuiMiniPayments.id });
    if (done.length === 0) return;

    await tx.update(pmsBuiOrders).set({
      status: 'cancelled',
      paymentStatus: 'refunded',
      cancelledAt: new Date(),
      cancelReason: '用户取消（已退款）',
      updatedAt: new Date(),
    }).where(eq(pmsBuiOrders.id, payment.orderId));

    // 退款退券：恢复已用优惠券
    await tx.update(pmsBuiCouponRecords)
      .set({ status: 'pending', usedAt: null, usedOrderId: null })
      .where(and(eq(pmsBuiCouponRecords.usedOrderId, payment.orderId), eq(pmsBuiCouponRecords.status, 'used')));
  });

  return c.json({ err_no: 0, err_tips: 'success' });
});

/**
 * 套餐订单支付成功 hook（微信/抖音共用）：下单即分销 + 冻结佣金。
 * 由 payment.orderId（po_ 前缀）拉平台订单详情，取 miniUserId/productId/totalAmount/storeId，
 * 读套餐 distributionConfig 解析佣金率，冻结二级佣金（自购不返佣，佣金沿推荐链向上分配）。
 * best-effort：失败仅日志，不阻断支付回调主流程。
 */
async function onProductOrderPaid(orderId: string): Promise<void> {
  try {
    const res = await getPlatformProductOrder(orderId);
    const order = res?.data?.data;
    if (!order || res.status !== 200) return;

    const miniUserId = order.miniUserId;
    const storeId = order.storeId;
    if (!miniUserId || !storeId) return; // 线下录单（source=offline）无 C 端账号，不参与分销

    // 1) 下单即分销：确保用户为该门店分销员
    await ensurePromoter(miniUserId, storeId);

    // 2) 回填上级关系（二级分销 + 团队树用）：若存在 referral_binding 则写入 parentPromoterId/level（幂等）
    await applyParentBinding(miniUserId, storeId);

    // 3) 读套餐分销配置 + 全局默认，解析每层佣金率
    const [cfg, product] = await Promise.all([
      getDistConfig(),
      getPlatformProduct(order.productId).catch(() => null),
    ]);
    const rates = resolveDistRates(cfg, { distributionConfig: product?.extraAttrs?.distributionConfig ?? null });

    // 4) 冻结二级佣金（自购不返佣，佣金沿推荐链向上分配）
    const amountFen = Math.round(Number(order.totalAmount) * 100);
    await freezeDistCommission({
      orderId,
      orderNo: order.orderNo,
      storeId,
      miniUserId,
      productId: order.productId,
      productName: order.productName,
      amountFen,
      rates,
    });

    // 5) 打通门店客户表：写入来源 + 来源推广员 + 消费累计（D9 客户口径）
    await syncCustomerFromOrder({
      storeId,
      miniUserId,
      guestName: order.guestName || '微信用户',
      guestPhone: order.guestPhone || '',
      amountFen,
    });
  } catch (e: any) {
    console.error('[mini-pay] 分销佣金冻结失败（不阻断支付）', orderId, e?.message || e);
  }
}

export default route;
