'use client';

type TaskType = 'checkin' | 'checkout' | 'cleaning' | 'maintenance' | 'overdue_order';

interface TaskCardProps {
  type: TaskType;
  title: string;
  subtitle: string;
  time?: string;
  primaryAction: { label: string; onClick: () => void; loading?: boolean };
  secondaryAction?: { label: string; onClick: () => void };
}

const TYPE_CONFIG: Record<TaskType, { icon: string; bg: string; border: string }> = {
  checkin: { icon: '🛎️', bg: 'bg-emerald-50', border: 'border-emerald-200' },
  checkout: { icon: '🚪', bg: 'bg-blue-50', border: 'border-blue-200' },
  cleaning: { icon: '🧹', bg: 'bg-amber-50', border: 'border-amber-200' },
  maintenance: { icon: '🔧', bg: 'bg-orange-50', border: 'border-orange-200' },
  overdue_order: { icon: '⚠️', bg: 'bg-red-50', border: 'border-red-200' },
};

export function OpsTaskCard({ type, title, subtitle, time, primaryAction, secondaryAction }: TaskCardProps) {
  const cfg = TYPE_CONFIG[type];
  return (
    <div className={`rounded-xl border ${cfg.border} ${cfg.bg} p-4`}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-xl">{cfg.icon}</span>
          <div>
            <p className="text-sm font-semibold text-slate-700">{title}</p>
            <p className="text-xs text-slate-500">{subtitle}</p>
          </div>
        </div>
        {time && <span className="text-xs text-slate-400">{time}</span>}
      </div>
      <div className="flex gap-2 mt-3">
        <button
          onClick={primaryAction.onClick}
          disabled={primaryAction.loading}
          className="px-4 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50 hover:border-slate-300 disabled:opacity-50 transition-colors"
        >
          {primaryAction.loading ? '...' : primaryAction.label}
        </button>
        {secondaryAction && (
          <button onClick={secondaryAction.onClick} className="px-4 py-1.5 text-xs text-slate-400 hover:text-slate-600 transition-colors">
            {secondaryAction.label}
          </button>
        )}
      </div>
    </div>
  );
}
