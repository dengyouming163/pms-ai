'use client';

import { useState, useRef } from 'react';
import { Input } from '@/components/ui/input';

interface CustomerItem {
  id: string;
  name: string;
  phone: string;
  memberLevel: any;
  memberLevelName: string;
  memberLevelIcon: string;
  totalSpent: number;
  stayCount: number;
  lastStayDate: string;
  tags: string[];
  valueScore: number;
}

interface Props {
  customers: CustomerItem[];
  pagination: { page: number; total: number; totalPages: number };
  loading: boolean;
  onSearch: (keyword: string) => void;
  onFilterChange: (filter: string) => void;
  onPageChange: (page: number) => void;
  onSelectCustomer: (customer: CustomerItem) => void;
  activeFilter: string;
}

const FILTERS = [
  { key: '', label: '全部' },
  { key: 'vip', label: 'VIP' },
  { key: 'dormant', label: '沉睡' },
  { key: 'new', label: '本月新增' },
];

const LEVEL_COLORS: Record<string, string> = {
  diamond: 'bg-violet-100 text-violet-700',
  gold: 'bg-amber-100 text-amber-700',
  silver: 'bg-slate-100 text-slate-600',
  regular: 'bg-gray-100 text-gray-500',
};

export function CustomerList({ customers, pagination, loading, onSearch, onFilterChange, onPageChange, onSelectCustomer, activeFilter }: Props) {
  const [keyword, setKeyword] = useState('');
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const handleSearchChange = (kw: string) => {
    setKeyword(kw);
    clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => onSearch(kw), 300);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0">
      <div className="flex items-center gap-3 px-4 py-2 flex-shrink-0">
        <Input
          value={keyword}
          onChange={e => handleSearchChange(e.target.value)}
          placeholder="搜索姓名或手机号..."
          className="max-w-xs h-9 rounded-lg text-sm"
        />
        <div className="flex gap-1">
          {FILTERS.map(f => (
            <button
              key={f.key}
              onClick={() => onFilterChange(f.key)}
              className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors ${activeFilter === f.key ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500 hover:bg-slate-200'}`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-4 space-y-2 custom-scroll">
        {loading ? (
          <p className="text-center py-12 text-slate-400">加载中...</p>
        ) : customers.length === 0 ? (
          <div className="text-center py-12">
            <p className="text-4xl mb-2">👥</p>
            <p className="text-sm text-slate-400">暂无客户数据</p>
          </div>
        ) : (
          customers.map(c => (
            <button
              key={c.id}
              onClick={() => onSelectCustomer(c)}
              className="w-full text-left p-4 bg-white rounded-xl border border-slate-100 hover:border-slate-200 hover:shadow-sm transition-all"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <span className="text-lg">{c.memberLevelIcon || '🎫'}</span>
                  <div>
                    <p className="text-sm font-semibold text-slate-700">{c.name}</p>
                    <p className="text-xs text-slate-400">{c.phone}</p>
                  </div>
                </div>
                <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${LEVEL_COLORS[c.memberLevel?.key || c.memberLevel] || LEVEL_COLORS.regular}`}>
                  {c.memberLevelName || '普通会员'}
                </span>
              </div>
              <div className="flex items-center gap-4 mt-2 text-xs text-slate-500">
                <span>累计消费 ¥{c.totalSpent.toLocaleString()}</span>
                <span>入住 {c.stayCount} 次</span>
                {c.lastStayDate && <span>最近: {new Date(c.lastStayDate).toLocaleDateString('zh-CN')}</span>}
              </div>
              {c.tags.length > 0 && (
                <div className="flex gap-1 mt-2">
                  {c.tags.slice(0, 4).map((tag, i) => (
                    <span key={i} className="text-[10px] px-1.5 py-0.5 bg-slate-100 text-slate-500 rounded">{tag}</span>
                  ))}
                </div>
              )}
            </button>
          ))
        )}
      </div>

      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between px-4 py-2 border-t border-slate-100 flex-shrink-0">
          <span className="text-xs text-slate-400">共 {pagination.total} 条</span>
          <div className="flex gap-1">
            <button onClick={() => onPageChange(pagination.page - 1)} disabled={pagination.page <= 1} className="px-3 py-1 text-xs border rounded-lg disabled:opacity-30 hover:bg-slate-50">上一页</button>
            <span className="px-3 py-1 text-xs text-slate-500">{pagination.page}/{pagination.totalPages}</span>
            <button onClick={() => onPageChange(pagination.page + 1)} disabled={pagination.page >= pagination.totalPages} className="px-3 py-1 text-xs border rounded-lg disabled:opacity-30 hover:bg-slate-50">下一页</button>
          </div>
        </div>
      )}
    </div>
  );
}
