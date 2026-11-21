'use client';

import { SearchX, Inbox } from 'lucide-react';

interface EmptyStateProps {
  type?: 'no_data' | 'no_result';
  title?: string;
  description?: string;
  icon?: React.ReactNode;
}

export function EmptyState({ 
  type = 'no_data', 
  title, 
  description,
  icon 
}: EmptyStateProps) {
  const defaultConfig = {
    no_data: {
      title: title || '暂无数据',
      description: description || '当前还没有任何数据',
      icon: icon || <Inbox className="h-12 w-12 text-slate-300" />,
    },
    no_result: {
      title: title || '未找到匹配结果',
      description: description || '试试调整筛选条件或搜索关键词',
      icon: icon || <SearchX className="h-12 w-12 text-slate-300" />,
    },
  };

  const config = defaultConfig[type];

  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      {config.icon}
      <h3 className="mt-4 text-base font-medium text-slate-700">{config.title}</h3>
      <p className="mt-1 text-sm text-slate-400">{config.description}</p>
    </div>
  );
}
