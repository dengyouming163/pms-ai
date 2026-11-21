'use client';

import { useState, useEffect } from 'react';
import { useMode } from '@/lib/context/mode-context';
import { apiGet } from '@/lib/api-client';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/page-header';

interface AIUsage {
  chatCount: number;
  insightCount: number;
  insightAdoptedCount: number;
  actionCount: number;
  tokensUsed: number;
  estimatedCost: number;
  suggestionsSavings: number;
}

export default function AIValuePage() {
  const { isAIMode } = useMode();
  const [usage, setUsage] = useState<AIUsage | null>(null);
  const [error, setError] = useState(false);

  useEffect(() => {
    apiGet<AIUsage>('/api/ai/usage').then(setUsage).catch(() => setError(true));
  }, []);

  if (!isAIMode) {
    return <div className="p-8 text-center text-muted-foreground">AI 模式未开启</div>;
  }
  if (error) return <div className="p-8 text-center text-red-500">加载失败，请稍后重试</div>;
  if (!usage) return <div className="p-8 text-center">加载中...</div>;

  return (
    <div>
      <PageHeader title="AI 价值中心" subtitle="查看 AI 助手为你创造的价值" />
      {usage && (
        <div className="grid gap-6 md:grid-cols-3 p-6">
          <Card>
            <CardContent className="p-6 text-center">
              <div className="text-3xl font-bold text-emerald-600">¥{usage.suggestionsSavings.toLocaleString()}</div>
              <p className="text-sm text-muted-foreground mt-2">💰 本月 AI 帮你增收</p>
              <p className="text-xs text-muted-foreground mt-1">采纳 {usage.insightAdoptedCount}/{usage.insightCount} 条建议</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6 text-center">
              <div className="text-3xl font-bold">⏰ ~{Math.round(usage.actionCount * 0.3)}h</div>
              <p className="text-sm text-muted-foreground mt-2">节约时间</p>
              <p className="text-xs text-muted-foreground mt-1">{usage.actionCount} 次自动操作</p>
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-6 text-center">
              <div className="text-3xl font-bold">{usage.chatCount}</div>
              <p className="text-sm text-muted-foreground mt-2">本月对话</p>
              <p className="text-xs text-muted-foreground mt-1">消耗 ~{usage.tokensUsed.toLocaleString()} tokens (≈¥{usage.estimatedCost})</p>
            </CardContent>
          </Card>
        </div>
      )}
    </div>
  );
}
