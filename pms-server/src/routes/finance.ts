import { Hono } from 'hono';
import { db } from '../db/index.js';
import { pmsBuiTransactions, pmsBuiOrders } from '../db/schema/index.js';
import { desc, eq, and, or, like, sql } from 'drizzle-orm';
import { getTenantScope, tenantWhere } from '../utils/tenant.js';

const route = new Hono();

// 类别标签映射
const categoryLabels: Record<string, string> = {
  room: '客房收入', food: '餐饮收入', other: '其他收入',
  salary: '人力成本', purchase: '采购支出', utility: '能源费用',
  commission: '渠道佣金', maintenance: '维修支出', refund: '退款',
};

route.get('/', async (c) => {
  const scope = getTenantScope(c);
  const type = c.req.query('type');
  const keyword = c.req.query('keyword');
  const category = c.req.query('category');
  const txnType = c.req.query('txnType'); // income / expense
  const dateFrom = c.req.query('dateFrom');
  const dateTo = c.req.query('dateTo');
  const page = parseInt(c.req.query('page') || '1');
  const limit = parseInt(c.req.query('limit') || '50');
  const exportCsv = c.req.query('export') === 'csv';

  // --- 交易明细列表 ---
  if (type === 'transactions' || !type) {
    const conditions: any[] = [...tenantWhere(scope, pmsBuiTransactions)];
    if (keyword) {
      conditions.push(or(
        like(pmsBuiTransactions.guestName, `%${keyword}%`),
        like(pmsBuiTransactions.remark, `%${keyword}%`),
      ));
    }
    if (category) conditions.push(eq(pmsBuiTransactions.category, category));
    if (txnType) conditions.push(eq(pmsBuiTransactions.type, txnType));
    if (dateFrom) conditions.push(sql`${pmsBuiTransactions.createdAt}::date >= ${dateFrom}::date`);
    if (dateTo) conditions.push(sql`${pmsBuiTransactions.createdAt}::date <= ${dateTo}::date`);
    const whereClause = and(...conditions);

    // 统计汇总
    const allTxns = await db.select().from(pmsBuiTransactions).where(whereClause);
    const totalIncome = allTxns.filter(t => t.type === 'income').reduce((s, t) => s + Number(t.amount || 0), 0);
    const totalExpense = allTxns.filter(t => t.type === 'expense').reduce((s, t) => s + Number(t.amount || 0), 0);

    // 导出 CSV
    if (exportCsv) {
      const header = '日期,类型,类别,金额,客户,说明,状态\n';
      const rows = allTxns.map(t =>
        `"${t.createdAt}","${t.type === 'income' ? '收入' : '支出'}","${categoryLabels[t.category] || t.category}","${t.amount}","${t.guestName || ''}","${t.remark || ''}","${t.status || ''}"`
      ).join('\n');
      return new Response(header + rows, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="交易明细_${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    // 分页
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(pmsBuiTransactions).where(whereClause);
    const total = Number(countResult[0].count);
    const transactions = await db.select().from(pmsBuiTransactions)
      .where(whereClause).orderBy(desc(pmsBuiTransactions.createdAt))
      .limit(limit).offset((page - 1) * limit);

    return c.json({
      transactions,
      summary: { totalIncome, totalExpense, netIncome: totalIncome - totalExpense },
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  }

  // --- 对账明细（基于订单）---
  if (type === 'reconciliation') {
    // 从订单表生成对账明细（订单金额 vs 渠道金额）
    const orders = await db.select().from(pmsBuiOrders)
      .where(and(...tenantWhere(scope, pmsBuiOrders), eq(pmsBuiOrders.status, 'checked_out')))
      .orderBy(desc(pmsBuiOrders.checkOut || pmsBuiOrders.createdAt));

    const details = orders.map(o => {
      const channelCommission = 0.10; // 可以从渠道表查，这里默认 10%
      const channelAmount = Math.round(Number(o.totalPrice || 0) * (1 - channelCommission));
      const diff = Number(o.totalPrice || 0) - channelAmount;
      return {
        id: o.id,
        orderNo: o.orderNo,
        channel: o.channel,
        guestName: o.guestName,
        checkOut: o.checkOut || o.createdAt,
        systemAmount: Number(o.totalPrice || 0),
        channelAmount,
        difference: diff,
        status: Math.abs(diff) > 100 ? 'mismatch' : 'matched',
        createdAt: o.createdAt,
      };
    });

    if (exportCsv) {
      const header = '订单号,渠道,客人,离店日期,系统金额,渠道结算,差额,状态\n';
      const rows = details.map(d =>
        `"${d.orderNo}","${d.channel}","${d.guestName}","${d.checkOut}","${d.systemAmount}","${d.channelAmount}","${d.difference}","${d.status}"`
      ).join('\n');
      return new Response(header + rows, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="对账明细_${new Date().toISOString().slice(0, 10)}.csv"`,
        },
      });
    }

    return c.json({
      details: details.slice((page - 1) * limit, page * limit),
      summary: {
        totalOrders: details.length,
        matchedOrders: details.filter(d => d.status === 'matched').length,
        mismatchedOrders: details.filter(d => d.status === 'mismatch').length,
        totalDiff: details.reduce((s, d) => s + d.difference, 0),
      },
      pagination: { page, limit, total: details.length, totalPages: Math.ceil(details.length / limit) },
    });
  }

  // 默认返回
  return c.json({ transactions: [] });
});

export default route;
