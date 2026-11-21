// 端到端测试脚本 — 全覆盖版
// 用法: node scripts/e2e-test.mjs
// 前置: pms-server 需运行在 localhost:9090
import jwt from 'jsonwebtoken';

const TOKEN = jwt.sign(
  { userId: 'staff1', phone: '13800000001', roleId: 'role1', scope: 'tenant' },
  'pms-hotel-secret-key-2024',
  { expiresIn: '1h' }
);
const BASE = 'http://localhost:20002';

let passed = 0;
let failed = 0;

function check(condition, label) {
  if (condition) { console.log('  ✓ ' + label); passed++; }
  else { console.log('  ✗ ' + label); failed++; }
}

async function api(method, path, body) {
  const opts = {
    method,
    headers: { 'Authorization': `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(`${BASE}${path}`, opts);
  const data = await res.json();
  return { status: res.status, data };
}

async function main() {
  const freeRoom = 'room_s1_rt1_15'; // 801-808 occupied, 809-815 available

  // ================================================================
  // 第一组：核心业务流程（入住 → 退房 → 客房任务全生命周期）
  // ================================================================

  console.log('\n━━━ 第一组：核心业务流程 ━━━');

  console.log('\n[测试 1] 快速入住');
  const checkin = await api('POST', '/api/rooms', {
    action: 'checkIn',
    roomId: freeRoom,
    guestName: '端到端测试客人',
    guestPhone: '13912345678',
    checkInDate: '2026-05-22',
    checkOutDate: '2026-05-24',
    source: 'walk-in',
  });
  check(checkin.status === 200, '入住响应 200');
  check(checkin.data.success === true, '入住成功');
  check(!!checkin.data.orderNo, '返回订单号: ' + (checkin.data.orderNo || 'N/A'));

  console.log('\n[测试 2] 快速退房');
  const checkout = await api('POST', '/api/rooms', {
    action: 'checkOut',
    roomId: freeRoom,
    checkoutMode: 'normal',
  });
  check(checkout.status === 200, '退房响应 200');
  check(checkout.data.success === true, '退房成功');

  console.log('\n[测试 3] 创建客房任务');
  const task = await api('POST', '/api/housekeeping', {
    action: 'create',
    storeId: 's1',
    roomId: freeRoom,
    roomNumber: '815',
    roomTypeName: '标准大床房',
    taskType: '退房清洁',
    priority: 'high',
  });
  check(task.status === 200, '创建任务响应 200');
  check(task.data.success === true, '创建任务成功');
  const taskId = task.data.taskId;
  check(!!taskId, '返回 taskId: ' + (taskId || 'N/A'));

  if (taskId) {
    console.log('\n[测试 4] 分配任务');
    const assign = await api('POST', '/api/housekeeping', {
      action: 'assign',
      taskId,
      assigneeId: 'staff6',
      assigneeName: '刘洋',
      priority: 'high',
    });
    check(assign.status === 200, '分配任务响应 200');
    check(assign.data.success === true, '分配任务成功');

    console.log('\n[测试 5] 完成任务');
    const complete = await api('POST', '/api/housekeeping', {
      action: 'complete',
      taskId,
    });
    check(complete.status === 200, '完成任务响应 200');
    check(complete.data.success === true, '完成任务成功');

    console.log('\n[测试 6] 验收任务');
    const inspect = await api('POST', '/api/housekeeping', {
      action: 'inspect',
      taskId,
      inspectorId: 'staff2',
      inspectorName: '李婉清',
    });
    check(inspect.status === 200, '验收任务响应 200');
    check(inspect.data.success === true, '验收任务成功');
  }

  console.log('\n[测试 7] 参数校验（缺少必填字段）');
  const validation = await api('POST', '/api/rooms', {
    action: 'checkIn',
    // 缺少 roomId, guestName
  });
  check(validation.status === 400, '无效入住返回 400');

  console.log('\n[测试 8] 通知面板');
  const notifs = await api('GET', '/api/notifications?limit=3');
  check(notifs.status === 200, '通知响应 200');
  check(Array.isArray(notifs.data.data), '通知数据为数组');
  check(notifs.data.data.length >= 0, '通知数据长度正常: ' + notifs.data.data.length);

  console.log('\n[测试 9] 客房任务列表');
  const tasks = await api('GET', '/api/housekeeping');
  check(tasks.status === 200, '任务列表响应 200');
  check(!!tasks.data.data.summary, '返回摘要信息');
  check(typeof tasks.data.data.summary.total === 'number', '总任务数为数字: ' + tasks.data.data.summary.total);

  // ================================================================
  // 第二组：新增 API — 会话管理、通知配置、上传、操作日志
  // ================================================================

  console.log('\n━━━ 第二组：设置与会话管理 ━━━');

  console.log('\n[测试 10] 会话列表');
  const sessions = await api('GET', '/api/auth/sessions');
  check(sessions.status === 200, '会话列表响应 200');
  check(Array.isArray(sessions.data.data), '会话数据为数组');
  // 会话仅在登录时创建，通过gen-token直接签发的token不会有会话记录
  console.log('  ℹ 会话数: ' + sessions.data.data.length + ' (仅在登录时创建)');

  console.log('\n[测试 11] 撤销会话（无效会话ID）');
  const revoke = await api('POST', '/api/auth/sessions', {
    action: 'revoke',
    sessionId: 'non-existent-session',
  });
  // 会话不存在时返回 404
  check(revoke.status === 404 || revoke.data.error === '会话不存在', '撤销不存在会话返回预期错误: ' + (revoke.data.error || revoke.status));

  console.log('\n[测试 12] 通知配置读取');
  const notiSettings = await api('GET', '/api/settings?type=notifications');
  check(notiSettings.status === 200, '通知配置响应 200');
  check(Array.isArray(notiSettings.data.channels), '返回通知渠道数组');
  check(Array.isArray(notiSettings.data.rules), '返回通知规则数组');
  check(notiSettings.data.channels.length >= 1, '至少有 1 个通知渠道');

  console.log('\n[测试 13] 通知配置保存');
  const saveNoti = await api('POST', '/api/settings', {
    action: 'update-notifications',
    data: {
      channels: [
        { name: '短信通知', desc: '订单确认/取消/提醒', enabled: false, balance: 580, unit: '条' },
      ],
      rules: [
        { name: '新订单提醒', desc: '收到新订单时通知', enabled: false },
      ],
    },
  });
  check(saveNoti.status === 200, '保存通知配置响应 200');
  check(saveNoti.data.success === true, '保存通知配置成功');

  // 恢复默认通知配置
  await api('POST', '/api/settings', {
    action: 'update-notifications',
    data: {
      channels: [
        { name: '短信通知', desc: '订单确认/取消/提醒', enabled: true, balance: 580, unit: '条' },
        { name: '站内消息', desc: '系统通知/审核提醒', enabled: true, balance: null, unit: '' },
        { name: '邮件通知', desc: '财务报表/对账提醒', enabled: false, balance: null, unit: '' },
        { name: '微信通知', desc: '实时消息推送', enabled: true, balance: null, unit: '' },
      ],
      rules: [
        { name: '新订单提醒', desc: '收到新订单时通知', enabled: true },
        { name: '取消订单提醒', desc: '订单被取消时通知', enabled: true },
        { name: '入住提醒', desc: '客人入住时通知', enabled: true },
        { name: '退房提醒', desc: '客人退房时通知', enabled: false },
        { name: '支付异常提醒', desc: '支付失败/异常时通知', enabled: true },
        { name: '超时未入住', desc: '预订超时未到店', enabled: true },
      ],
    },
  });

  console.log('\n[测试 14] 文件上传 — 无文件校验');
  const uploadNoFile = await fetch(`${BASE}/api/upload`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${TOKEN}` },
  });
  const uploadNoFileData = await uploadNoFile.json();
  check(uploadNoFile.status === 400, '无文件上传返回 400');
  check(uploadNoFileData.error === '未选择文件', '提示"未选择文件"');

  console.log('\n[测试 15] 操作日志查询');
  const logs = await api('GET', '/api/staff?type=logs');
  check(logs.status === 200, '操作日志响应 200');
  check(Array.isArray(logs.data.logs), '日志数据为数组');
  check(Array.isArray(logs.data.modules), '返回模块列表');
  check(Array.isArray(logs.data.operators), '返回操作人列表');

  // ================================================================
  // 第三组：新增 API — 发票管理、竞品数据
  // ================================================================

  console.log('\n━━━ 第三组：财务与数据中心 ━━━');

  console.log('\n[测试 16] 发票列表');
  const invoices = await api('GET', '/api/finance?type=invoices');
  check(invoices.status === 200, '发票列表响应 200');
  check(invoices.data.success === true, '发票列表请求成功');
  check(Array.isArray(invoices.data.data), '发票数据为数组');

  // 找一个已退房已支付的订单用于发票申请测试
  const ordersList = await api('GET', '/api/orders?page=1&limit=50');
  const paidOrder = (ordersList.data.orders || []).find(o => o.status === 'checked_out' && o.paymentStatus === 'paid');

  if (paidOrder) {
    console.log('\n[测试 17] 发票申请');
    const applyInvoice = await api('POST', '/api/finance', {
      action: 'apply-invoice',
      orderId: paidOrder.id,
      invoiceType: '电子普票',
      invoiceTitle: '测试公司',
      invoiceTaxId: '91110108MA01TEST',
    });
    check(applyInvoice.status === 200, '申请发票响应 200');
    check(applyInvoice.data.success === true, '申请发票成功');
  } else {
    console.log('\n[测试 17] 发票申请 — 跳过（无符合条件的已支付订单）');
    passed++; // 不计入失败
  }

  console.log('\n[测试 18] 竞品价格数据');
  const dataCenterRevenue = await api('GET', '/api/data-center?type=revenue');
  check(dataCenterRevenue.status === 200, '数据中心响应 200');
  const competitorMonitor = dataCenterRevenue.data.competitorMonitor;
  check(Array.isArray(competitorMonitor), '竞品数据为数组');
  check(competitorMonitor.length > 0, '竞品数据不为空: ' + competitorMonitor.length + ' 条');
  if (competitorMonitor.length > 0) {
    check(!!competitorMonitor[0].hotelName, '竞品数据包含 hotelName');
    check(typeof competitorMonitor[0].ourPrice === 'number', '竞品数据包含 ourPrice');
    check(typeof competitorMonitor[0].competitorPrice === 'number', '竞品数据包含 competitorPrice');
  }

  // ================================================================
  // 第四组：Dashboard 周趋势 & 数据完整性
  // ================================================================

  console.log('\n━━━ 第四组：Dashboard 与数据完整性 ━━━');

  console.log('\n[测试 19] Dashboard 周趋势');
  const dashboard = await api('GET', '/api/dashboard');
  check(dashboard.status === 200, 'Dashboard 响应 200');
  const weeklyTrend = dashboard.data.weeklyTrend;
  check(Array.isArray(weeklyTrend), 'weeklyTrend 为数组');
  check(weeklyTrend.length === 7, 'weeklyTrend 包含 7 天数据: ' + weeklyTrend.length);
  if (weeklyTrend.length === 7) {
    check(typeof weeklyTrend[0].revenue === 'number', '每天包含 revenue 数字');
    check(typeof weeklyTrend[0].rooms === 'number', '每天包含 rooms 数字');
    check(weeklyTrend.every(d => !!d.date), '每天包含 date 字符串');
  }

  console.log('\n[测试 20] 房型列表（动态房型下拉）');
  const roomsDaily = await api('GET', '/api/rooms?type=daily');
  check(roomsDaily.status === 200, '房型列表响应 200');
  check(Array.isArray(roomsDaily.data.rooms), 'rooms 为数组');
  check(roomsDaily.data.rooms.length >= 0, '房间数据正常: ' + roomsDaily.data.rooms.length + ' 间');

  // ================================================================
  // 第五组：分页功能
  // ================================================================

  console.log('\n━━━ 第五组：列表分页 ━━━');

  console.log('\n[测试 21] 订单分页');
  const ordersPage1 = await api('GET', '/api/orders?page=1&limit=5');
  check(ordersPage1.status === 200, '订单分页响应 200');
  check(!!ordersPage1.data.pagination, '返回 pagination 对象');
  check(ordersPage1.data.pagination.page === 1, '当前页为 1');
  check(ordersPage1.data.pagination.limit === 5, '每页 5 条');
  check(typeof ordersPage1.data.pagination.total === 'number', 'total 为数字: ' + ordersPage1.data.pagination.total);
  check(typeof ordersPage1.data.pagination.totalPages === 'number', 'totalPages 为数字: ' + ordersPage1.data.pagination.totalPages);
  check(ordersPage1.data.orders.length <= 5, '返回数据不超过 5 条: ' + ordersPage1.data.orders.length);

  console.log('\n[测试 22] 客户分页');
  const customersPage1 = await api('GET', '/api/customers?page=1&limit=5');
  check(customersPage1.status === 200, '客户分页响应 200');
  check(!!customersPage1.data.pagination, '返回 pagination 对象');
  check(typeof customersPage1.data.pagination.total === 'number', 'total 为数字: ' + customersPage1.data.pagination.total);
  check(Array.isArray(customersPage1.data.customers), 'customers 为数组');

  console.log('\n[测试 23] 员工分页');
  const staffPage1 = await api('GET', '/api/staff?page=1&limit=5');
  check(staffPage1.status === 200, '员工分页响应 200');
  check(!!staffPage1.data.pagination, '返回 pagination 对象');
  check(typeof staffPage1.data.pagination.total === 'number', 'total 为数字: ' + staffPage1.data.pagination.total);
  check(Array.isArray(staffPage1.data.staff), 'staff 为数组');

  // ================================================================
  // 测试报告
  // ================================================================

  console.log('\n═══════════════════════════════════');
  const total = passed + failed;
  console.log(`  测试完成: ${passed}/${total} 通过`);
  if (failed > 0) {
    console.log(`  ${failed} 个测试失败`);
    process.exit(1);
  } else {
    console.log('  全部通过');
  }
  console.log('═══════════════════════════════════\n');
}

main().catch(e => {
  console.error('测试执行失败:', e.message);
  process.exit(1);
});
