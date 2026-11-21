'use client';

import { Plus } from 'lucide-react';

interface PageHeaderAction {
  label: string;
  onClick: () => void;
  icon?: React.ReactNode;
  variant?: 'default' | 'primary';
}

interface PageHeaderProps {
  title: string;
  subtitle?: string;
  action?: PageHeaderAction;
  actions?: PageHeaderAction[];
  icon?: React.ReactNode;
}

export function PageHeader({ title, subtitle, action, actions, icon }: PageHeaderProps) {
  const allActions = actions || (action ? [action] : []);

  return (
    <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-2xl p-5 text-white flex items-center gap-4">
      <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center flex-shrink-0">
        {icon || <div className="w-2 h-2 bg-white rounded-full" />}
      </div>
      <div className="flex-1">
        <h2 className="text-lg font-semibold">{title}</h2>
        {subtitle && <p className="text-sm text-emerald-100 mt-0.5">{subtitle}</p>}
      </div>
      {allActions.length > 0 && (
        <div className="flex items-center gap-2">
          {allActions.map((act, i) => (
            <button
              key={i}
              onClick={act.onClick}
              className={`flex items-center gap-2 px-5 py-2.5 rounded-xl text-sm font-medium transition-colors ${
                act.variant === 'primary'
                  ? 'bg-white text-emerald-600 hover:bg-emerald-50'
                  : 'bg-white/20 hover:bg-white/30'
              }`}
            >
              {act.icon || <Plus className="w-4 h-4" />}
              {act.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
