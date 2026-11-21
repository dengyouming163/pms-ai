'use client';

import { useState, useEffect } from 'react';
import { apiGet, apiPost } from '@/lib/api-client';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';

interface CustomerDetailProps {
  customerId: string;
  open: boolean;
  onClose: () => void;
}

export function CustomerDetailPanel({ customerId, open, onClose }: CustomerDetailProps) {
  const [profile, setProfile] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [actionLoading, setActionLoading] = useState('');
  const [tagInput, setTagInput] = useState('');
  const [showTagInput, setShowTagInput] = useState(false);

  useEffect(() => {
    if (!customerId || !open) return;
    const controller = new AbortController();
    setLoading(true);
    apiGet(`/api/customers?type=detail&id=${customerId}`)
      .then((d: any) => { if (!controller.signal.aborted) setProfile(d); })
      .catch((e) => { if (!controller.signal.aborted) console.error('Failed to load customer detail:', e); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [customerId, open]);

  if (!open) return null;

  const handleAction = async (action: string, body: any) => {
    setActionLoading(action);
    try {
      await apiPost('/api/customers', { action, ...body });
      const d = await apiGet(`/api/customers?type=detail&id=${customerId}`);
      setProfile(d);
    } catch (e: any) {
      toast.error(e?.message || '操作失败');
    } finally {
      setActionLoading('');
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end" onClick={onClose}>
      <div className="absolute inset-0 bg-black/20" />
      <div className="relative w-[420px] bg-white h-full shadow-2xl overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-3 flex items-center justify-between z-10">
          <h2 className="text-base font-bold text-slate-800">客户画像</h2>
          <button onClick={onClose} className="text-slate-400 hover:text-slate-600 text-xl">×</button>
        </div>

        {loading ? (
          <p className="text-center py-12 text-slate-400">加载中...</p>
        ) : profile ? (
          <div className="p-5 space-y-4">
            <div className="text-center pb-4 border-b">
              <span className="text-4xl">{profile.memberLevel?.icon || profile.memberLevelIcon || '🎫'}</span>
              <h3 className="text-lg font-bold text-slate-800 mt-2">{profile.name}</h3>
              <p className="text-sm text-slate-500">{profile.phone}</p>
              <p className="text-xs text-slate-400 mt-1">{profile.memberLevel?.name || profile.memberLevelName} · 价值分 {profile.valueScore || 0}</p>
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              {[
                { label: '累计消费', value: `¥${(profile.totalSpent || 0).toLocaleString()}` },
                { label: '入住次数', value: `${profile.stayCount || 0} 次` },
                { label: '最近入住', value: profile.lastStayDate || '暂无' },
              ].map((item, i) => (
                <div key={i} className="bg-slate-50 rounded-xl p-3">
                  <p className="text-lg font-bold text-slate-700">{item.value}</p>
                  <p className="text-[10px] text-slate-400">{item.label}</p>
                </div>
              ))}
            </div>

            {profile.orderHistory && profile.orderHistory.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-600 mb-2">📋 订单历史</h4>
                <div className="space-y-2 max-h-48 overflow-y-auto custom-scroll">
                  {profile.orderHistory.slice(0, 10).map((o: any, i: number) => (
                    <div key={i} className="p-2.5 bg-slate-50 rounded-lg text-xs">
                      <div className="flex justify-between">
                        <span className="font-medium text-slate-700">{o.roomType}</span>
                        <span className="text-slate-500">¥{o.totalPrice}</span>
                      </div>
                      <div className="flex justify-between mt-1 text-slate-400">
                        <span>{o.checkIn} → {o.checkOut}</span>
                        <span>{o.channel}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="space-y-2 pt-2 border-t">
              <Button onClick={() => handleAction('sendCare', { customerId, customerName: profile.name, type: 'rebuy', content: '系统推荐关怀提醒', dueDate: new Date().toISOString().split('T')[0] })} disabled={actionLoading === 'care'} variant="outline" className="w-full justify-start text-sm">💌 {actionLoading === 'care' ? '...' : '发关怀提醒'}</Button>
              {profile.memberLevel?.key !== 'diamond' && (
                <Button onClick={() => handleAction('editCustomer', { customerId, memberLevel: profile.memberLevel?.key === 'gold' ? 'diamond' : profile.memberLevel?.key === 'silver' ? 'gold' : 'silver' })} disabled={actionLoading === 'vip'} variant="outline" className="w-full justify-start text-sm">⭐ {actionLoading === 'vip' ? '...' : '升级 VIP'}</Button>
              )}
              <Button onClick={() => setShowTagInput(!showTagInput)} disabled={actionLoading === 'tag'} variant="outline" className="w-full justify-start text-sm">🏷️ {actionLoading === 'tag' ? '...' : '编辑标签'}</Button>
              {showTagInput && (
                <div className="flex gap-2 mt-2">
                  <Input value={tagInput} onChange={e => setTagInput(e.target.value)} placeholder="输入标签名，回车确认" className="flex-1 h-8 text-sm"
                    onKeyDown={e => { if (e.key === 'Enter' && tagInput.trim()) { handleAction('tagCustomer', { customerId, tagName: tagInput.trim() }); setShowTagInput(false); setTagInput(''); } }} />
                  <Button size="sm" onClick={() => { if (tagInput.trim()) { handleAction('tagCustomer', { customerId, tagName: tagInput.trim() }); setShowTagInput(false); setTagInput(''); } }} disabled={!tagInput.trim()}>确定</Button>
                  <Button size="sm" variant="ghost" onClick={() => { setShowTagInput(false); setTagInput(''); }}>取消</Button>
                </div>
              )}
            </div>
          </div>
        ) : (
          <p className="text-center py-12 text-slate-400">客户不存在</p>
        )}
      </div>
    </div>
  );
}
