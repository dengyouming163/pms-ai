'use client';

import { useMode } from '@/lib/context/mode-context';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';

interface HKAlert {
  id: string;
  roomNumber: string;
  roomType: string;
  status: string;
  hoursPending: number;
  severity: 'normal' | 'warning' | 'urgent';
}

export function HousekeepingAlerts({ alerts }: { alerts: HKAlert[] }) {
  const { isModuleAI } = useMode();
  if (!isModuleAI('housekeeping') || !alerts.length) return null;

  const severityColors: Record<string, string> = {
    urgent: 'border-l-red-500 bg-red-50',
    warning: 'border-l-amber-500 bg-amber-50',
    normal: 'border-l-blue-500',
  };

  return (
    <div className="space-y-3 mt-6">
      <h3 className="text-sm font-semibold flex items-center gap-2">🔧 AI 房务提醒</h3>
      <div className="grid gap-2">
        {alerts.map(a => (
          <Card key={a.id} className={`border-l-4 ${severityColors[a.severity]}`}>
            <CardContent className="p-3 flex items-center justify-between">
              <div>
                <span className="font-semibold text-sm">{a.roomNumber} ({a.roomType})</span>
                <span className="text-xs text-muted-foreground ml-2">
                  {a.status === 'dirty' ? `待清洁 · ${a.hoursPending}小时` : a.status}
                </span>
              </div>
              <Badge variant={a.severity === 'urgent' ? 'destructive' : 'secondary'} className="text-xs">
                {a.severity === 'urgent' ? '紧急' : a.severity === 'warning' ? '注意' : '正常'}
              </Badge>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
