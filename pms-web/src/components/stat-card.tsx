import { cn } from '@/lib/utils';
import { type LucideIcon } from 'lucide-react';

interface StatCardProps {
  title: string;
  value: string | number;
  change?: number;
  icon: LucideIcon;
  iconColor?: string;
  iconBg?: string;
}

export function StatCard({
  title,
  value,
  change,
  icon: Icon,
  iconColor = 'text-emerald-600',
  iconBg = 'bg-emerald-50',
}: StatCardProps) {
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm hover:shadow-md transition-shadow p-5">
      <div className="flex items-center gap-4">
        <div className={cn('w-12 h-12 rounded-xl flex items-center justify-center', iconBg)}>
          <Icon className={cn('w-6 h-6', iconColor)} />
        </div>
        <div className="flex-1 min-w-0">
          <p className="text-sm text-slate-500">{title}</p>
          <div className="flex items-baseline gap-2 mt-1">
            <span className="text-2xl font-bold text-slate-800">{value}</span>
            {change !== undefined && (
              <span
                className={cn(
                  'text-xs font-medium px-1.5 py-0.5 rounded-lg',
                  change >= 0
                    ? 'text-emerald-600 bg-emerald-50'
                    : 'text-red-600 bg-red-50'
                )}
              >
                {change >= 0 ? '+' : ''}{change}%
              </span>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
