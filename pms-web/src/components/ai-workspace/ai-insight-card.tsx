'use client';

interface InsightCardProps {
  icon: string;
  title: string;
  description: string;
  actionLabel: string;
  onAction: () => void;
  variant?: 'info' | 'warning' | 'danger' | 'success';
}

const variantStyles: Record<string, string> = {
  info: 'border-blue-200 bg-blue-50',
  warning: 'border-amber-200 bg-amber-50',
  danger: 'border-red-200 bg-red-50',
  success: 'border-emerald-200 bg-emerald-50',
};

export function AiInsightCard({ icon, title, description, actionLabel, onAction, variant = 'info' }: InsightCardProps) {
  return (
    <div className={`rounded-xl border p-3 ${variantStyles[variant]}`}>
      <div className="flex items-start gap-2">
        <span className="text-lg flex-shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <p className="text-sm font-semibold text-slate-700">{title}</p>
          <p className="text-xs text-slate-500 mt-0.5">{description}</p>
          <button
            onClick={onAction}
            className="mt-2 px-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs font-medium text-slate-600 hover:bg-slate-50 hover:border-slate-300 transition-colors"
          >
            {actionLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
