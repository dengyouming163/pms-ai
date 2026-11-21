'use client';

import { useMode } from '@/lib/context/mode-context';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';

interface OTAAlert {
  id: string;
  channel: string;
  orderNo: string;
  guestName: string;
  minutesRemaining: number;
  severity: 'urgent' | 'warning';
}

export function OTAAlerts({ alerts }: { alerts: OTAAlert[] }) {
  const { isModuleAI } = useMode();
  if (!isModuleAI('ota_bridge') || !alerts.length) return null;

  return (
    <div className="space-y-3 mt-6">
      <h3 className="text-sm font-semibold flex items-center gap-2">📡 OTA 超时预警</h3>
      <div className="grid gap-2">
        {alerts.map(a => (
          <Card key={a.id} className="border-l-4 border-l-red-500 bg-red-50">
            <CardContent className="p-3 flex items-center justify-between">
              <div>
                <span className="font-semibold text-sm">{a.channel}</span>
                <span className="text-xs text-muted-foreground ml-2">{a.orderNo} · {a.guestName}</span>
                <span className="text-xs text-red-600 ml-2">剩余 {a.minutesRemaining} 分钟</span>
              </div>
              <Button size="sm" variant="destructive">立即处理</Button>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
}
