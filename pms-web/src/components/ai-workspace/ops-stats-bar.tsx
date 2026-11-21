'use client';

interface OpsSummary { checkinCount: number; checkoutCount: number; dirtyCount: number; occupiedCount: number; problemCount: number; overdueOrderCount: number; }

interface Props {
  summary: OpsSummary | null;
  onFilterClick?: (key: string) => void;
}

export function OpsStatsBar({ summary, onFilterClick }: Props) {
  if (!summary) return <div className="flex gap-4 px-4 py-3"><div className="text-sm text-slate-400">加载中...</div></div>;

  const items = [
    { key: 'checkin', label: '今日入住', value: summary.checkinCount, color: 'text-emerald-600', icon: '🛎️' },
    { key: 'checkout', label: '今日退房', value: summary.checkoutCount, color: 'text-blue-600', icon: '🚪' },
    { key: 'occupied', label: '在住', value: summary.occupiedCount, color: 'text-slate-600', icon: '🛏️' },
    { key: 'dirty', label: '脏房', value: summary.dirtyCount, color: 'text-red-500', icon: '🧹' },
    { key: 'overdue', label: '超时订单', value: summary.overdueOrderCount, color: 'text-amber-600', icon: '⚠️' },
    { key: 'problem', label: '异常房间', value: summary.problemCount, color: 'text-orange-500', icon: '🔧' },
  ];

  return (
    <div className="flex gap-2 px-4 py-3 flex-wrap">
      {items.map(item => (
        <button key={item.key} onClick={() => onFilterClick?.(item.key)}
          className="flex items-center gap-2 px-4 py-2.5 bg-white rounded-xl border border-slate-200 hover:border-slate-300 hover:shadow-sm transition-all cursor-pointer">
          <span className="text-lg">{item.icon}</span>
          <span className={`text-2xl font-bold ${item.color}`}>{item.value}</span>
          <span className="text-sm text-slate-500">{item.label}</span>
        </button>
      ))}
    </div>
  );
}
