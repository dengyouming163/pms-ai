'use client';

import { useState, useEffect } from 'react';
import { useMode } from '@/lib/context/mode-context';
import { apiGet } from '@/lib/api-client';
import { AI_INSIGHTS_URL } from '@/lib/constants';
import { InsightCard } from './insight-card';
import { Skeleton } from '@/components/ui/skeleton';

export function InsightList() {
  const { isAIMode } = useMode();
  const [insights, setInsights] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!isAIMode) { setInsights([]); setLoading(false); return; }
    apiGet<{ insights: any[] }>(AI_INSIGHTS_URL)
      .then(data => { setInsights(data.insights || []); setError(false); })
      .catch(() => setError(true))
      .finally(() => setLoading(false));
    const interval = setInterval(() => {
      apiGet<{ insights: any[] }>(AI_INSIGHTS_URL)
        .then(data => setInsights(data.insights || []))
        .catch(() => {});
    }, 300_000);
    return () => clearInterval(interval);
  }, [isAIMode]);

  if (!isAIMode) return null;
  if (loading) return <Skeleton className="h-32 w-full" />;
  if (error) return (
    <div className="text-center py-4">
      <p className="text-sm text-red-500">加载 AI 洞察失败</p>
      <button onClick={() => window.location.reload()} className="text-xs underline mt-1">重试</button>
    </div>
  );
  if (insights.length === 0) return null;

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-muted-foreground flex items-center gap-2">
        AI 洞察建议 ({insights.length})
      </h3>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-3">
        {insights.map(insight => <InsightCard key={insight.id} insight={insight} />)}
      </div>
    </div>
  );
}
