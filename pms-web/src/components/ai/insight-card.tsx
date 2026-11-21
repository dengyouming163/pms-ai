'use client';

import { useState } from 'react';
import { Card, CardContent, CardFooter } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { apiPost } from '@/lib/api-client';
import { AI_INSIGHTS_URL } from '@/lib/constants';

interface InsightProps {
  id: string;
  agent: string;
  type: string;
  title: string;
  content: string;
  actionLevel: 'L1' | 'L2' | 'L3';
  confidence: number;
  priority: number;
}

const agentIcons: Record<string, string> = {
  '经营参谋长': '\u{1F9E0}',
  '收益管理师': '\u{1F4B0}',
  '客户关系管家': '\u{1F464}',
  '房务管家': '\u{1F527}',
};

const actionLevelLabels: Record<string, string> = { L1: '自动执行', L2: '需确认', L3: '需审核' };

export function InsightCard({ insight }: { insight: InsightProps }) {
  const [applied, setApplied] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const icon = agentIcons[insight.agent] || '\u{1F4CA}';
  const confidencePct = Math.round(insight.confidence * 100);
  if (dismissed) return null;

  return (
    <Card className={`${applied ? 'opacity-60' : ''} border-l-4 ${
      insight.priority >= 4 ? 'border-l-red-500' : insight.priority >= 3 ? 'border-l-amber-500' : 'border-l-emerald-500'}`}>
      <CardContent className="p-4">
        <div className="flex items-center gap-2 mb-2">
          <span>{icon}</span>
          <span className="text-xs font-medium text-muted-foreground">{insight.agent}</span>
          <Badge variant="outline" className="text-xs">{actionLevelLabels[insight.actionLevel]}</Badge>
          <Badge variant="secondary" className="text-xs">置信度 {confidencePct}%</Badge>
        </div>
        <h4 className="font-semibold text-sm mb-2">{insight.title}</h4>
        <p className="text-sm text-muted-foreground whitespace-pre-wrap line-clamp-3">{insight.content}</p>
      </CardContent>
      <CardFooter className="px-4 pb-3 pt-0 flex gap-2">
        {!applied && insight.actionLevel !== 'L3' && (
          <Button size="sm" onClick={async () => {
            await apiPost(`${AI_INSIGHTS_URL}/${insight.id}/apply`);
            setApplied(true);
          }}>{insight.actionLevel === 'L1' ? '采纳' : '确认执行'}</Button>
        )}
        {!applied && (
          <Button variant="ghost" size="sm" onClick={async () => {
            await apiPost(`${AI_INSIGHTS_URL}/${insight.id}/dismiss`);
            setDismissed(true);
          }}>忽略</Button>
        )}
        {applied && <span className="text-xs text-emerald-600">&#10004; 已执行</span>}
        <div className="flex-1" />
      </CardFooter>
    </Card>
  );
}
