// OTA 直连 —— 客户端设备状态卡片（在线状态 / 今日统计 / 操作按钮）
'use client';

import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { RefreshCw, LogIn, FileText } from 'lucide-react';
import type { OtaClientInfo, OtaStats } from '@/lib/ota-api';

interface Props {
  client: OtaClientInfo | null;
  stats: OtaStats;
  storeKey?: string;
  onManualSync?: () => void;
  onReLogin?: () => void;
  onViewLogs?: () => void;
}

// 将时间转换为「多久之前」的中文描述
function timeAgo(dateStr: string | null): string {
  if (!dateStr) return '从未';
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

export function DeviceCard({ client, stats, storeKey, onManualSync, onReLogin, onViewLogs }: Props) {
  const isOnline = client?.status === 'online';
  const isSessionValid = client?.sessionValid ?? false;

  return (
    <Card className="p-5 space-y-4">
      {/* 头部：平台名称 + 在线状态 */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <span className="text-xl">🏨</span>
          <div>
            <h3 className="font-semibold text-lg">美团</h3>
            <p className="text-sm text-muted-foreground">
              {client ? (
                <>
                  <span className={`inline-block w-2 h-2 rounded-full mr-1.5 ${isOnline ? 'bg-green-500' : 'bg-gray-400'}`} />
                  {isOnline ? '在线' : '离线'}
                  {isOnline && isSessionValid && <> · 上次抓取 {timeAgo(client.lastCaptureAt)}</>}
                  {isOnline && !isSessionValid && <> · <span className="text-red-500">登录已过期</span></>}
                </>
              ) : (
                <span className="text-muted-foreground">未绑定设备</span>
              )}
            </p>
          </div>
        </div>
        {client && <Badge variant={isOnline ? 'default' : 'secondary'}>v{client.clientVersion || '1.0.0'}</Badge>}
      </div>

      {client && <p className="text-xs text-muted-foreground">设备：{client.deviceId}</p>}

      {/* 今日抓取统计 */}
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-blue-50 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-blue-600">{stats.todayNew}</div>
          <div className="text-xs text-blue-500">今日新单</div>
        </div>
        <div className="bg-amber-50 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-amber-600">{stats.todayChanged}</div>
          <div className="text-xs text-amber-500">状态变更</div>
        </div>
        <div className="bg-red-50 rounded-lg p-3 text-center">
          <div className="text-2xl font-bold text-red-600">{stats.todayCancelled}</div>
          <div className="text-xs text-red-500">今日取消</div>
        </div>
      </div>

      {/* 操作区：已绑定显示操作按钮，未绑定显示绑定引导 */}
      {client ? (
        <div className="flex gap-2">
          <Button variant="outline" size="sm" onClick={onManualSync}>
            <RefreshCw className="w-4 h-4 mr-1" />手动同步
          </Button>
          <Button variant="outline" size="sm" onClick={onReLogin}>
            <LogIn className="w-4 h-4 mr-1" />重新登录
          </Button>
          <Button variant="ghost" size="sm" onClick={onViewLogs}>
            <FileText className="w-4 h-4 mr-1" />查看日志
          </Button>
        </div>
      ) : (
        <div className="bg-slate-50 rounded-lg p-4 text-center">
          <p className="text-sm text-muted-foreground mb-2">请在商户电脑上安装智宿OTA客户端并输入门店 key 完成绑定</p>
          <p className="text-xs text-muted-foreground font-mono">
            门店 key：<code className="bg-slate-200 px-2 py-0.5 rounded">{storeKey || '加载中...'}</code>
            {storeKey && (
              <Button
                variant="ghost"
                size="sm"
                className="ml-1 h-6 px-2 text-xs"
                onClick={() => { navigator.clipboard.writeText(storeKey); }}
              >复制</Button>
            )}
          </p>
        </div>
      )}
    </Card>
  );
}
