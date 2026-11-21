'use client';

import { cn } from '@/lib/utils';

type StatusType = 'success' | 'warning' | 'danger' | 'info' | 'default' | 'purple';

const statusStyles: Record<StatusType, string> = {
  success: 'bg-emerald-50 text-emerald-700',
  warning: 'bg-amber-50 text-amber-700',
  danger: 'bg-red-50 text-red-700',
  info: 'bg-blue-50 text-blue-700',
  default: 'bg-slate-50 text-slate-700',
  purple: 'bg-purple-50 text-purple-700',
};

interface StatusBadgeProps {
  label: string;
  type?: StatusType;
  className?: string;
}

export function StatusBadge({ label, type = 'default', className }: StatusBadgeProps) {
  return (
    <span
      className={cn(
        'px-2.5 py-1 rounded-lg text-xs font-medium',
        statusStyles[type],
        className
      )}
    >
      {label}
    </span>
  );
}
