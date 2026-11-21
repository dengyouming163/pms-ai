'use client';

import { useState, useEffect } from 'react';
import { apiGet } from '@/lib/api-client';
import { PageHeader } from '@/components/page-header';
import { DollarSign } from 'lucide-react';

interface Transaction {
  id: string; createdAt: string; type: string; category: string;
  amount: number; guestName: string; description: string; status: string;
}

const categoryLabels: Record<string, string> = {
  room: '客房收入', food: '餐饮收入', other: '其他收入',
  salary: '人力成本', purchase: '采购支出', utility: '能源费用',
  commission: '渠道佣金', maintenance: '维修支出', refund: '退款',
};

export default function FinancePage() {
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [summary, setSummary] = useState({ totalIncome: 0, totalExpense: 0, netIncome: 0 });
  const [loading, setLoading] = useState(true);
  const [keyword, setKeyword] = useState('');
  const [txnType, setTxnType] = useState('');
  const [dateFrom, setDateFrom] = useState('');
  const [dateTo, setDateTo] = useState('');
  const [page, setPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);

  const fetchData = () => {
    setLoading(true);
    const params = new URLSearchParams({ type: 'transactions', page: String(page), limit: '50' });
    if (keyword) params.set('keyword', keyword);
    if (txnType) params.set('txnType', txnType);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    apiGet('/api/finance?' + params.toString()).then(d => {
      setTransactions(d.transactions || []);
      setSummary(d.summary || {});
      setTotalPages(d.pagination?.totalPages || 1);
    }).finally(() => setLoading(false));
  };

  useEffect(() => { fetchData(); }, [page]);

  const handleExport = () => {
    const params = new URLSearchParams({ type: 'transactions', export: 'csv' });
    if (keyword) params.set('keyword', keyword);
    if (txnType) params.set('txnType', txnType);
    if (dateFrom) params.set('dateFrom', dateFrom);
    if (dateTo) params.set('dateTo', dateTo);
    window.open('/api/finance?' + params.toString(), '_blank');
  };

  return (<>
    <div className="mb-6">
    <PageHeader title="收支明细" subtitle="交易流水清单，支持查询和导出" icon={<DollarSign className="w-5 h-5" />} action={{ label: '导出 CSV', onClick: handleExport }} />
    </div>

      {/* 汇总 */}
      <div className="grid grid-cols-3 gap-4 mb-6">
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="text-xs text-slate-500">总收入</div>
          <div className="text-2xl font-bold text-emerald-600">¥{summary.totalIncome.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="text-xs text-slate-500">总支出</div>
          <div className="text-2xl font-bold text-red-500">¥{summary.totalExpense.toLocaleString()}</div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-4">
          <div className="text-xs text-slate-500">净利润</div>
          <div className={`text-2xl font-bold ${summary.netIncome >= 0 ? 'text-slate-800' : 'text-red-500'}`}>
            ¥{summary.netIncome.toLocaleString()}
          </div>
        </div>
      </div>

      {/* 搜索 + 筛选 */}
      <div className="flex gap-3 mb-4 flex-wrap">
        <input value={keyword} onChange={e => setKeyword(e.target.value)} placeholder="搜索客户/说明..."
          className="px-4 py-2 border border-slate-200 rounded-xl text-sm w-48" />
        <select value={txnType} onChange={e => setTxnType(e.target.value)}
          className="px-4 py-2 border border-slate-200 rounded-xl text-sm">
          <option value="">全部类型</option>
          <option value="income">收入</option>
          <option value="expense">支出</option>
        </select>
        <input type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)}
          className="px-4 py-2 border border-slate-200 rounded-xl text-sm" />
        <span className="text-slate-400 self-center">至</span>
        <input type="date" value={dateTo} onChange={e => setDateTo(e.target.value)}
          className="px-4 py-2 border border-slate-200 rounded-xl text-sm" />
        <button onClick={() => { setPage(1); fetchData(); }}
          className="px-4 py-2 bg-slate-100 text-slate-700 rounded-xl text-sm hover:bg-slate-200">查询</button>
      </div>

      {/* 交易列表 */}
      <div className="bg-white rounded-2xl border border-slate-200 overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50 border-b border-slate-200">
            <tr>
              {['日期', '类型', '类别', '金额', '客户', '说明'].map(h => (
                <th key={h} className="text-left px-4 py-3 text-xs font-medium text-slate-500">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {loading ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">加载中...</td></tr>
            ) : transactions.length === 0 ? (
              <tr><td colSpan={6} className="px-4 py-8 text-center text-slate-400">暂无交易记录</td></tr>
            ) : transactions.map(t => (
              <tr key={t.id} className="hover:bg-slate-50">
                <td className="px-4 py-3 text-sm text-slate-600">{t.createdAt?.slice(0, 10)}</td>
                <td className="px-4 py-3">
                  <span className={`text-xs px-2 py-0.5 rounded-full ${t.type === 'income' ? 'bg-emerald-50 text-emerald-700' : 'bg-red-50 text-red-700'}`}>
                    {t.type === 'income' ? '收入' : '支出'}
                  </span>
                </td>
                <td className="px-4 py-3 text-sm text-slate-600">{categoryLabels[t.category] || t.category}</td>
                <td className="px-4 py-3 text-sm font-medium text-slate-700">¥{(t.amount || 0).toLocaleString()}</td>
                <td className="px-4 py-3 text-sm text-slate-600">{t.guestName || '-'}</td>
                <td className="px-4 py-3 text-sm text-slate-500">{t.description || '-'}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {totalPages > 1 && (
          <div className="flex justify-center gap-2 p-4 border-t border-slate-200">
            <button disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="px-4 py-2 border rounded-xl text-sm disabled:opacity-30">上一页</button>
            <span className="px-4 py-2 text-sm text-slate-500">第 {page}/{totalPages} 页</span>
            <button disabled={page >= totalPages} onClick={() => setPage(p => p + 1)} className="px-4 py-2 border rounded-xl text-sm disabled:opacity-30">下一页</button>
          </div>
        )}
      </div>
  </>);
}
