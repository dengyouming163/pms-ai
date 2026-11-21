// OTA 直连 —— 抓取日志列表（按时间倒序展示每次抓取结果）
'use client';

import { Card } from '@/components/ui/card';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Badge } from '@/components/ui/badge';
import type { OtaCaptureLog } from '@/lib/ota-api';

interface Props {
  logs: OtaCaptureLog[];
}

// 抓取结果 → 展示文案与徽章样式映射
const RESULT_CONFIG: Record<string, { label: string; variant: 'default' | 'secondary' | 'destructive' | 'outline' }> = {
  success: { label: '成功', variant: 'default' },
  no_change: { label: '无变化', variant: 'secondary' },
  session_expired: { label: '登录失效', variant: 'destructive' },
  error: { label: '异常', variant: 'destructive' },
};

// 格式化抓取时间（月-日 时:分）
function formatTime(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

export function CaptureLogList({ logs }: Props) {
  if (logs.length === 0) {
    return (
      <Card className="p-5">
        <h4 className="font-medium mb-2">抓取日志</h4>
        <p className="text-sm text-muted-foreground text-center py-8">暂无抓取记录</p>
      </Card>
    );
  }

  return (
    <Card className="p-5">
      <h4 className="font-medium mb-3">抓取日志</h4>
      <ScrollArea className="h-64">
        <div className="space-y-2">
          {logs.map((log) => {
            const cfg = RESULT_CONFIG[log.result] || RESULT_CONFIG.error;
            return (
              <div key={log.id} className="flex items-center justify-between text-sm py-1.5 border-b border-slate-50 last:border-0">
                <div className="flex items-center gap-2">
                  <span className="text-muted-foreground text-xs w-12">{formatTime(log.capturedAt)}</span>
                  <Badge variant={cfg.variant} className="text-xs">{cfg.label}</Badge>
                </div>
                <span className="text-xs text-muted-foreground">
                  {log.newCount > 0 && `新增 ${log.newCount} 单 `}
                  {log.changeCount > 0 && `变更 ${log.changeCount} 单 `}
                  {log.errorMessage && <span className="text-red-500">{log.errorMessage}</span>}
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </Card>
  );
}
