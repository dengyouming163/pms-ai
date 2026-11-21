// OTA 直连管理页 —— 展示客户端设备状态、今日抓单统计与抓取日志
'use client';

import { useEffect, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { DeviceCard } from '@/components/ota/device-card';
import { CaptureLogList } from '@/components/ota/capture-log-list';
import { fetchOtaClients, fetchOtaStats, fetchOtaLogs, fetchOtaStoreKey, type OtaClientInfo, type OtaStats, type OtaCaptureLog } from '@/lib/ota-api';
import { toast } from 'sonner';

export default function OtaPage() {
  const [client, setClient] = useState<OtaClientInfo | null>(null);
  const [stats, setStats] = useState<OtaStats>({ todayNew: 0, todayChanged: 0, todayCancelled: 0 });
  const [logs, setLogs] = useState<OtaCaptureLog[]>([]);
  const [storeKey, setStoreKey] = useState('');
  const [loading, setLoading] = useState(true);

  // 并行加载设备状态、统计、日志与 Store Key
  async function loadData() {
    try {
      const [clients, s, l, keyData] = await Promise.all([
        fetchOtaClients(),
        fetchOtaStats(),
        fetchOtaLogs(20),
        fetchOtaStoreKey(),
      ]);
      setClient(clients[0] || null);
      setStats(s);
      setLogs(l);
      setStoreKey(keyData.storeKey);
    } catch {
      toast.error('加载 OTA 状态失败');
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { loadData(); }, []);

  if (loading) {
    return (
      <div className="p-6">
        <PageHeader title="OTA 直连" subtitle="美团渠道 RPA 自动抓单" />
        <div className="animate-pulse space-y-4 mt-6">
          <div className="h-48 bg-slate-100 rounded-2xl" />
          <div className="h-64 bg-slate-100 rounded-2xl" />
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <PageHeader title="OTA 直连" subtitle="美团渠道 RPA 自动抓单 · 订单数据由本地客户端自动上报" />
      <DeviceCard
        client={client}
        stats={stats}
        storeKey={storeKey}
        onManualSync={() => toast.info('同步指令已下发，请查看客户端状态')}
        onReLogin={() => toast.info('请在客户端托盘菜单中点击"登录美团"')}
        onViewLogs={() => document.getElementById('capture-logs')?.scrollIntoView({ behavior: 'smooth' })}
      />
      <div id="capture-logs">
        <CaptureLogList logs={logs} />
      </div>
    </div>
  );
}
