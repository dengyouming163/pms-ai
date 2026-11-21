'use client';

interface CustomerStats {
  total: number;
  vipCount: number;
  dormantCount: number;
  newThisMonth: number;
  carePending: number;
}

interface Props {
  stats: CustomerStats | null;
  onFilterClick: (filter: string) => void;
}

export function CustomerStatsBar({ stats, onFilterClick }: Props) {
  if (!stats) {
    return <div className="flex gap-4 px-4 py-3"><div className="text-sm text-slate-400">加载中...</div></div>;
  }

  const items = [
    { key: '', label: '总客户', value: stats.total, color: 'text-slate-700' },
    { key: 'vip', label: 'VIP', value: stats.vipCount, color: 'text-amber-600' },
    { key: 'dormant', label: '沉睡客户', value: stats.dormantCount, color: 'text-red-500' },
    { key: 'new', label: '本月新增', value: stats.newThisMonth, color: 'text-emerald-600' },
    { key: 'care', label: '待关怀', value: stats.carePending, color: 'text-blue-600' },
  ];

  return (
    <div className="flex gap-2 px-4 py-3 flex-wrap">
      {items.map(item => (
        <button
          key={item.key}
          onClick={() => onFilterClick(item.key)}
          className="flex items-center gap-2 px-4 py-2.5 bg-white rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all"
        >
          <span className={`text-2xl font-bold ${item.color}`}>{item.value}</span>
          <span className="text-sm text-slate-500">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
