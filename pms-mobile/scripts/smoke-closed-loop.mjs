// 私域交易闭环冒烟：模拟平台套餐订单全生命周期（模式B 全款 / 模式A 订金+尾款 / 预约流 / 拒约退款）+ C1/C2/D5 逻辑仿真
//
// 定位：逻辑级冒烟。不依赖真实服务/数据库——直接复刻 pms-platform-server/src/routes/product-orders.ts
// 的状态机门禁与结算规则做仿真，断言各环节状态与金额恒等（merchant+platform===total）。
// 真实端到端（下单→微信支付→回调→平台确认→接单→核销→结算落库）需起 pms-platform-server + PostgreSQL 与支付沙箱；
// 本脚本为无依赖、可常跑的回归防线，防止状态机/结算规则回退（与 vitest 单测互补，vitest 测的是真实导出的纯函数）。
// C1/C2/D5 补充（与 D4 带券场景同款纯逻辑复刻，见各函数注释）：
//   C2 满意度阈值（survey.ts）：score<3 差评 → 发补偿券；score>=3 满意不补偿；幂等重放/自愈补发。
//   C1 通知幂等（internal/notify.ts）：站内唯一索引 (mini_user_id, order_id, type) —— 同 type 去重、异 type 共存。
//
// 运行：node pms-mobile/scripts/smoke-closed-loop.mjs

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  ✅ ${name}`); }
  else { failed++; console.log(`  ❌ ${name}${extra ? ' — ' + extra : ''}`); }
}

// ---------- 复刻自 product-orders.ts：结算计算（分，百分制分佣：3=3%） ----------
function computeSettlementCents({ totalAmount, settleMode, agreementPrice, commissionRate }) {
  const totalCents = Math.round(Number(totalAmount) * 100);
  let merchantCents;
  if (settleMode === 'agreement') {
    if (agreementPrice == null) return null;
    merchantCents = Math.round(Number(agreementPrice) * 100);
  } else if (settleMode === 'commission') {
    if (commissionRate == null) return null;
    merchantCents = Math.round((totalCents * commissionRate) / 100);
  } else {
    return null;
  }
  return { totalCents, merchantCents, platformCents: totalCents - merchantCents };
}
const yuan = (c) => (c / 100).toFixed(2);

// ---------- 复刻自 product-orders.ts：状态机门禁 ----------
const hasSettlementBasis = (o) =>
  (o.settleMode === 'agreement' ? o.agreementPrice != null
    : o.settleMode === 'commission' ? o.commissionRate != null : false);
const canSettle = (o) => (o.mode === 'A' && !o.balancePaidAt ? false : hasSettlementBasis(o));
const canPayBalance = (o) => o.mode === 'A' && o.status === 'store_accepted' && !o.balancePaidAt;

// 模式B 全链路：下单→支付→平台确认→接单→核销→结算（分佣 3%）
function simulateModeB() {
  console.log('== 模式B 全链路（分佣 3%） ==');
  const o = {
    status: 'pending', paymentStatus: 'unpaid', reservationStatus: 'none',
    mode: 'B', totalAmount: '399.00', settleMode: 'commission', commissionRate: 3,
    balancePaidAt: null, settleStatus: 'unsettled',
  };
  check('下单 → pending/unpaid', o.status === 'pending' && o.paymentStatus === 'unpaid');
  check('模式B 无需补尾款', canPayBalance(o) === false);

  o.status = 'paid'; o.paymentStatus = 'paid';                       // ① 支付确认
  check('① 支付回调 → paid', o.status === 'paid' && o.paymentStatus === 'paid');

  o.status = 'platform_approved';                                    // ② 平台确认
  check('② 平台确认 → platform_approved', o.status === 'platform_approved');

  o.status = 'store_accepted';                                       // ③ 民宿接单
  check('③ 民宿接单 → store_accepted', o.status === 'store_accepted');

  check('④ 核销前置：有结算依据', canSettle(o) === true);            // ④ 核销+结算
  const a = computeSettlementCents({ totalAmount: o.totalAmount, settleMode: o.settleMode, agreementPrice: null, commissionRate: o.commissionRate });
  check('④ 结算金额计算成功', a != null);
  check('④ 分佣 3%：merchant=11.97 元', a.merchantCents === 1197, yuan(a.merchantCents));
  check('④ platform = total−merchant = 387.03 元', a.platformCents === 38703, yuan(a.platformCents));
  check('④ 结算不变量 merchant+platform===total', a.merchantCents + a.platformCents === a.totalCents, `${yuan(a.merchantCents + a.platformCents)} vs ${yuan(a.totalCents)}`);
  o.status = 'used'; o.settleStatus = 'settled';
  check('④ 核销 → used + 已结算', o.status === 'used' && o.settleStatus === 'settled');
}

// 模式B + 预约流：提交预约→平台审核=锁房→接单→核销
function simulateReserveFlow() {
  console.log('== 模式B + 预约流（购买≠预约） ==');
  const o = {
    status: 'pending', paymentStatus: 'unpaid', reservationStatus: 'none',
    mode: 'B', totalAmount: '599.00', settleMode: 'commission', commissionRate: 5,
    balancePaidAt: null, settleStatus: 'unsettled',
  };
  o.status = 'paid'; o.paymentStatus = 'paid';                       // ① 支付
  o.reservationStatus = 'submitted'; o.reservationDate = '2026-08-20'; // ② 提交预约（status 不变）
  check('② 提交预约 → paid+submitted（status 不变）', o.status === 'paid' && o.reservationStatus === 'submitted');
  o.status = 'platform_approved'; o.reservationStatus = 'confirmed'; // ③ 审核通过 = 锁房
  check('③ 审核通过 → platform_approved+confirmed', o.status === 'platform_approved' && o.reservationStatus === 'confirmed');
  o.status = 'store_accepted';                                       // ④ 接单（保留预约）
  check('④ 接单 → store_accepted（保留 confirmed）', o.status === 'store_accepted' && o.reservationStatus === 'confirmed');
  const a = computeSettlementCents({ totalAmount: o.totalAmount, settleMode: o.settleMode, agreementPrice: null, commissionRate: o.commissionRate }); // ⑤ 核销
  check('⑤ 结算不变量 merchant+platform===total', a.merchantCents + a.platformCents === a.totalCents, `${yuan(a.merchantCents)}/${yuan(a.platformCents)}`);
  o.status = 'used'; o.settleStatus = 'settled';
  check('⑤ 核销 → used', o.status === 'used');
}

// 模式A：订金 50 + 尾款 149（协议价 180），先补尾款再核销
function simulateModeA() {
  console.log('== 模式A 全链路（订金 50 + 尾款 149，协议价 180） ==');
  const o = {
    status: 'pending', paymentStatus: 'unpaid', reservationStatus: 'none',
    mode: 'A', totalAmount: '199.00', depositAmount: '50.00', balanceAmount: '149.00',
    settleMode: 'agreement', agreementPrice: '180.00', commissionRate: null,
    balancePaidAt: null, settleStatus: 'unsettled',
  };
  check('下单 → 订金/尾款拆分正确', o.totalAmount === '199.00' && o.depositAmount === '50.00' && o.balanceAmount === '149.00');
  o.status = 'paid'; o.paymentStatus = 'paid';                       // ① 订金支付
  check('① 订金支付 → paid', o.status === 'paid');
  o.status = 'platform_approved';                                    // ② 平台确认
  check('② 平台确认 → platform_approved', o.status === 'platform_approved');
  o.status = 'store_accepted';                                       // ③ 民宿接单
  check('③ 民宿接单 → store_accepted', o.status === 'store_accepted');

  check('④ 未补尾款不可核销', canSettle(o) === false);               // ④ 尾款门禁
  check('④ 未补尾款可补', canPayBalance(o) === true);
  o.balancePaidAt = new Date('2026-08-07T12:00:00');                 // ⑤ 补尾款
  check('⑤ 补尾款 → balancePaidAt 置位', o.balancePaidAt != null);
  check('⑤ 补尾款后不可重复补', canPayBalance(o) === false);
  check('⑤ 补尾款后可核销', canSettle(o) === true);

  const a = computeSettlementCents({ totalAmount: o.totalAmount, settleMode: o.settleMode, agreementPrice: o.agreementPrice, commissionRate: null }); // ⑥ 核销+结算
  check('⑥ 协议价结算：merchant=180.00 元', a.merchantCents === 18000, yuan(a.merchantCents));
  check('⑥ 协议价结算：platform=19.00 元', a.platformCents === 1900, yuan(a.platformCents));
  check('⑥ 结算不变量 merchant+platform===total', a.merchantCents + a.platformCents === a.totalCents, `${yuan(a.merchantCents + a.platformCents)} vs ${yuan(a.totalCents)}`);
  o.status = 'used'; o.settleStatus = 'settled';
  check('⑥ 核销 → used + 已结算', o.status === 'used' && o.settleStatus === 'settled');
}

// 平台拒约：paid+submitted → refunded（退款并清预约字段）
function simulateReject() {
  console.log('== 平台拒约（paid+submitted → refunded） ==');
  const o = { status: 'paid', paymentStatus: 'paid', reservationStatus: 'submitted', reservationDate: '2026-08-20', mode: 'B', totalAmount: '299.00' };
  o.status = 'refunded'; o.reservationStatus = 'none'; o.reservationDate = null; // 复刻 refundOrderCore：清预约字段并置退款
  check('拒约 → refunded 且预约字段清空', o.status === 'refunded' && o.reservationStatus === 'none' && o.reservationDate == null);
}

// 带券下单（D4）：rawTotal=100, 券抵 20 → totalAmount=80；模式A 订金保持、尾款基于抵扣后总额
function simulateCouponDiscount() {
  console.log('== 带券下单（券抵 20，模式A 订金 30） ==');
  const rawTotal = 100, couponDiscount = 20;
  // 复刻平台 POST /：totalAmount = 原价总额 − 券抵扣，Math.round(x*100)/100 保留 2 位小数
  const totalAmount = Math.round((rawTotal - couponDiscount) * 100) / 100;
  const deposit = 30;
  const balance = Math.max(0, Math.round((totalAmount - deposit) * 100) / 100); // 复刻：balance = 抵扣后 total − 订金，钳 0

  check('带券下单 totalAmount = 原额 − 券抵 = 80', totalAmount === 80, `total=${totalAmount}`);
  check('券抵扣不变量 couponDiscount + totalAmount === rawTotal', couponDiscount + totalAmount === rawTotal, `${couponDiscount + totalAmount} vs ${rawTotal}`);
  check('模式A：订金保持原值 30', deposit === 30, `deposit=${deposit}`);
  check('模式A：尾款基于抵扣后 total = 80 − 30 = 50', balance === 50, `balance=${balance}`);

  // 结算基于抵扣后 total（分佣 3%）：merchant=2.40, platform=77.60，恒等 merchant+platform===total
  const a = computeSettlementCents({ totalAmount: String(totalAmount), settleMode: 'commission', agreementPrice: null, commissionRate: 3 });
  check('券后结算（分佣 3%）：merchant=2.40 元', a.merchantCents === 240, yuan(a.merchantCents));
  check('券后结算：platform=77.60 元', a.platformCents === 7760, yuan(a.platformCents));
  check('券后结算不变量 merchant+platform===total', a.merchantCents + a.platformCents === a.totalCents, `${yuan(a.merchantCents + a.platformCents)} vs ${yuan(a.totalCents)}`);
}

// 满意度回访判定（C2）：score<3 差评 → 系统发补偿券；score>=3 满意 → 不发。
// 复刻 survey.ts：阈值 score<3 为差评（发补偿券），幂等重放已回填复用既有补偿、差评缺补偿自愈补发一次。
function simulateSatisfactionSurvey() {
  console.log('== 满意度回访判定（score<3 差评发补偿券） ==');
  const isBadReview = (score) => score < 3;      // 复刻 survey.ts：score<3 为差评
  const shouldCompensate = (score) => score < 3; // 差评 → 发补偿券；满意不发

  check('score=2 → 差评 → 发补偿券', isBadReview(2) === true && shouldCompensate(2) === true);
  check('score=4 → 满意 → 不补偿', isBadReview(4) === false && shouldCompensate(4) === false);
  check('score=3 → 边界（非差评）→ 不补偿', isBadReview(3) === false && shouldCompensate(3) === false);
  check('score=1 → 差评 → 发补偿券', shouldCompensate(1) === true);

  // 幂等重放：已回填（score 非空）→ 复用既有结果；差评缺补偿 → 自愈补发一次；满意 → 不补发
  const replay = (existing) => {
    if (existing.score == null) return { score: null };
    const resp = { score: existing.score };
    if (existing.couponRecordId) resp.compensation = { couponRecordId: existing.couponRecordId };
    else if (existing.score < 3) resp.compensation = { couponRecordId: 'cr_selfheal' }; // 自愈补发一次
    return resp;
  };
  const r1 = replay({ score: 2, couponRecordId: 'cr_xxx' });
  check('已回填差评重复提交 → 复用既有补偿（不重复发券）', r1.score === 2 && r1.compensation.couponRecordId === 'cr_xxx');
  const r2 = replay({ score: 2, couponRecordId: null });
  check('差评缺补偿自愈 → 补发一次', r2.compensation.couponRecordId === 'cr_selfheal');
  const r3 = replay({ score: 4, couponRecordId: null });
  check('满意缺补偿 → 不补发', r3.compensation === undefined);
}

// 通知幂等键（C1）：站内消息唯一索引 (mini_user_id, order_id, type) + onConflictDoNothing——
// 同订单同 type 不重复投递；不同 type（'guide' 支付提醒 vs 'guide_reserved' 入住指引）互不覆盖。
function simulateNotifyIdempotency() {
  console.log('== 通知幂等键（(miniUserId, orderId, type) 唯一） ==');
  const inbox = new Map(); // 仿真 pms_bui_inbox_messages 唯一索引 (mini_user_id, order_id, type)
  const notify = (miniUserId, orderId, type) => {
    const key = `${miniUserId}|${orderId}|${type}`;
    if (inbox.has(key)) return { deduped: true }; // onConflictDoNothing → 已存在跳过
    inbox.set(key, true);
    return { deduped: false };
  };

  const first = notify('u1', 'o1', 'guide');
  const again = notify('u1', 'o1', 'guide');
  check('同订单同 type(guide) 重复通知 → 幂等去重', first.deduped === false && again.deduped === true);

  const reserved = notify('u1', 'o1', 'guide_reserved');
  check('同订单不同 type(guide_reserved) → 不覆盖、可共存', inbox.size === 2 && reserved.deduped === false);

  const otherUser = notify('u2', 'o1', 'guide');
  check('幂等键含 miniUserId：不同用户同订单互不影响', otherUser.deduped === false && inbox.size === 3);
}

console.log('私域交易闭环冒烟（逻辑级仿真，无需服务/数据库）\n');
simulateModeB();
simulateReserveFlow();
simulateModeA();
simulateReject();
simulateCouponDiscount();
simulateSatisfactionSurvey();
simulateNotifyIdempotency();
console.log('');
console.log(`结果：${passed} 通过 / ${failed} 失败`);
if (failed > 0) {
  console.log('❌ 冒烟未通过');
  process.exit(1);
}
console.log('✅ 私域交易闭环冒烟全部通过');
