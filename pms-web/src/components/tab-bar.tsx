'use client';

import { cn } from '@/lib/utils';

interface TabItem {
  key: string;
  label: string;
}

interface TabBarProps {
  tabs: TabItem[];
  activeKey: string;
  onChange: (key: string) => void;
}

export function TabBar({ tabs, activeKey, onChange }: TabBarProps) {
  return (
    <div className="flex items-center gap-2">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          onClick={() => onChange(tab.key)}
          className={cn(
            'px-5 py-2 rounded-xl text-sm font-medium transition-all',
            activeKey === tab.key
              ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-lg shadow-emerald-500/25'
              : 'bg-white border border-slate-200 text-slate-600 hover:bg-slate-50'
          )}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
