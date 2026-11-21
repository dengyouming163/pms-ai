'use client';

import { useMode } from '@/lib/context/mode-context';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface CustomerInsight {
  id: string;
  name: string;
  tags: string[];
  vipLevel: string;
  totalSpent: number;
  visitCount: number;
  lastVisit: string;
  suggestedAction: string;
}

export function CustomerInsights({ customers }: { customers: CustomerInsight[] }) {
  const { isModuleAI } = useMode();
  if (!isModuleAI('customer') || !customers.length) return null;

  const vipColors: Record<string, string> = { '金卡': 'bg-amber-500', '银卡': 'bg-gray-400', '普通': 'bg-gray-200' };

  return (
    <div className="space-y-3 mt-6">
      <h3 className="text-sm font-semibold flex items-center gap-2">👤 AI 客户洞察</h3>
      <div className="grid gap-3 md:grid-cols-2">
        {customers.map(c => (
          <Card key={c.id}>
            <CardContent className="p-4">
              <div className="flex items-center justify-between mb-2">
                <span className="font-semibold">{c.name}</span>
                <Badge className={`${vipColors[c.vipLevel] || 'bg-gray-200'} text-white text-xs`}>{c.vipLevel}VIP</Badge>
              </div>
              <div className="flex flex-wrap gap-1 mb-2">
                {c.tags.map(t => <Badge key={t} variant="outline" className="text-xs">{t}</Badge>)}
              </div>
              <p className="text-xs text-muted-foreground">累计消费 ¥{c.totalSpent} · {c.visitCount}次入住 · 最近: {c.lastVisit}</p>
              {c.suggestedAction && <p className="text-xs text-emerald-600 mt-2">💡 {c.suggestedAction}</p>}
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
