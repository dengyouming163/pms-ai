'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import { PageHeader } from '@/components/page-header';
import { TabBar } from '@/components/tab-bar';
import { useHasPermission } from '@/lib/auth/auth-context';
import { cn } from '@/lib/utils';
import {
  Sparkles, AlertTriangle, CalendarDays, Check, X, TrendingUp, TrendingDown, CheckCircle2,
} from 'lucide-react';
import {
  pricingCenterApi,
  type PricingTodayRoom,
  type PricingTodayData,
  type PricingSettings,
  type PricingBasePrice,
  type PricingOverviewDay,
} from '@/lib/pricing-center-api';

const tabs = [
  { key: 'today', label: '今日推荐' },
  { key: 'settings', label: '手动设置' },
];

// 手动设置里的可选同步渠道
const CHANNEL_OPTIONS = ['携程', '美团', '直营'];

interface ToastState {
  type: 'success' | 'error';
  text: string;
}

// 页面级消息条状态管理（成功/失败提示，2.5s 自动消失）
function useToast() {
  const [toast, setToast] = useState<ToastState | null>(null);
  const timer = useRef<number | null>(null);
  const showToast = useCallback((text: string, type: 'success' | 'error' = 'success') => {
    if (timer.current) window.clearTimeout(timer.current);
    setToast({ type, text });
    timer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);
  return { toast, showToast };
}

// 固定顶部消息条
function ToastBar({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div
      className={cn(
        'fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 text-white px-5 py-3 rounded-xl shadow-lg text-sm font-medium animate-in fade-in slide-in-from-top-2',
        toast.type === 'success' ? 'bg-emerald-600 shadow-emerald-500/25' : 'bg-red-600 shadow-red-500/25',
      )}
    >
      {toast.type === 'success' ? <Check className="w-4 h-4" /> : <AlertTriangle className="w-4 h-4" />}
      {toast.text}
    </div>
  );
}

export default function PricingCenterPage() {
  const canEdit = useHasPermission('pricing:edit');
  const [activeTab, setActiveTab] = useState('today');

  // 今日推荐
  const [today, setToday] = useState<PricingTodayData | null>(null);
  const [loadingToday, setLoadingToday] = useState(true);
  // 采纳预览弹窗
  const [adoptPreview, setAdoptPreview] = useState<PricingTodayRoom | null>(null);
  const [previewChannels, setPreviewChannels] = useState<string[]>([]);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [adopting, setAdopting] = useState(false);
  const [undoingId, setUndoingId] = useState<string | null>(null);

  const { toast, showToast } = useToast();

  const loadToday = useCallback(() => {
    setLoadingToday(true);
    pricingCenterApi
      .getToday()
      .then((d) => {
        if (d?.success) {
          setToday(d.data);
        } else {
          setToday(null);
          showToast((d as any)?.error || '加载今日推荐失败', 'error');
        }
      })
      .catch((e: any) => showToast('加载今日推荐失败：' + (e.message || '未知错误'), 'error'))
      .finally(() => setLoadingToday(false));
  }, [showToast]);

  useEffect(() => { loadToday(); }, [loadToday]);

  // 采纳：打开预览弹窗时读取启用渠道
  const openAdoptPreview = (room: PricingTodayRoom) => {
    setAdoptPreview(room);
    setPreviewLoading(true);
    setPreviewChannels([]);
    pricingCenterApi
      .getSettings()
      .then((d) => setPreviewChannels(d?.success ? (d.data.channels || []) : []))
      .catch(() => setPreviewChannels([]))
      .finally(() => setPreviewLoading(false));
  };

  const confirmAdopt = async () => {
    if (!adoptPreview || adoptPreview.suggestedPrice == null) return;
    setAdopting(true);
    try {
      const d = await pricingCenterApi.adopt({ roomTypeId: adoptPreview.roomTypeId, price: adoptPreview.suggestedPrice });
      if (d?.success) {
        showToast(`已采纳 ¥${d.data.price}，正在同步 OTA…`);
        setAdoptPreview(null);
        loadToday();
      } else {
        showToast((d as any)?.error || '采纳失败', 'error');
      }
    } catch (e: any) {
      showToast('采纳失败：' + (e.message || '未知错误'), 'error');
    } finally {
      setAdopting(false);
    }
  };

  const handleUndo = async (room: PricingTodayRoom) => {
    setUndoingId(room.roomTypeId);
    try {
      const d = await pricingCenterApi.undo({ roomTypeId: room.roomTypeId });
      if (d?.success) {
        showToast(`已撤销，回落到 ¥${d.data.fallbackPrice}`);
        loadToday();
      } else {
        showToast((d as any)?.error || '撤销失败', 'error');
      }
    } catch (e: any) {
      showToast('撤销失败：' + (e.message || '未知错误'), 'error');
    } finally {
      setUndoingId(null);
    }
  };

  // 出卡房型：有建议（suggestedPrice 非空）且未满房；已采纳的也展示（可撤销）
  const rooms = today?.rooms || [];
  const visibleRooms = rooms.filter((r) => (!r.soldOut && r.suggestedPrice !== null) || !!r.dailySource);
  const noChange = rooms.filter((r) => !r.soldOut && r.suggestedPrice === null && !r.dailySource);
  const soldOutCount = rooms.filter((r) => r.soldOut).length;

  return (
    <div className="space-y-5">
      <PageHeader title="定价中心" subtitle="智能推荐 · 一键同步 OTA" icon={<Sparkles className="w-5 h-5" />} />

      <ToastBar toast={toast} />

      <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />

      {/* ===== 今日推荐 ===== */}
      {activeTab === 'today' && (
        <div className="space-y-4">
          {today && !today.recommendationEnabled && (
            <div className="flex items-center gap-2 bg-amber-50 border border-amber-200 rounded-xl px-4 py-3 text-sm text-amber-700">
              <AlertTriangle className="w-4 h-4" />
              <span>智能推荐已关闭，可在「手动设置」开启</span>
            </div>
          )}

          {today && (
            <div className="flex items-center gap-2 text-sm text-slate-500">
              <CalendarDays className="w-4 h-4" />
              <span>{today.dateLabel}</span>
              {soldOutCount > 0 && <span className="text-xs text-slate-400 ml-auto">{soldOutCount} 个房型已满房</span>}
            </div>
          )}

          {loadingToday ? (
            <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
              {[1, 2, 3].map((i) => (
                <div key={i} className="bg-white rounded-2xl border border-slate-200 p-5 space-y-3 animate-pulse">
                  <div className="h-4 bg-slate-100 rounded w-1/3" />
                  <div className="h-7 bg-slate-100 rounded w-1/2" />
                  <div className="h-3 bg-slate-100 rounded w-2/3" />
                  <div className="h-9 bg-slate-100 rounded w-full" />
                </div>
              ))}
            </div>
          ) : visibleRooms.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-10 text-center">
              <p className="text-slate-500">今日暂无推荐，所有房型价格均已最优</p>
            </div>
          ) : (
            <>
              {noChange.length > 0 && (
                <div className="text-xs text-slate-400">{noChange.length} 个房型今日无需调整</div>
              )}
              <div className="grid grid-cols-1 lg:grid-cols-2 xl:grid-cols-3 gap-4">
                {visibleRooms.map((room) => {
                  const adopted = !!room.dailySource;
                  const changePct = room.currentPrice > 0 ? Math.round((room.change / room.currentPrice) * 100) : 0;
                  return (
                    <div key={room.roomTypeId} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5 flex flex-col gap-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <h3 className="font-semibold text-slate-800">{room.roomTypeName}</h3>
                          {room.holiday && (
                            <span className="text-xs px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">{room.holiday}</span>
                          )}
                        </div>
                        {adopted && (
                          <span className="flex items-center gap-1 text-xs px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-600">
                            <CheckCircle2 className="w-3 h-3" />已采纳 ¥{room.currentPrice}
                          </span>
                        )}
                      </div>

                      {/* 价格区 */}
                      {adopted ? (
                        <div className="flex items-end gap-2">
                          <span className="text-2xl font-bold text-slate-800">¥{room.currentPrice}</span>
                          <span className="text-xs text-slate-400 mb-1 line-through">默认 ¥{room.defaultPrice}</span>
                        </div>
                      ) : (
                        <div className="flex items-end gap-2">
                          <span className="text-sm text-slate-400 line-through mb-1">¥{room.currentPrice}</span>
                          <span className="text-2xl font-bold text-emerald-600">¥{room.suggestedPrice}</span>
                          {room.change !== 0 && (
                            <span
                              className={cn(
                                'flex items-center text-xs font-medium px-2 py-0.5 rounded-full mb-0.5',
                                room.change > 0 ? 'bg-red-50 text-red-600' : 'bg-emerald-50 text-emerald-600',
                              )}
                            >
                              {room.change > 0 ? <TrendingUp className="w-3 h-3 mr-0.5" /> : <TrendingDown className="w-3 h-3 mr-0.5" />}
                              {room.change > 0 ? '+' : ''}{changePct}%
                            </span>
                          )}
                        </div>
                      )}

                      {/* 数据区 */}
                      <div className="flex items-center gap-4 text-xs text-slate-500">
                        <span>剩余 <b className="text-slate-700">{room.remaining}/{room.total}</b> 间</span>
                        <span>入住率 <b className="text-slate-700">{room.occupancyPct}%</b></span>
                        {room.minPrice != null && <span>底价 <b className="text-slate-700">¥{room.minPrice}</b></span>}
                      </div>

                      {/* 推荐理由 */}
                      {room.reasons.length > 0 && (
                        <div className="space-y-1">
                          {room.reasons.map((reason, i) => (
                            <p key={i} className="text-xs text-slate-600 bg-slate-50 rounded-lg px-2.5 py-1.5">{reason}</p>
                          ))}
                        </div>
                      )}

                      {/* 操作 */}
                      <div className="flex justify-end pt-1">
                        {adopted ? (
                          <button
                            onClick={() => handleUndo(room)}
                            disabled={undoingId === room.roomTypeId}
                            className="px-4 py-2 text-xs font-medium rounded-xl border border-slate-200 text-slate-600 hover:bg-slate-50 disabled:opacity-50 disabled:cursor-not-allowed"
                          >
                            {undoingId === room.roomTypeId ? '撤销中…' : '撤销采纳'}
                          </button>
                        ) : canEdit ? (
                          <button
                            onClick={() => openAdoptPreview(room)}
                            className="px-4 py-2 text-xs font-medium rounded-xl bg-gradient-to-r from-emerald-500 to-emerald-600 text-white hover:shadow-lg hover:shadow-emerald-500/25 transition-shadow"
                          >
                            采纳
                          </button>
                        ) : null}
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
        </div>
      )}

      {/* ===== 手动设置 ===== */}
      {activeTab === 'settings' && <SettingsPanel canEdit={canEdit} />}

      {/* ===== 采纳预览弹窗 ===== */}
      {adoptPreview && adoptPreview.suggestedPrice != null && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center p-4" onClick={() => setAdoptPreview(null)}>
          <div className="bg-white rounded-2xl w-[440px] shadow-xl" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-800">采纳推荐</h3>
              <button onClick={() => setAdoptPreview(null)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm font-medium text-slate-700">{adoptPreview.roomTypeName}</span>
                <span className="text-2xl font-bold text-emerald-600">¥{adoptPreview.suggestedPrice}</span>
              </div>
              <div>
                <p className="text-xs text-slate-400 mb-2">确认后将自动同步到以下渠道</p>
                <div className="flex flex-wrap gap-2">
                  {previewLoading ? (
                    <span className="text-xs text-slate-400">加载渠道中…</span>
                  ) : previewChannels.length > 0 ? (
                    previewChannels.map((ch) => (
                      <span key={ch} className="text-xs px-2.5 py-1 rounded-lg bg-slate-50 border border-slate-200 text-slate-600">{ch}</span>
                    ))
                  ) : (
                    <span className="text-xs text-slate-400">未配置渠道</span>
                  )}
                </div>
              </div>
              {adoptPreview.reasons.length > 0 && (
                <div className="bg-slate-50 rounded-xl p-3 text-xs text-slate-600 space-y-1">
                  {adoptPreview.reasons.map((r, i) => <p key={i}>{r}</p>)}
                </div>
              )}
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-100">
              <button
                onClick={() => setAdoptPreview(null)}
                className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50"
              >
                取消
              </button>
              <button
                onClick={confirmAdopt}
                disabled={adopting}
                className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {adopting ? '同步中…' : `确认采纳 ¥${adoptPreview.suggestedPrice}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 手动设置面板：基础价 + 节假日加价% + 渠道 + 智能推荐开关 + 未来 7 天价格一览 =====
function SettingsPanel({ canEdit }: { canEdit: boolean }) {
  const [settings, setSettings] = useState<PricingSettings | null>(null);
  const [overview, setOverview] = useState<PricingOverviewDay[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  // 表单状态
  const [holidayMarkup, setHolidayMarkup] = useState('');
  const [recommendationEnabled, setRecommendationEnabled] = useState(true);
  const [channels, setChannels] = useState<string[]>([]);
  // 每房型 平日/周末/最低价（字符串，留空 = 不修改）
  const [prices, setPrices] = useState<Record<string, { weekday: string; weekend: string; min: string }>>({});

  const { toast, showToast } = useToast();

  const load = useCallback(() => {
    setLoading(true);
    Promise.all([pricingCenterApi.getSettings(), pricingCenterApi.getOverview(7)])
      .then(([s, o]) => {
        if (s?.success && s.data) {
          setSettings(s.data);
          setHolidayMarkup(String(s.data.holidayMarkupPct ?? 0));
          setRecommendationEnabled(!!s.data.recommendationEnabled);
          setChannels(s.data.channels || []);
          const map: Record<string, { weekday: string; weekend: string; min: string }> = {};
          (s.data.basePrices || []).forEach((b: PricingBasePrice) => {
            map[b.roomTypeId] = {
              weekday: b.weekdayPrice != null ? String(b.weekdayPrice) : '',
              weekend: b.weekendPrice != null ? String(b.weekendPrice) : '',
              min: b.minPrice != null ? String(b.minPrice) : '',
            };
          });
          setPrices(map);
        }
        if (o?.success && o.data) setOverview(o.data.days || []);
      })
      .catch((e: any) => showToast('加载设置失败：' + (e.message || '未知错误'), 'error'))
      .finally(() => setLoading(false));
  }, [showToast]);

  useEffect(() => { load(); }, [load]);

  const toggleChannel = (ch: string) => {
    setChannels((prev) => (prev.includes(ch) ? prev.filter((c) => c !== ch) : [...prev, ch]));
  };

  const updatePrice = (roomTypeId: string, field: 'weekday' | 'weekend' | 'min', value: string) => {
    setPrices((prev) => {
      const cur = prev[roomTypeId] || { weekday: '', weekend: '', min: '' };
      const next = { ...cur };
      if (field === 'weekday') next.weekday = value;
      else if (field === 'weekend') next.weekend = value;
      else next.min = value;
      return { ...prev, [roomTypeId]: next };
    });
  };

  const save = async () => {
    if (!settings) return;

    // 组装基础价（留空项不提交）
    const basePrices = (settings.basePrices || []).map((b) => {
      const p = prices[b.roomTypeId];
      const item: { roomTypeId: string; weekdayPrice?: number; weekendPrice?: number; minPrice?: number } = { roomTypeId: b.roomTypeId };
      if (p) {
        if (p.weekday !== '') item.weekdayPrice = Number(p.weekday);
        if (p.weekend !== '') item.weekendPrice = Number(p.weekend);
        if (p.min !== '') item.minPrice = Number(p.min);
      }
      return item;
    });
    const body: Record<string, unknown> = { basePrices };
    const hm = Number(holidayMarkup);
    if (holidayMarkup !== '' && !Number.isNaN(hm)) body.holidayMarkupPct = hm;
    body.recommendationEnabled = recommendationEnabled;
    body.channels = channels;

    // 前端基本校验（与后端一致，避免无意义请求）
    if (channels.length === 0) { showToast('请至少选择一个同步渠道', 'error'); return; }
    const invalid = basePrices.some((b) =>
      (b.weekdayPrice != null && (!Number.isFinite(b.weekdayPrice) || b.weekdayPrice < 0)) ||
      (b.weekendPrice != null && (!Number.isFinite(b.weekendPrice) || b.weekendPrice < 0)) ||
      (b.minPrice != null && (!Number.isFinite(b.minPrice) || b.minPrice < 0)));
    if (invalid) { showToast('价格需为≥0的数字', 'error'); return; }
    if (holidayMarkup !== '' && (Number.isNaN(hm) || hm < 0 || hm > 100)) { showToast('节假日加价%需在 0-100 之间', 'error'); return; }

    setSaving(true);
    try {
      const res = await pricingCenterApi.saveSettings(body);
      if (res?.success) {
        showToast('设置已保存');
        load();
      } else {
        showToast((res as any)?.error || '保存失败', 'error');
      }
    } catch (e: any) {
      showToast('保存失败：' + (e.message || '未知错误'), 'error');
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return (
      <div className="space-y-4">
        <div className="bg-white rounded-2xl border border-slate-200 p-5 space-y-4 animate-pulse">
          <div className="h-5 bg-slate-100 rounded w-1/3" />
          <div className="h-24 bg-slate-100 rounded w-full" />
          <div className="h-24 bg-slate-100 rounded w-full" />
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <ToastBar toast={toast} />

      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <h3 className="text-base font-semibold text-slate-800 mb-4">基础价格与渠道</h3>

        {/* 渠道 / 节假日加价 / 智能推荐 */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-6">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">同步渠道</label>
            <div className="flex flex-wrap gap-2">
              {CHANNEL_OPTIONS.map((ch) => {
                const checked = channels.includes(ch);
                return (
                  <button
                    key={ch}
                    type="button"
                    onClick={() => { if (canEdit) toggleChannel(ch); }}
                    disabled={!canEdit}
                    className={cn(
                      'flex items-center gap-2 px-3 py-2 rounded-xl border text-sm font-medium transition-colors',
                      checked ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-400 border-slate-200',
                      !canEdit && 'cursor-not-allowed opacity-70',
                    )}
                  >
                    <span className={cn('w-4 h-4 rounded flex items-center justify-center', checked ? 'bg-emerald-500 text-white' : 'border border-slate-300')}>
                      {checked && <Check className="w-3 h-3" />}
                    </span>
                    {ch}
                  </button>
                );
              })}
            </div>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">节假日加价</label>
            <div className="relative">
              <input
                type="number"
                min={0}
                max={100}
                value={holidayMarkup}
                disabled={!canEdit}
                onChange={(e) => setHolidayMarkup(e.target.value)}
                className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 disabled:bg-slate-50 disabled:text-slate-400"
              />
              <span className="absolute right-4 top-1/2 -translate-y-1/2 text-sm text-slate-400">%</span>
            </div>
            <p className="text-xs text-slate-400 mt-1">节假日价 = 平日/周末价 ×（1 + 加价%）</p>
          </div>
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-2">智能推荐</label>
            <button
              type="button"
              onClick={() => { if (canEdit) setRecommendationEnabled(!recommendationEnabled); }}
              disabled={!canEdit}
              className="flex items-center gap-2 disabled:cursor-not-allowed"
            >
              <span className={cn('w-10 h-5 rounded-full relative transition-colors', recommendationEnabled ? 'bg-emerald-500' : 'bg-slate-300')}>
                <span className={cn('absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all', recommendationEnabled ? 'left-[22px]' : 'left-0.5')} />
              </span>
              <span className="text-sm text-slate-700">{recommendationEnabled ? '已开启' : '已关闭'}</span>
            </button>
            <p className="text-xs text-slate-400 mt-1">开启后每天自动生成房型推荐卡</p>
          </div>
        </div>

        {/* 每房型基础价 */}
        <div className="overflow-hidden rounded-xl border border-slate-200">
          <table className="w-full">
            <thead className="bg-slate-50">
              <tr>
                <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">房型</th>
                <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">基准价</th>
                <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">平日价</th>
                <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">周末价</th>
                <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">最低价</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {(settings?.basePrices || []).map((b) => {
                const p = prices[b.roomTypeId] || { weekday: '', weekend: '', min: '' };
                return (
                  <tr key={b.roomTypeId} className="hover:bg-slate-50/50">
                    <td className="px-5 py-3">
                      <span className="text-sm font-semibold text-slate-800">{b.roomTypeName}</span>
                      <span className="text-xs text-slate-400 ml-2">当前 ¥{b.weekdayPrice}/{b.weekendPrice}</span>
                    </td>
                    <td className="px-5 py-3 text-center text-sm text-slate-600">¥{b.basePrice}</td>
                    {(
                      [
                        { field: 'weekday' as const, label: '平日价' },
                        { field: 'weekend' as const, label: '周末价' },
                        { field: 'min' as const, label: '最低价' },
                      ]
                    ).map(({ field, label }) => (
                      <td key={field} className="px-5 py-3 text-center">
                        <input
                          type="number"
                          min={0}
                          value={p[field]}
                          disabled={!canEdit}
                          onChange={(e) => updatePrice(b.roomTypeId, field, e.target.value)}
                          placeholder="不修改"
                          aria-label={`${b.roomTypeName} ${label}`}
                          className="w-24 px-3 py-2 border border-slate-200 rounded-xl text-sm text-center focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 disabled:bg-slate-50 disabled:text-slate-400"
                        />
                      </td>
                    ))}
                  </tr>
                );
              })}
              {(settings?.basePrices || []).length === 0 && (
                <tr>
                  <td colSpan={5} className="px-5 py-8 text-center text-sm text-slate-400">暂无房型数据</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        <p className="text-xs text-slate-400 mt-2">留空表示不修改该项；最低价是所有促销与动态调价的保护底线。</p>

        <div className="mt-5 flex justify-end">
          {canEdit && (
            <button
              onClick={save}
              disabled={saving}
              className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-medium rounded-xl hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {saving ? '保存中…' : '保存设置'}
            </button>
          )}
        </div>
      </div>

      {/* 未来 7 天价格一览 */}
      <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <CalendarDays className="w-4 h-4 text-slate-400" />
          <h3 className="text-base font-semibold text-slate-800">未来 7 天价格一览</h3>
          <span className="text-xs text-slate-400">已采纳价带标记</span>
        </div>
        {overview.length === 0 ? (
          <p className="text-sm text-slate-400 py-6 text-center">暂无价格数据</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px]">
              <thead>
                <tr className="border-b border-slate-200">
                  <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500">日期</th>
                  {(settings?.basePrices || []).map((b) => (
                    <th key={b.roomTypeId} className="text-center py-3 px-4 text-xs font-semibold text-slate-500">{b.roomTypeName}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {overview.map((day) => {
                  const isHoliday = day.label !== '' && day.label !== '周末';
                  const isWeekend = day.label === '周末';
                  return (
                    <tr key={day.date} className={cn(isHoliday && 'bg-amber-50/60', isWeekend && 'bg-blue-50/30')}>
                      <td className="py-3 px-4">
                        <span className="text-sm font-medium text-slate-700">{day.date.slice(5)}</span>
                        {day.label && (
                          <span className={cn('ml-2 text-xs px-2 py-0.5 rounded-full', isHoliday ? 'bg-amber-100 text-amber-700' : 'bg-blue-100 text-blue-700')}>
                            {day.label}
                          </span>
                        )}
                      </td>
                      {(settings?.basePrices || []).map((b) => {
                        const cell = day.roomTypes.find((rt) => rt.roomTypeId === b.roomTypeId);
                        return (
                          <td key={b.roomTypeId} className="py-3 px-4 text-center">
                            {cell ? (
                              <span className={cn('text-sm', cell.adopted ? 'font-bold text-emerald-600' : 'text-slate-600')}>
                                ¥{cell.price}
                                {cell.adopted && (
                                  <span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 ml-1 align-middle" title="已采纳" />
                                )}
                              </span>
                            ) : (
                              <span className="text-sm text-slate-300">—</span>
                            )}
                          </td>
                        );
                      })}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="mt-3 flex items-center gap-4 text-[11px] text-slate-400">
          <span><span className="inline-block w-1.5 h-1.5 rounded-full bg-emerald-500 mr-1" />已采纳价</span>
          <span><span className="inline-block w-3 h-2.5 rounded-sm bg-amber-100 border border-amber-200 mr-1" />节假日</span>
          <span><span className="inline-block w-3 h-2.5 rounded-sm bg-blue-50 border border-blue-100 mr-1" />周末</span>
        </div>
      </div>
    </div>
  );
}
