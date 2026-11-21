'use client';

import { useState } from 'react';
import { useMode } from '@/lib/context/mode-context';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface PricingSuggestion {
  room_type: string;
  room_number: string;
  current_price: number;
  suggested_price: number;
  adjustment_pct: number;
  confidence: number;
  reasons: string[];
  risk_level: string;
}

export function PricingSuggestions({ suggestions }: { suggestions: PricingSuggestion[] }) {
  const { isModuleAI } = useMode();
  const [applied, setApplied] = useState<Set<string>>(new Set());
  if (!isModuleAI('pricing') || !suggestions.length) return null;

  const riskBadge = (level: string) => {
    const map: Record<string, { label: string; variant: 'default' | 'destructive' | 'secondary' }> = {
      L1: { label: '自动', variant: 'default' },
      L2: { label: '需确认', variant: 'secondary' },
      L3: { label: '需审核', variant: 'destructive' },
    };
    const info = map[level] || map.L2;
    return <Badge variant={info.variant} className="text-xs">{info.label}</Badge>;
  };

  return (
    <div className="space-y-3 mt-6">
      <h3 className="text-sm font-semibold flex items-center gap-2">💰 AI 定价建议</h3>
      <div className="grid gap-3">
        {suggestions.map((s, i) => (
          <Card key={i} className={applied.has(s.room_number) ? 'opacity-50' : ''}>
            <CardContent className="p-4 flex items-center justify-between">
              <div className="flex-1">
                <div className="flex items-center gap-2 mb-1">
                  <span className="font-semibold">{s.room_type} {s.room_number}</span>
                  {riskBadge(s.risk_level)}
                  <Badge variant="outline" className="text-xs">置信度 {Math.round(s.confidence * 100)}%</Badge>
                </div>
                <p className="text-sm">
                  <span className="line-through text-muted-foreground">¥{s.current_price}</span>
                  {' → '}
                  <span className="font-bold text-emerald-600">¥{s.suggested_price}</span>
                  <span className={`ml-2 text-xs ${s.adjustment_pct > 0 ? 'text-red-500' : 'text-green-500'}`}>
                    {s.adjustment_pct > 0 ? '+' : ''}{s.adjustment_pct.toFixed(1)}%
                  </span>
                </p>
                <p className="text-xs text-muted-foreground mt-1">{s.reasons.join(' · ')}</p>
              </div>
              {!applied.has(s.room_number) && (
                <Button size="sm" onClick={() => setApplied(prev => new Set([...prev, s.room_number]))}>
                  {s.risk_level === 'L1' ? '采纳' : '确认'}
                </Button>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
