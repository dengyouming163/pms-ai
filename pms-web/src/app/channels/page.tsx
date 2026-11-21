'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { toast } from 'sonner';
import { useAiStore } from '@/lib/context/ai-store-context';
import { PageHeader } from '@/components/page-header';
import { TabBar } from '@/components/tab-bar';
import { Button } from '@/components/ui/button';
import { Globe, Plus, Settings, X } from 'lucide-react';

interface ChannelItem {
  id: string; name: string; icon: string; color: string;
  category: string; commission: number; status: string;
  autoSync: boolean; account: string; features: string[]; description: string;
  storeId?: string;
}

const CATEGORY_LABELS: Record<string, string> = {
  domestic_ota: '国内OTA', international_ota: '国际OTA', content_platform: '内容平台',
  direct: '直销渠道', social: '社交媒体',
};

const tabs = [
  { key: 'store', label: '门店渠道配置' },
  { key: 'catalog', label: '平台渠道目录' },
];

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl border border-slate-100 p-5 ${className}`}>{children}</div>;
}

function ChannelsContent() {
  const [activeTab, setActiveTab] = useState('store');
  const [catalog, setCatalog] = useState<ChannelItem[]>([]);
  const [storeChannels, setStoreChannels] = useState<ChannelItem[]>([]);
  const [loading, setLoading] = useState(true);
  const { selectedStoreId, setSelectedStoreId, stores } = useAiStore();
  const [editChannel, setEditChannel] = useState<ChannelItem | null>(null);
  const [editCommission, setEditCommission] = useState('');
  const [editAccount, setEditAccount] = useState('');
  const [editAutoSync, setEditAutoSync] = useState(false);

  useEffect(() => {
    apiGet('/api/channels?catalog=1').then((d: any) => {
      setCatalog(d.channels || []);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    if (selectedStoreId) {
      setLoading(true);
      apiGet('/api/channels?storeId=' + selectedStoreId).then((d: any) => setStoreChannels(d.channels || [])).catch(() => {}).finally(() => setLoading(false));
    }
  }, [selectedStoreId]);

  const isStoreActive = (ch: ChannelItem) => storeChannels.some(s => (s.id === ch.id || s.name === ch.name) && s.status === 'active');
  const getStoreChannel = (ch: ChannelItem) => storeChannels.find(s => s.id === ch.id || s.name === ch.name);

  const groupedCatalog = catalog.reduce<Record<string, ChannelItem[]>>((acc, ch) => {
    const cat = ch.category || 'other';
    if (!acc[cat]) acc[cat] = [];
    acc[cat].push(ch);
    return acc;
  }, {});

  const handleOpenEdit = (ch: ChannelItem) => {
    const sc = getStoreChannel(ch);
    setEditChannel(ch);
    setEditCommission(String(sc?.commission || ch.commission));
    setEditAccount(sc?.account || '');
    setEditAutoSync(!!(sc?.autoSync ?? ch.autoSync));
  };

  const [saving, setSaving] = useState(false);

  const handleSaveStore = async () => {
    if (!editChannel) return;
    setSaving(true);
    try {
      await apiPost('/api/channels', {
        action: 'upsert-store', channelId: editChannel.id, storeId: selectedStoreId,
        commissionRate: Number(editCommission) || editChannel.commission,
        account: editAccount, autoSync: editAutoSync,
      });
      setEditChannel(null);
      const d = await apiGet('/api/channels?storeId=' + selectedStoreId) as any;
      setStoreChannels(d.channels || []);
    } catch (e: any) {
      toast.error('保存失败: ' + (e.message || '未知错误'));
    } finally {
      setSaving(false);
    }
  };

  const handleDisableStore = async (ch: ChannelItem) => {
    try {
      // 使用目录渠道ID，后端会自动匹配门店渠道
      await apiPost('/api/channels', { action: 'disable-store', channelId: ch.id, storeId: selectedStoreId });
      const d = await apiGet('/api/channels?storeId=' + selectedStoreId) as any;
      setStoreChannels(d.channels || []);
    } catch (e: any) {
      toast.error('停用失败: ' + (e.message || '未知错误'));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="渠道管理" subtitle="管理门店开通渠道、佣金率与同步配置" icon={<Globe className="w-5 h-5" />} />
      <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />

      {/* Tab 1: 门店配置 */}
      {activeTab === 'store' && (
        <div className="space-y-5">
          <Card>
            <div className="flex items-center gap-2 text-sm text-slate-600">
              📍 {stores.find(s => s.id === selectedStoreId)?.name || '当前门店'}
              <span className="text-xs text-slate-400 ml-2">{storeChannels.filter(c => c.status === 'active').length} 个渠道已开通</span>
            </div>
          </Card>

          {loading ? <p className="text-center py-8 text-slate-400">加载中...</p> : (
            <div className="grid grid-cols-2 gap-4">
              {catalog.map(ch => {
                const active = isStoreActive(ch);
                const sc = getStoreChannel(ch);
                return (
                  <Card key={ch.id} className={active ? 'ring-1 ring-emerald-200' : ''}>
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <span className="text-xl">{ch.icon}</span>
                        <div>
                          <span className="font-semibold text-sm text-slate-700">{ch.name}</span>
                          <span className="text-xs text-slate-400 ml-2">{CATEGORY_LABELS[ch.category] || ch.category}</span>
                        </div>
                      </div>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${active ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-400'}`}>
                        {active ? '已开通' : '未开通'}
                      </span>
                    </div>
                    {active && sc ? (
                      <div className="text-xs text-slate-500 space-y-1 mb-3">
                        <div className="flex items-center gap-4">
                          <span>佣金率: <strong className="text-slate-700">{sc.commission}%</strong></span>
                          <span>自动同步: <strong className={sc.autoSync ? 'text-emerald-600' : 'text-slate-400'}>{sc.autoSync ? '✅ 开启' : '❌ 关闭'}</strong></span>
                        </div>
                        {sc.account && <span>账号: <strong className="text-slate-700">{sc.account}</strong></span>}
                      </div>
                    ) : (
                      <p className="text-xs text-slate-400 mb-3">{ch.description}</p>
                    )}
                    <div className="flex gap-2">
                      <button onClick={() => handleOpenEdit(ch)} className="text-xs px-3 py-1.5 bg-blue-50 text-blue-600 rounded-lg hover:bg-blue-100 flex items-center gap-1">
                        <Settings className="w-3 h-3" /> {active ? '配置' : '开通'}
                      </button>
                      {active && (
                        <button onClick={() => handleDisableStore(ch)} className="text-xs px-3 py-1.5 bg-red-50 text-red-500 rounded-lg hover:bg-red-100 flex items-center gap-1">
                          <X className="w-3 h-3" /> 停用
                        </button>
                      )}
                    </div>
                  </Card>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* Tab 2: 平台渠道目录 */}
      {activeTab === 'catalog' && (
        <div className="space-y-6">
          {Object.entries(groupedCatalog).map(([cat, chs]) => (
            <div key={cat}>
              <h3 className="text-sm font-semibold text-slate-500 mb-3">{CATEGORY_LABELS[cat] || cat}</h3>
              <div className="grid grid-cols-2 gap-4">
                {chs.map(ch => (
                  <Card key={ch.id}>
                    <div className="flex items-center gap-3">
                      <span className="text-2xl">{ch.icon}</span>
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-semibold text-sm text-slate-700">{ch.name}</span>
                          <span className="text-xs text-slate-400">佣金 {ch.commission}%</span>
                        </div>
                        <p className="text-xs text-slate-400 mt-0.5">{ch.description}</p>
                      </div>
                      <div className="flex flex-wrap gap-1">
                        {(ch.features || []).slice(0, 3).map((f, i) => <span key={i} className="text-[10px] px-1.5 py-0.5 bg-slate-100 rounded text-slate-500">{f}</span>)}
                      </div>
                    </div>
                  </Card>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 编辑弹窗 */}
      {editChannel && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setEditChannel(null)}>
          <div className="bg-white rounded-2xl w-[400px] p-6 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-bold text-slate-800 mb-4">配置 {editChannel.icon} {editChannel.name}</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm text-slate-500 mb-1 block">佣金率 (%)</label>
                <input type="number" value={editCommission} onChange={e => setEditCommission(e.target.value)}
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm" />
              </div>
              <div>
                <label className="text-sm text-slate-500 mb-1 block">渠道账号</label>
                <input value={editAccount} onChange={e => setEditAccount(e.target.value)} placeholder="如：hotel_001@ctrip"
                  className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm" />
              </div>
              <label className="flex items-center gap-2 text-sm">
                <input type="checkbox" checked={editAutoSync} onChange={e => setEditAutoSync(e.target.checked)} />
                启用自动同步
              </label>
            </div>
            <div className="flex gap-3 mt-6">
              <Button onClick={() => setEditChannel(null)} variant="outline" className="flex-1" disabled={saving}>取消</Button>
              <Button onClick={handleSaveStore} className="flex-1 bg-emerald-500 text-white hover:bg-emerald-600" disabled={saving}>{saving ? '保存中...' : '保存并开通'}</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

export default function ChannelsPage() {
  return <ChannelsContent />;
}
