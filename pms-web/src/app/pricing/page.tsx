'use client';

import { useEffect, useState } from 'react';
import { TabBar } from '@/components/tab-bar';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import {
  DollarSign, Plus, Edit2, ChevronLeft, ChevronRight, X, ToggleLeft, ToggleRight,
  TrendingUp, Zap, Clock, Users, Gift, Star, Eye, Timer,
  Package, AlertTriangle, AlertCircle, Check, Copy,
  RefreshCw, Info,
} from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api-client';
import { useHasPermission } from '@/lib/auth/auth-context';
import { PricingSuggestions } from '@/components/ai/pricing-suggestions';
import { useAiStore } from '@/lib/context/ai-store-context';

// 库存仪表盘组件
function InventoryDashboard() {
  const { selectedStoreId } = useAiStore();
  const [inv, setInv] = useState<any>(null);
  const [activeChannels, setActiveChannels] = useState<string[]>([]);
  useEffect(() => {
    apiGet('/api/inventory/overview').then((d: any) => setInv(d?.data)).catch(() => {});
    apiGet('/api/pricing?type=channel-pricing').then((d: any) => setActiveChannels((d?.channels || []).map((c: any) => c.name))).catch(() => {});
  }, [selectedStoreId]);
  if (!inv) return null;

  const channels = (Object.entries(inv.channelSold || {}) as [string, number][])
    .filter(([ch]) => activeChannels.length === 0 || activeChannels.includes(ch));
  const CH_ICONS: Record<string, string> = { '携程':'🏨','美团':'🍱','飞猪':'✈️','抖音':'🎵','途家':'🏡','直营':'🏪','直客':'🚶' };

  return (
    <div className="bg-white rounded-2xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <h3 className="font-semibold text-slate-700 text-sm">📊 库存概览</h3>
        <span className="text-[10px] text-slate-400">实时</span>
      </div>
      <div className="grid grid-cols-5 gap-3 mb-4">
        {[
          { label: '总房间', value: inv.total, color: 'text-slate-700' },
          { label: '可售', value: inv.available, color: 'text-emerald-600' },
          { label: '已入住', value: inv.occupied, color: 'text-blue-600' },
          { label: '脏房', value: inv.dirty, color: 'text-amber-600' },
          { label: '入住率', value: `${inv.occupancyRate}%`, color: 'text-purple-600' },
        ].map((m, i) => (
          <div key={i} className="bg-slate-50 rounded-xl p-3 text-center">
            <p className={`text-2xl font-bold ${m.color}`}>{m.value}</p>
            <p className="text-xs text-slate-400 mt-1">{m.label}</p>
          </div>
        ))}
      </div>
      {channels.length > 0 && (
        <div className="flex items-center gap-4 text-xs flex-wrap">
          <span className="text-slate-500">各渠道今日已售:</span>
          {channels.map(([ch, count]) => (
            <span key={ch} className="flex items-center gap-1 px-2 py-1 bg-slate-50 rounded-lg">
              <span>{CH_ICONS[ch] || '📌'}</span> {ch} <strong className="text-slate-700">{count}</strong>间
            </span>
          ))}
          {inv.available < 3 && <span className="px-2 py-1 bg-red-50 text-red-600 rounded-lg font-medium">⚠️ 库存紧张</span>}
        </div>
      )}
      {/* 渠道库存配额管理 */}
      <ChannelQuotaManager />
    </div>
  );
}

// 渠道库存配额管理组件
function ChannelQuotaManager() {
  const [quotas, setQuotas] = useState<Record<string, Record<string, number>>>({});
  const [channels, setChannels] = useState<string[]>([]);
  const [roomTypes, setRoomTypes] = useState<string[]>([]);
  const [editing, setEditing] = useState(false);

  useEffect(() => {
    apiGet('/api/pricing?type=channel-pricing').then((d: any) => setChannels((d?.channels || []).map((c: any) => c.name))).catch(() => {});
    apiGet('/api/stores?type=roomTypes').then((d: any) => setRoomTypes((Array.isArray(d) ? d : []).map((r: any) => r.name))).catch(() => {});
  }, []);

  if (channels.length === 0 || roomTypes.length === 0) return null;

  return (
    <div className="bg-white rounded-3xl border border-slate-200 p-5 shadow-sm">
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-2">
          <span className="text-lg">📦</span>
          <h3 className="font-bold text-sm text-slate-700">渠道库存配额</h3>
          <span className="text-[10px] text-slate-400 bg-slate-100 px-2 py-0.5 rounded-full">管理各渠道可卖房量</span>
        </div>
        <div className="flex items-center gap-2">
          {editing && (
            <button onClick={() => {
              // 智能自动分配：OTA渠道均分可售数，直营不限
              fetch('/api/inventory/overview').then(r => r.json()).then(d => {
                const available = d?.data?.available || 10;
                const otaChannels = channels.filter(c => c !== '直营' && c !== '直客');
                const perChannel = otaChannels.length > 0 ? Math.max(1, Math.floor(available * 0.7 / otaChannels.length)) : 0;
                const newQuotas: Record<string, Record<string, number>> = {};
                roomTypes.forEach(rt => {
                  newQuotas[rt] = {};
                  otaChannels.forEach(ch => { newQuotas[rt][ch] = perChannel; });
                });
                setQuotas(newQuotas);
              }).catch(() => {});
            }} className="text-xs px-3 py-2 bg-emerald-50 text-emerald-600 rounded-xl hover:bg-emerald-100 font-medium transition-colors">
              ⚡ 自动分配
            </button>
          )}
          <button onClick={() => setEditing(!editing)}
            className={`text-xs px-4 py-2 rounded-xl font-medium transition-all ${editing ? 'bg-slate-100 text-slate-600' : 'bg-blue-500 text-white shadow-sm'}`}>
            {editing ? '收起' : '管理配额'}
          </button>
        </div>
      </div>
      {editing && (
        <div className="bg-gradient-to-br from-slate-50 to-blue-50/30 rounded-2xl p-5 border border-slate-100">
          <table className="w-full">
            <thead>
              <tr className="border-b border-slate-200">
                <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500">房型</th>
                {channels.map(ch => (
                  <th key={ch} className="text-center py-3 px-3 text-xs font-semibold text-slate-500">{ch}</th>
                ))}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {roomTypes.map(rt => (
                <tr key={rt} className="hover:bg-white/50 transition-colors">
                  <td className="py-3 px-4 text-sm font-medium text-slate-700">{rt}</td>
                  {channels.map(ch => {
                    const val = quotas[rt]?.[ch] !== undefined ? quotas[rt][ch] : '';
                    return (
                      <td key={ch} className="py-2 px-3 text-center">
                        <input type="number" min={0} max={99} value={val}
                          onChange={e => {
                            const v = e.target.value === '' ? undefined : parseInt(e.target.value) || 0;
                            setQuotas(prev => ({ ...prev, [rt]: { ...(prev[rt] || {}), [ch]: v as number } }));
                          }}
                          className="w-16 px-3 py-2 border border-slate-200 rounded-xl text-sm font-bold text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-300 transition-all hover:border-slate-300"
                          placeholder="—" />
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          <div className="mt-4 flex items-center gap-2 text-[11px] text-slate-400">
            <span>💡</span>
            <span>留空=不限配额，填0=不分配。建议各渠道配额之和 ≤ 可售房间数。</span>
          </div>
        </div>
      )}
    </div>
  );
}

// ===== 类型定义 =====
interface BasePricing {
  id: string; roomType: string; basePrice: number; weekdayPrice: number;
  weekendPrice: number; holidayPrice: number; minPrice: number;
}

interface Promotion {
  id: string; name: string; type: string; description: string;
  discount: string; discountValue: number; discountUnit: string;
  condition: string; roomTypes: string[];
  validFrom: string; validTo: string;
  usageCount: number; usageLimit: number; status: string; priority: number;
}

interface CalendarRoomType {
  name: string; basePrice: number; finalPrice: number; plan: string;
  channelPrices: Record<string, number>; available: number; total: number;
  aiSuggestedPrice: number | null; aiReason: string; aiConfidence: number;
  competitorAvg: number; isBelowMin: boolean;
}

interface CalendarDay {
  date: string; weekday: string; isWeekend: boolean; isHoliday: boolean; holidayName: string;
  roomTypes: CalendarRoomType[];
}

const tabs = [
  { key: 'calendar', label: '价格日历' },
  { key: 'base', label: '基础房价' },
];

const promoTypeLabels: Record<string, { label: string; icon: React.ReactNode; color: string }> = {
  early_bird: { label: '早鸟优惠', icon: <Clock className="w-4 h-4" />, color: 'text-blue-600 bg-blue-50' },
  long_stay: { label: '连住优惠', icon: <Package className="w-4 h-4" />, color: 'text-purple-600 bg-purple-50' },
  last_minute: { label: '尾房甩卖', icon: <Zap className="w-4 h-4" />, color: 'text-orange-600 bg-orange-50' },
  flash_sale: { label: '限时特惠', icon: <Timer className="w-4 h-4" />, color: 'text-red-600 bg-red-50' },
  member_only: { label: '会员专享', icon: <Star className="w-4 h-4" />, color: 'text-amber-600 bg-amber-50' },
  new_customer: { label: '新客优惠', icon: <Users className="w-4 h-4" />, color: 'text-cyan-600 bg-cyan-50' },
  package: { label: '套餐', icon: <Gift className="w-4 h-4" />, color: 'text-pink-600 bg-pink-50' },
};

const CHANNEL_COLORS: Record<string, string> = {
  '携程': 'bg-blue-500', '美团': 'bg-amber-500', '飞猪': 'bg-sky-500',
  '抖音': 'bg-rose-500', '直营': 'bg-emerald-500',
};

export default function PricingPage() {
  const canEditPricing = useHasPermission('pricing:edit');
  const [activeTab, setActiveTab] = useState('calendar');
  const [baseData, setBaseData] = useState<BasePricing[]>([]);
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [calendar, setCalendar] = useState<CalendarDay[]>([]);
  const [summary, setSummary] = useState({ activePlans: 0, activePromotions: 0, channelCount: 0, avgCommission: '0%' });
  const [showModal, setShowModal] = useState('');
  const [editBaseId, setEditBaseId] = useState<string | null>(null);
  const [editBaseValues, setEditBaseValues] = useState<Record<string, number>>({});
  const [calendarMonth, setCalendarMonth] = useState(0);
  const [calendarChannel, setCalendarChannel] = useState('门店价');
  const [selectedDay, setSelectedDay] = useState<CalendarDay | null>(null);
  const [selectedRoomType, setSelectedRoomType] = useState<string>('');
  // 改价面板状态
  const [editPrices, setEditPrices] = useState<Record<string, number>>({});
  const [editChannelPrices, setEditChannelPrices] = useState<Record<string, number>>({});
  const [syncChannels, setSyncChannels] = useState<Record<string, boolean>>({});
  // 批量改价
  const [batchRange, setBatchRange] = useState({ start: '', end: '' });
  const [batchRoomType, setBatchRoomType] = useState('全部房型');
  const [batchApplyTo, setBatchApplyTo] = useState<Record<string, boolean>>({});
  const [batchMode, setBatchMode] = useState<'percentage' | 'fixed'>('percentage');
  const [batchValue, setBatchValue] = useState('');
  const [batchDayType, setBatchDayType] = useState<'all' | 'weekday' | 'weekend'>('all');
  // 批量调整基础房价
  const [batchBaseSelected, setBatchBaseSelected] = useState<string[]>([]);
  const [batchBaseMode, setBatchBaseMode] = useState('percentage_up');
  const [batchBaseValue, setBatchBaseValue] = useState('');
  const [batchBaseDayType, setBatchBaseDayType] = useState('all');
  const [batchBaseSaving, setBatchBaseSaving] = useState(false);
  // 促销表单状态
  const [promoForm, setPromoForm] = useState({ name: '', type: 'early_bird', discountMode: '百分比折扣', discountValue: '', roomType: '全部房型', condition: '', validFrom: '', validTo: '', usageLimit: '', priority: '3' });
  const [editPromoId, setEditPromoId] = useState<string | null>(null);
  // 改价成功提示
  const [saveSuccess, setSaveSuccess] = useState('');

  useEffect(() => {
    apiGet('/api/pricing').then((d) => {
      setBaseData(d.base);
      setPromotions(d.promotions);
      setSummary(d.summary);
    });
    apiGet('/api/pricing?type=calendar').then(setCalendar);
  }, []);

  // 价格日历按月分组
  const calendarSlice = calendar.slice(calendarMonth * 30, (calendarMonth + 1) * 30);
  const calendarMonthLabel = calendarSlice[0] ? `${calendarSlice[0].date.slice(0, 7)}` : '';
  // 从真实日历数据提取房型列表，渠道列表从门店启用渠道获取
  const roomTypeNames = calendar.length > 0 ? calendar[0].roomTypes.map(rt => rt.name) : [];
  const [CHANNEL_LIST, setChannelList] = useState<string[]>([]);
  useEffect(() => { apiGet('/api/pricing?type=channel-pricing').then((d: any) => setChannelList((d?.channels || []).map((c: any) => c.name))).catch(() => {}); }, []);

  // 打开改价面板
  const openPriceEditor = (day: CalendarDay, roomTypeName: string) => {
    setSelectedDay(day);
    setSelectedRoomType(roomTypeName);
    const rt = day.roomTypes.find((r) => r.name === roomTypeName);
    if (rt) {
      setEditPrices({ [roomTypeName]: rt.finalPrice });
      setEditChannelPrices({ ...rt.channelPrices });
      setSyncChannels(Object.fromEntries(Object.keys(rt.channelPrices).map((ch) => [ch, true])));
    }
    setShowModal('priceEditor');
  };

  // 门店价变更时同步渠道
  const handleStorePriceChange = (roomTypeName: string, newPrice: number, rt: CalendarRoomType) => {
    setEditPrices((prev) => ({ ...prev, [roomTypeName]: newPrice }));
    const ratio = newPrice / rt.finalPrice;
    const updated: Record<string, number> = {};
    Object.entries(editChannelPrices).forEach(([ch, price]) => {
      if (syncChannels[ch]) {
        updated[ch] = Math.round(price * ratio);
      } else {
        updated[ch] = price;
      }
    });
    setEditChannelPrices(updated);
  };

  // 保存成功提示
  const showSaveSuccess = (msg: string) => { setSaveSuccess(msg); setTimeout(() => setSaveSuccess(''), 2000); };

  // 促销开关切换
  const togglePromo = (id: string) => {
    setPromotions((prev) => prev.map((p) => p.id === id ? { ...p, status: p.status === 'active' ? 'disabled' : 'active' } : p));
  };

  // 保存基础房价
  // 刷新数据
  const refreshData = () => {
    apiGet('/api/pricing').then((d) => {
      setBaseData(d.base);
      setPromotions(d.promotions);
      setSummary(d.summary);
    });
    apiGet('/api/pricing?type=calendar').then(setCalendar);
  };

  const saveBasePrice = async () => {
    if (!editBaseId) return;
    try {
      await apiPost('/api/pricing', { action: 'updateRule', ruleId: editBaseId, ...editBaseValues });
      setShowModal('');
      showSaveSuccess('基础房价已保存');
      refreshData();
    } catch (e: any) {
      showSaveSuccess('保存失败：' + (e.message || '未知错误'));
    }
  };

  // 创建/编辑促销
  const savePromotion = async () => {
    if (!promoForm.name) return;
    const discountValue = Number(promoForm.discountValue) || 0;
    const promoData = {
      name: promoForm.name,
      type: promoForm.type,
      discount: promoForm.discountMode === '百分比折扣' ? discountValue : -discountValue,
      startDate: promoForm.validFrom || '2026-05-01',
      endDate: promoForm.validTo || '2026-08-31',
      roomTypes: promoForm.roomType === '全部房型' ? roomTypeNames : [promoForm.roomType],
      condition: promoForm.condition || '无',
      description: promoForm.condition || promoForm.name,
    };

    if (editPromoId) {
      await apiPost('/api/pricing', { action: 'editPromotion', promotionId: editPromoId, ...promoData });
      showSaveSuccess('促销已更新');
    } else {
      await apiPost('/api/pricing', { action: 'addPromotion', ...promoData, channels: ['携程', '美团'] });
      showSaveSuccess('促销已创建');
    }
    setShowModal('');
    setEditPromoId(null);
    refreshData();
  };

  // 批量调整基础房价
  const handleBatchBaseSave = async () => {
    const selectedRules = baseData.filter(b => batchBaseSelected.includes(b.id));
    if (selectedRules.length === 0) { showSaveSuccess('请至少选择一个房型'); return; }
    const adjustVal = Number(batchBaseValue);
    if (!batchBaseValue || isNaN(adjustVal)) { showSaveSuccess('请输入有效的调整幅度'); return; }

    setBatchBaseSaving(true);
    try {
      const updates = selectedRules.map(rule => {
        const applyAdjust = (originalPrice: number) => {
          switch (batchBaseMode) {
            case 'percentage_up': return Math.round(originalPrice * (1 + adjustVal / 100));
            case 'percentage_down': return Math.round(originalPrice * (1 - adjustVal / 100));
            case 'fixed_up': return originalPrice + adjustVal;
            case 'fixed_down': return originalPrice - adjustVal;
            case 'set_price': return adjustVal;
            default: return originalPrice;
          }
        };
        const upd: any = { ruleId: rule.id };
        if (batchBaseDayType === 'all' || batchBaseDayType === 'weekday') {
          upd.weekdayPrice = applyAdjust(rule.weekdayPrice);
        }
        if (batchBaseDayType === 'all' || batchBaseDayType === 'weekend') {
          upd.weekendPrice = applyAdjust(rule.weekendPrice);
        }
        // basePrice 同步更新基准价（取工作日价）
        if (batchBaseDayType === 'all') {
          upd.basePrice = applyAdjust(rule.basePrice);
        }
        // holidayPrice 按周末价比例同步
        if (batchBaseDayType === 'all') {
          upd.holidayPrice = Math.round(applyAdjust(rule.basePrice) * 1.5);
        }
        return upd;
      });

      const res = await apiPost('/api/pricing', { action: 'batchUpdateRules', updates });
      if (res.success) {
        const failed = (res.results || []).filter((r: any) => !r.success);
        if (failed.length > 0) {
          showSaveSuccess(`${updates.length - failed.length}个房型已更新，${failed.length}个失败`);
        } else {
          showSaveSuccess(`${updates.length}个房型已批量调整`);
        }
      }
      setShowModal('');
      setBatchBaseSelected([]);
      refreshData();
    } catch (e: any) {
      showSaveSuccess('批量调整失败：' + (e.message || '未知错误'));
    } finally {
      setBatchBaseSaving(false);
    }
  };

  // 批量改价确认（价格日历）
  const handleBatchPrice = async () => {
    if (!batchRange.start || !batchRange.end) { showSaveSuccess('请选择日期范围'); return; }
    if (!batchValue) { showSaveSuccess('请输入调整值'); return; }
    const adjustVal = Number(batchValue);
    if (isNaN(adjustVal)) { showSaveSuccess('请输入有效的调整值'); return; }

    // 确定目标房型ID
    const targetTypes = batchRoomType === '全部房型'
      ? baseData
      : baseData.filter(b => b.roomType === batchRoomType);
    const roomTypeIds = targetTypes.map(b => b.id.replace('rule-default-', ''));
    if (roomTypeIds.length === 0) { showSaveSuccess('未找到目标房型'); return; }

    try {
      await apiPost('/api/pricing', {
        action: 'batchPriceCalendar',
        dateFrom: batchRange.start,
        dateTo: batchRange.end,
        roomTypeIds,
        mode: batchMode,
        value: batchMode === 'percentage' ? adjustVal : adjustVal,
        dayType: batchDayType,
      });
      setShowModal('');
      showSaveSuccess(`批量改价已生效，${targetTypes.length}个房型 × ${Object.entries(batchApplyTo).filter(([, v]) => v).length}个渠道`);
      refreshData();
    } catch (e: any) {
      showSaveSuccess('批量改价失败：' + (e.message || '未知错误'));
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader title="价格管理" subtitle="智能定价，最大化收益" icon={<DollarSign className="w-5 h-5" />} />

      {/* 保存成功提示 */}
      {saveSuccess && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[60] flex items-center gap-2 bg-emerald-600 text-white px-5 py-3 rounded-xl shadow-lg shadow-emerald-500/25 text-sm font-medium animate-in fade-in slide-in-from-top-2">
          <Check className="w-4 h-4" />
          {saveSuccess}
        </div>
      )}

      {/* Summary Cards */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-50 flex items-center justify-center">
              <Zap className="w-5 h-5 text-emerald-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{baseData.length}</p>
              <p className="text-xs text-slate-500">房价格式</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-amber-50 flex items-center justify-center">
              <Gift className="w-5 h-5 text-amber-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-slate-800">{promotions.filter((p) => p.status === 'active').length}</p>
              <p className="text-xs text-slate-500">生效特价</p>
            </div>
          </div>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-blue-50 flex items-center justify-center">
              <TrendingUp className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <p className="text-2xl font-bold text-emerald-600">{summary.avgCommission}</p>
              <p className="text-xs text-slate-500">渠道均价差异</p>
            </div>
          </div>
        </div>
      </div>

      <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />

      {/* ===== 价格日历 Tab（重构版）===== */}
      {activeTab === 'calendar' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-3">
                <h3 className="text-base font-semibold text-slate-800">价格日历</h3>
                <span className="text-xs text-slate-400">点击价格可直接修改</span>
              </div>
              <div className="flex items-center gap-4">
                {/* 渠道切换 */}
                <div className="flex items-center gap-1 bg-slate-100 rounded-xl p-1">
                  {['门店价', ...CHANNEL_LIST].map((ch) => (
                    <button key={ch} onClick={() => setCalendarChannel(ch)} className={`px-3 py-1.5 text-xs font-medium rounded-lg transition-colors ${calendarChannel === ch ? 'bg-white text-emerald-600 shadow-sm' : 'text-slate-500 hover:text-slate-700'}`}>
                      {ch}
                    </button>
                  ))}
                </div>
                {/* 月份切换 */}
                <div className="flex items-center gap-2">
                  <button onClick={() => setCalendarMonth(Math.max(0, calendarMonth - 1))} className="p-2 hover:bg-slate-100 rounded-lg">
                    <ChevronLeft className="w-5 h-5 text-slate-400" />
                  </button>
                  <span className="text-sm font-medium text-slate-600 px-3">{calendarMonthLabel}</span>
                  <button onClick={() => setCalendarMonth(Math.min(1, calendarMonth + 1))} className="p-2 hover:bg-slate-100 rounded-lg">
                    <ChevronRight className="w-5 h-5 text-slate-400" />
                  </button>
                </div>
              </div>
            </div>

            {/* 月历网格 */}
            <div className="overflow-x-auto">
              <table className="w-full min-w-[900px] border-collapse">
                <thead>
                  <tr>
                    <th className="px-3 py-2 text-xs font-medium text-slate-500 text-left w-32 min-w-[128px]">房型</th>
                    {calendarSlice.slice(0, 7).map((d) => (
                      <th key={d.date} className="px-1 py-2 text-center text-xs font-medium text-slate-500 min-w-[72px]">{d.weekday}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {roomTypeNames.map((rt) => (
                    <tr key={rt}>
                      <td className="px-3 py-2 text-sm font-semibold text-slate-700 border-r border-slate-100 align-middle">
                        <div className="truncate" title={rt}>{rt}</div>
                      </td>
                      {calendarSlice.map((day) => {
                        const roomType = day.roomTypes.find((r) => r.name === rt);
                        if (!roomType) return <td key={day.date} className="px-1 py-1" />;
                        const displayPrice = calendarChannel === '门店价' ? roomType.finalPrice : roomType.channelPrices[calendarChannel] || roomType.finalPrice;
                        const isUp = displayPrice > roomType.basePrice;
                        const isDown = displayPrice < roomType.basePrice;

                        return (
                          <td key={day.date} className="px-1 py-1 text-center">
                            <button
                              onClick={() => openPriceEditor(day, rt)}
                              className={`w-full rounded-lg p-1.5 text-center transition-all hover:shadow-md hover:scale-105 ${
                                roomType.isBelowMin ? 'bg-red-50 border-2 border-red-300' :
                                day.isHoliday ? 'bg-amber-50 border border-amber-200' :
                                day.isWeekend ? 'bg-blue-50/50 border border-blue-100' :
                                'bg-slate-50/50 border border-slate-100'
                              }`}
                            >
                              <div className="text-[10px] text-slate-400">{day.date.slice(8)}</div>
                              <div className={`text-xs font-bold ${isUp ? 'text-red-600' : isDown ? 'text-emerald-600' : 'text-slate-700'}`}>
                                ¥{displayPrice}
                              </div>
                              <div className={`text-[10px] ${roomType.available <= 2 ? 'text-red-500' : roomType.available <= 5 ? 'text-amber-500' : 'text-slate-400'}`}>
                                余{roomType.available}
                              </div>
                            </button>
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          {/* 日历图例 + 批量操作 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-6">
                <span className="text-sm text-slate-500 font-medium">图例:</span>
                <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-emerald-50 border border-emerald-200" /><span className="text-xs text-slate-600">标准价</span></div>
                <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-blue-50 border border-blue-200" /><span className="text-xs text-slate-600">周末</span></div>
                <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded bg-amber-50 border border-amber-200" /><span className="text-xs text-slate-600">节假日</span></div>
                <div className="flex items-center gap-1.5"><div className="w-4 h-4 rounded border-2 border-red-300 bg-red-50" /><span className="text-xs text-slate-600">低于底价</span></div>
                <div className="flex items-center gap-1.5"><span className="text-xs text-red-600 font-medium">红色</span><span className="text-xs text-slate-600">= 涨价</span></div>
                <div className="flex items-center gap-1.5"><span className="text-xs text-emerald-600 font-medium">绿色</span><span className="text-xs text-slate-600">= 降价</span></div>
              </div>
              <div className="flex items-center gap-3">
                {canEditPricing && <button onClick={() => setShowModal('batchPrice')} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-medium rounded-xl hover:shadow-lg hover:shadow-emerald-500/25">
                  <Edit2 className="w-4 h-4" />批量改价
                </button>}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===== 基础房价 Tab ===== */}
      {activeTab === 'base' && (
        <div className="space-y-4">
          <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-2xl p-5 text-white">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-10 h-10 rounded-xl bg-white/20 flex items-center justify-center">
                <DollarSign className="w-5 h-5" />
              </div>
              <div>
                <h3 className="font-medium">基础房价说明</h3>
                <p className="text-sm text-emerald-100">基础房价是所有定价策略的根基，工作日价/周末价/节假日价将作为动态调价和渠道定价的基准</p>
              </div>
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-5">
              <h3 className="text-base font-semibold text-slate-800">房型基础定价</h3>
              {canEditPricing && <button onClick={() => { setBatchBaseSelected(baseData.map(b => b.id)); setBatchBaseMode('percentage_up'); setBatchBaseValue(''); setBatchBaseDayType('all'); setShowModal('batchBase'); }} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-medium rounded-xl hover:shadow-lg hover:shadow-emerald-500/25">
                <Edit2 className="w-4 h-4" />批量调整
              </button>}
            </div>
            <div className="overflow-hidden rounded-xl border border-slate-200">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-5 py-3 text-xs font-medium text-slate-500">房型</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">基准价</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">工作日价</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">周末价</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">节假日价</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">最低售价</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">周末溢价</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">节假日溢价</th>
                    <th className="text-center px-5 py-3 text-xs font-medium text-slate-500">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {baseData.map((bp) => {
                    const weekendPremium = Math.round((bp.weekendPrice / bp.basePrice - 1) * 100);
                    const holidayPremium = Math.round((bp.holidayPrice / bp.basePrice - 1) * 100);
                    return (
                      <tr key={bp.id} className="hover:bg-slate-50/50">
                        <td className="px-5 py-4 text-sm font-semibold text-slate-800">{bp.roomType}</td>
                        <td className="px-5 py-4 center text-sm font-bold text-slate-800">¥{bp.basePrice}</td>
                        <td className="px-5 py-4 center text-sm text-slate-600">¥{bp.weekdayPrice}</td>
                        <td className="px-5 py-4 center text-sm font-medium text-blue-600">¥{bp.weekendPrice}</td>
                        <td className="px-5 py-4 center text-sm font-medium text-amber-600">¥{bp.holidayPrice}</td>
                        <td className="px-5 py-4 center">
                          <span className="text-sm font-medium text-red-600">¥{bp.minPrice}</span>
                          <span className="text-[10px] text-slate-400 ml-1">底线</span>
                        </td>
                        <td className="px-5 py-4 center">
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-blue-50 text-blue-700">+{weekendPremium}%</span>
                        </td>
                        <td className="px-5 py-4 center">
                          <span className="text-xs font-medium px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">+{holidayPremium}%</span>
                        </td>
                        <td className="px-5 py-4 center">
                          <button
                            onClick={() => { setEditBaseId(bp.id); setEditBaseValues({ basePrice: bp.basePrice, weekdayPrice: bp.weekdayPrice, weekendPrice: bp.weekendPrice, holidayPrice: bp.holidayPrice, minPrice: bp.minPrice }); setShowModal('editBase'); }}
                            className="p-2 hover:bg-slate-100 rounded-lg"
                          >
                            <Edit2 className="w-4 h-4 text-slate-500" />
                          </button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>


        </div>
      )}

      {/* ===== 限时特价 Tab ===== */}
      {activeTab === 'promotions' && (
        <div className="space-y-4">
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <div className="flex items-center justify-between mb-4">
              <div>
                <h3 className="text-base font-semibold text-slate-800">促销策略管理</h3>
                <p className="text-sm text-slate-500 mt-0.5">灵活配置各类促销活动，提升入住率和复购率</p>
              </div>
              {canEditPricing && <button onClick={() => setShowModal('promotion')} className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white text-sm font-medium rounded-xl hover:shadow-lg hover:shadow-emerald-500/25">
                <Plus className="w-4 h-4" />创建促销
              </button>}
            </div>
            <div className="grid grid-cols-2 gap-4">
              {promotions.map((promo) => {
                const typeInfo = promoTypeLabels[promo.type] || { label: promo.type, icon: <Gift className="w-4 h-4" />, color: 'text-slate-600 bg-slate-50' };
                const usagePercent = promo.usageLimit > 0 ? Math.round((promo.usageCount / promo.usageLimit) * 100) : 0;
                return (
                  <div key={promo.id} className={`border rounded-xl p-4 transition-colors ${promo.status === 'active' ? 'border-slate-200 hover:border-emerald-300' : 'border-slate-100 bg-slate-50/50'}`}>
                    <div className="flex items-start justify-between mb-3">
                      <div className="flex items-center gap-3">
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${typeInfo.color}`}>
                          {typeInfo.icon}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <h4 className="font-semibold text-slate-800">{promo.name}</h4>
                            <StatusBadge label={promo.status === 'active' ? '生效中' : '已停用'} type={promo.status === 'active' ? 'success' : 'default'} />
                          </div>
                          <span className={`text-xs px-2 py-0.5 rounded-full ${typeInfo.color} mt-1 inline-block`}>{typeInfo.label}</span>
                        </div>
                      </div>
                      <span className="text-xs px-2 py-0.5 rounded-full bg-slate-100 text-slate-500">P{promo.priority}</span>
                    </div>
                    <p className="text-sm text-slate-600 mb-3">{promo.description}</p>
                    <div className="flex items-center gap-2 mb-3">
                      <span className="text-lg font-bold text-emerald-600">{promo.discount}</span>
                      <span className="text-xs text-slate-400">|</span>
                      <span className="text-xs text-slate-500">条件: {promo.condition}</span>
                    </div>
                    <div className="flex items-center justify-between text-xs text-slate-500">
                      <span>适用: {promo.roomTypes.join('、')}</span>
                      <span>{promo.validFrom.slice(5)} ~ {promo.validTo.slice(5)}</span>
                    </div>
                    <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                      <div className="flex items-center gap-1">
                        <Eye className="w-3.5 h-3.5 text-slate-400" />
                        <span className="text-xs text-slate-500">已使用 {promo.usageCount}{promo.usageLimit > 0 ? ` / ${promo.usageLimit}` : ''}次</span>
                      </div>
                      {promo.usageLimit > 0 && (
                        <div className="w-24 h-1.5 bg-slate-100 rounded-full overflow-hidden">
                          <div className="h-full bg-emerald-500 rounded-full" style={{ width: `${usagePercent}%` }} />
                        </div>
                      )}
                      <div className="flex gap-1">
                        <button onClick={() => {
                          setEditPromoId(promo.id);
                          setPromoForm({
                            name: promo.name,
                            type: promo.type,
                            discountMode: promo.discountUnit === 'percent' ? '百分比折扣' : '固定金额减免',
                            discountValue: String(promo.discountValue),
                            roomType: promo.roomTypes.length > 1 ? '全部房型' : promo.roomTypes[0],
                            condition: promo.condition === '无' ? '' : promo.condition,
                            validFrom: promo.validFrom,
                            validTo: promo.validTo,
                            usageLimit: String(promo.usageLimit),
                            priority: String(promo.priority),
                          });
                          setShowModal('promotion');
                        }} className="p-1.5 hover:bg-slate-100 rounded-lg"><Edit2 className="w-3.5 h-3.5 text-slate-500" /></button>
                        {promo.status === 'active' ? (
                          <ToggleRight className="w-5 h-5 text-emerald-500 cursor-pointer" onClick={() => togglePromo(promo.id)} />
                        ) : (
                          <ToggleLeft className="w-5 h-5 text-slate-300 cursor-pointer" onClick={() => togglePromo(promo.id)} />
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
            <h3 className="text-base font-semibold text-slate-800 mb-4">促销效果统计</h3>
            <div className="grid grid-cols-4 gap-4">
              {promotions.filter((p) => p.status === 'active').slice(0, 4).map((promo) => (
                <div key={promo.id} className="border border-slate-100 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <span className="text-sm font-medium text-slate-700">{promo.name}</span>
                  </div>
                  <div className="text-2xl font-bold text-slate-800">{promo.usageCount}</div>
                  <p className="text-xs text-slate-500">累计使用次数</p>
                  <div className="mt-2 flex items-center gap-1 text-xs text-emerald-600">
                    <TrendingUp className="w-3 h-3" />
                    <span>转化率 {Math.round(promo.usageCount / (promo.usageCount + 50) * 100)}%</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* ===== 多渠道快速改价弹窗（核心功能）===== */}
      {showModal === 'priceEditor' && selectedDay && selectedRoomType && (() => {
        const rt = selectedDay.roomTypes.find((r) => r.name === selectedRoomType);
        if (!rt) return null;
        const currentPrice = editPrices[selectedRoomType] ?? rt.finalPrice;
        const baseInfo = baseData.find((b) => b.roomType === selectedRoomType);
        const minPrice = baseInfo?.minPrice ?? 0;
        const isBelowMin = currentPrice < minPrice;

        return (
          <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowModal('')}>
            <div className="bg-white rounded-2xl w-[680px] h-[85vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
              {/* 头部 */}
              <div className="flex-shrink-0 border-b border-slate-100 p-5">
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-3">
                    <h3 className="text-lg font-semibold text-slate-800">快速改价</h3>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${selectedDay.isHoliday ? 'bg-amber-100 text-amber-700' : selectedDay.isWeekend ? 'bg-blue-100 text-blue-700' : 'bg-emerald-100 text-emerald-700'}`}>
                      {selectedDay.date.slice(5)} {selectedDay.isHoliday ? selectedDay.holidayName + ' ' : ''}{selectedDay.weekday}
                    </span>
                  </div>
                  <button onClick={() => setShowModal('')} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
                </div>
              </div>

              <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-5">
                {/* 房型 + 底价预警 */}
                <div className="flex items-center gap-3">
                  <span className="text-sm font-semibold text-slate-700">{selectedRoomType}</span>
                  <span className="text-xs text-slate-400">余房 {rt.available}/{rt.total}</span>
                  {isBelowMin && (
                    <span className="flex items-center gap-1 text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
                      <AlertTriangle className="w-3 h-3" />低于底价 ¥{minPrice}
                    </span>
                  )}
                </div>

                {/* 门店价编辑 */}
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">门店价（基准价）</label>
                  <div className="flex items-center gap-3">
                    <div className="relative flex-1">
                      <span className="absolute left-4 top-1/2 -translate-y-1/2 text-slate-400 text-sm">¥</span>
                      <input
                        type="number"
                        value={currentPrice}
                        onChange={(e) => handleStorePriceChange(selectedRoomType, Number(e.target.value), rt)}
                        className={`w-full pl-8 pr-4 py-3 border rounded-xl text-sm font-bold text-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${isBelowMin ? 'border-red-300 bg-red-50' : 'border-slate-200'}`}
                      />
                    </div>
                    <div className="flex items-center gap-2">
                      {[-10, -5, +5, +10].map((delta) => (
                        <button
                          key={delta}
                          onClick={() => handleStorePriceChange(selectedRoomType, currentPrice + delta, rt)}
                          className={`px-3 py-2 text-xs font-medium rounded-lg border transition-colors ${delta > 0 ? 'border-orange-200 text-orange-600 hover:bg-orange-50' : 'border-emerald-200 text-emerald-600 hover:bg-emerald-50'}`}
                        >
                          {delta > 0 ? '+' : ''}{delta}
                        </button>
                      ))}
                    </div>
                  </div>
                  {baseInfo && (
                    <div className="flex items-center gap-4 mt-2 text-xs text-slate-400">
                      <span>底价 ¥{baseInfo.minPrice}</span>
                      <span>工作日 ¥{baseInfo.weekdayPrice}</span>
                      <span>周末 ¥{baseInfo.weekendPrice}</span>
                      <span>节假日 ¥{baseInfo.holidayPrice}</span>
                    </div>
                  )}
                </div>

                {/* 渠道价格编辑 */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <label className="text-sm font-medium text-slate-700">渠道价格</label>
                    <div className="flex items-center gap-2">
                      <button
                        onClick={() => {
                          const allChecked = Object.values(syncChannels).every(Boolean);
                          const newState: Record<string, boolean> = {};
                          CHANNEL_LIST.forEach((ch) => { newState[ch] = !allChecked; });
                          setSyncChannels(newState);
                        }}
                        className="text-xs text-emerald-600 hover:text-emerald-700 font-medium"
                      >
                        {Object.values(syncChannels).every(Boolean) ? '取消全选' : '全选渠道'}
                      </button>
                    </div>
                  </div>
                  <div className="space-y-2.5">
                    {CHANNEL_LIST.map((ch) => {
                      const chPrice = editChannelPrices[ch] ?? rt.channelPrices[ch] ?? rt.finalPrice;
                      const isSelected = syncChannels[ch] ?? true;
                      const diff = chPrice - currentPrice;
                      const diffPercent = currentPrice > 0 ? Math.round((diff / currentPrice) * 100) : 0;
                      return (
                        <div key={ch} className={`flex items-center gap-3 p-3 rounded-xl border transition-all ${isSelected ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-60'}`}>
                          <button
                            onClick={() => setSyncChannels((prev) => ({ ...prev, [ch]: !isSelected }))}
                            className={`w-5 h-5 rounded-md flex items-center justify-center transition-colors ${isSelected ? 'bg-emerald-500 text-white' : 'border border-slate-300'}`}
                          >
                            {isSelected && <Check className="w-3 h-3" />}
                          </button>
                          <div className={`w-2 h-6 rounded-full ${CHANNEL_COLORS[ch] ?? 'bg-slate-400'}`} />
                          <span className="text-sm font-medium text-slate-700 w-20">{ch}</span>
                          <div className="flex-1 relative">
                            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-xs">¥</span>
                            <input
                              type="number"
                              value={chPrice}
                              onChange={(e) => setEditChannelPrices((prev) => ({ ...prev, [ch]: Number(e.target.value) }))}
                              disabled={!isSelected}
                              className="w-full pl-7 pr-3 py-2 border border-slate-200 rounded-lg text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 disabled:bg-slate-50 disabled:text-slate-400"
                            />
                          </div>
                          <span className={`text-xs font-medium w-16 text-right ${diff > 0 ? 'text-orange-600' : diff < 0 ? 'text-emerald-600' : 'text-slate-400'}`}>
                            {diff >= 0 ? '+' : ''}{diffPercent}%
                          </span>
                          <button
                            onClick={() => setEditChannelPrices((prev) => ({ ...prev, [ch]: currentPrice }))}
                            className="p-1 hover:bg-slate-100 rounded text-slate-400 hover:text-slate-600"
                            title="同步门店价"
                          >
                            <Copy className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* 竞品参考 */}
                {rt.competitorAvg > 0 && (
                  <div className="bg-slate-50 rounded-xl p-3 flex items-center gap-3">
                    <Info className="w-4 h-4 text-slate-400 flex-shrink-0" />
                    <div className="text-xs text-slate-500">
                      <span className="font-medium text-slate-600">竞品参考</span> 同区域同类型酒店均价 <span className="font-bold text-slate-700">¥{rt.competitorAvg}</span>
                      {rt.competitorAvg > currentPrice && <span className="text-orange-600 ml-1">（你的价格偏低 {Math.round((rt.competitorAvg - currentPrice) / rt.competitorAvg * 100)}%）</span>}
                      {rt.competitorAvg < currentPrice && <span className="text-emerald-600 ml-1">（你的价格偏高 {Math.round((currentPrice - rt.competitorAvg) / rt.competitorAvg * 100)}%）</span>}
                    </div>
                  </div>
                )}
              </div>

              {/* 底部操作 */}
              <div className="flex-shrink-0 border-t border-slate-100 p-5 flex items-center justify-between">
                <div className="text-xs text-slate-400">
                  已选 {Object.values(syncChannels).filter(Boolean).length} 个渠道同步更新
                </div>
                <div className="flex gap-3">
                  <button onClick={() => setShowModal('')} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
                  <button
                    onClick={() => setShowModal('')}
                    className={`px-5 py-2.5 text-white rounded-xl text-sm font-medium ${isBelowMin ? 'bg-red-500 hover:bg-red-600' : 'bg-gradient-to-r from-emerald-500 to-emerald-600 hover:shadow-lg hover:shadow-emerald-500/25'}`}
                  >
                    {isBelowMin ? '确认改价（低于底价）' : '确认改价'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        );
      })()}

      {/* ===== 批量调整基础房价弹窗 ===== */}
      {showModal === 'batchBase' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowModal('')}>
          <div className="bg-white rounded-2xl w-[560px] h-[80vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-slate-100">
              <div><h3 className="text-lg font-semibold text-slate-800">批量调整基础房价</h3><span className="text-xs text-slate-400">同时修改多个房型的基础定价</span></div>
              <button onClick={() => setShowModal('')} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-5">
              <div><label className="block text-sm font-medium text-slate-700 mb-2">选择房型</label>
                <div className="space-y-2">{baseData.map((b) => {
                  const isChecked = batchBaseSelected.includes(b.id);
                  return (
                    <label key={b.id} className={`flex items-center gap-3 p-3 border rounded-xl cursor-pointer transition-colors ${isChecked ? 'border-emerald-300 bg-emerald-50/30' : 'border-slate-200 hover:border-emerald-300 hover:bg-emerald-50/30'}`}>
                      <input type="checkbox" checked={isChecked} onChange={() => setBatchBaseSelected(prev => prev.includes(b.id) ? prev.filter(id => id !== b.id) : [...prev, b.id])} className="rounded border-slate-300 text-emerald-600 focus:ring-emerald-500" />
                      <div className="flex-1"><span className="text-sm font-medium text-slate-700">{b.roomType}</span><span className="text-xs text-slate-400 ml-2">当前 ¥{b.weekdayPrice}(工作日) / ¥{b.weekendPrice}(周末)</span></div>
                    </label>
                  );
                })}</div>
              </div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">调整方式</label>
                <select value={batchBaseMode} onChange={(e) => setBatchBaseMode(e.target.value)} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                  <option value="percentage_up">统一涨价百分比</option>
                  <option value="percentage_down">统一降价百分比</option>
                  <option value="fixed_up">统一加固定金额</option>
                  <option value="fixed_down">统一减固定金额</option>
                  <option value="set_price">设置统一价格</option>
                </select>
              </div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">调整幅度</label>
                <input value={batchBaseValue} onChange={(e) => setBatchBaseValue(e.target.value)} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder={batchBaseMode === 'set_price' ? '例如：328' : '例如：10 表示 10%'} />
              </div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">适用日期类型</label>
                <div className="flex gap-2">
                  {[
                    { key: 'all', label: '工作日+周末' },
                    { key: 'weekday', label: '仅工作日' },
                    { key: 'weekend', label: '仅周末' },
                  ].map(opt => (
                    <button key={opt.key} onClick={() => setBatchBaseDayType(opt.key)}
                      className={`flex-1 py-2 rounded-xl text-sm font-medium border-2 transition-colors ${batchBaseDayType === opt.key ? 'bg-emerald-50 text-emerald-700 border-emerald-500' : 'bg-slate-50 text-slate-600 border-transparent hover:border-slate-300'}`}>
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>
              {batchBaseValue && batchBaseSelected.length > 0 && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-700">
                  <p className="font-medium mb-1">调整预览：</p>
                  {baseData.filter(b => batchBaseSelected.includes(b.id)).map(b => {
                    const adjustVal = Number(batchBaseValue) || 0;
                    const calc = (p: number) => batchBaseMode === 'percentage_up' ? Math.round(p * (1 + adjustVal / 100)) : batchBaseMode === 'percentage_down' ? Math.round(p * (1 - adjustVal / 100)) : batchBaseMode === 'set_price' ? adjustVal : batchBaseMode === 'fixed_up' ? p + adjustVal : p - adjustVal;
                    return <p key={b.id} className="text-xs">{b.roomType}：¥{b.weekdayPrice}→¥{calc(b.weekdayPrice)}(工作日) / ¥{b.weekendPrice}→¥{calc(b.weekendPrice)}(周末)</p>;
                  })}
                </div>
              )}
              <div className="bg-amber-50 rounded-xl p-4"><div className="flex items-start gap-2"><AlertCircle className="w-4 h-4 text-amber-500 flex-shrink-0 mt-0.5" /><div className="text-sm text-amber-700"><span className="font-medium">注意：</span>批量调整将覆盖已设置的基础房价，渠道定价不受影响。</div></div></div>
            </div>
            <div className="flex-shrink-0 flex justify-end gap-3 p-5 border-t border-slate-100">
              <button onClick={() => setShowModal('')} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleBatchBaseSave} disabled={batchBaseSaving || batchBaseSelected.length === 0} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed">{batchBaseSaving ? '保存中...' : `确认调整 (${batchBaseSelected.length}个房型)`}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 编辑基础房价弹窗 ===== */}
      {showModal === 'editBase' && editBaseId && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowModal('')}>
          <div className="bg-white rounded-2xl w-[480px] h-[70vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-800">编辑基础房价 - {baseData.find((b) => b.id === editBaseId)?.roomType}</h3>
              <button onClick={() => setShowModal('')} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">基准价</label><input type="number" value={editBaseValues.basePrice || 0} onChange={(e) => setEditBaseValues((v) => ({ ...v, basePrice: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-sm font-medium text-slate-700 mb-1.5">工作日价</label><input type="number" value={editBaseValues.weekdayPrice || 0} onChange={(e) => setEditBaseValues((v) => ({ ...v, weekdayPrice: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                  <div><label className="block text-sm font-medium text-slate-700 mb-1.5">周末价</label><input type="number" value={editBaseValues.weekendPrice || 0} onChange={(e) => setEditBaseValues((v) => ({ ...v, weekendPrice: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div><label className="block text-sm font-medium text-slate-700 mb-1.5">节假日价</label><input type="number" value={editBaseValues.holidayPrice || 0} onChange={(e) => setEditBaseValues((v) => ({ ...v, holidayPrice: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">最低售价（保护价）</label>
                    <input type="number" value={editBaseValues.minPrice || 0} onChange={(e) => setEditBaseValues((v) => ({ ...v, minPrice: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                    <p className="text-xs text-red-500 mt-1">所有促销和动态调价均不可低于此价格</p>
                  </div>
                </div>
            </div>
            <div className="flex-shrink-0 flex justify-end gap-3 p-5 border-t border-slate-100">
              <button onClick={() => setShowModal('')} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={saveBasePrice} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25">保存修改</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 创建/编辑促销弹窗 ===== */}
      {showModal === 'promotion' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowModal('')}>
          <div className="bg-white rounded-2xl w-[560px] h-[85vh] shadow-xl flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-slate-100">
              <h3 className="text-lg font-semibold text-slate-800">{editPromoId ? '编辑促销策略' : '创建促销策略'}</h3>
              <button onClick={() => setShowModal('')} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-5 space-y-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">促销名称</label><input value={promoForm.name} onChange={(e) => setPromoForm((v) => ({ ...v, name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="例如：暑期早鸟优惠" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">促销类型</label><select value={promoForm.type} onChange={(e) => setPromoForm((v) => ({ ...v, type: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"><option value="early_bird">早鸟优惠</option><option value="long_stay">连住优惠</option><option value="last_minute">尾房甩卖</option><option value="flash_sale">限时特惠</option><option value="member_only">会员专享</option><option value="new_customer">新客优惠</option><option value="package">套餐</option></select></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">优惠方式</label><select value={promoForm.discountMode} onChange={(e) => setPromoForm((v) => ({ ...v, discountMode: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"><option>百分比折扣</option><option>固定金额减免</option><option>固定价格</option></select></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">优惠力度</label><input value={promoForm.discountValue} onChange={(e) => setPromoForm((v) => ({ ...v, discountValue: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder={promoForm.discountMode === '百分比折扣' ? '例如：85 表示85折' : '例如：30 表示减30元'} /></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">适用房型</label><select value={promoForm.roomType} onChange={(e) => setPromoForm((v) => ({ ...v, roomType: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"><option>全部房型</option>{roomTypeNames.map(rt => <option key={rt}>{rt}</option>)}</select></div>
              </div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">触发条件</label><input value={promoForm.condition} onChange={(e) => setPromoForm((v) => ({ ...v, condition: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="例如：提前7天预订、连续入住3晚、当日18:00后" /></div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">生效日期</label><input type="date" value={promoForm.validFrom} onChange={(e) => setPromoForm((v) => ({ ...v, validFrom: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">结束日期</label><input type="date" value={promoForm.validTo} onChange={(e) => setPromoForm((v) => ({ ...v, validTo: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">使用次数限制</label><input type="number" value={promoForm.usageLimit} onChange={(e) => setPromoForm((v) => ({ ...v, usageLimit: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="0=不限" /></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">优先级</label><select value={promoForm.priority} onChange={(e) => setPromoForm((v) => ({ ...v, priority: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"><option value="1">1（最高）</option><option value="2">2</option><option value="3">3</option><option value="4">4</option><option value="5">5</option><option value="6">6</option><option value="7">7（最低）</option></select></div>
              </div>
            </div>
            <div className="flex-shrink-0 flex justify-end gap-3 p-5 border-t border-slate-100">
              <button onClick={() => setShowModal('')} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={savePromotion} disabled={!promoForm.name} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed">{editPromoId ? '保存修改' : '创建促销'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 增强版批量改价弹窗 ===== */}
      {showModal === 'batchPrice' && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowModal('')}>
          <div className="bg-white rounded-2xl w-[640px] shadow-xl max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
            <div className="sticky top-0 bg-white rounded-t-2xl border-b border-slate-100 p-5 z-10">
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <h3 className="text-lg font-semibold text-slate-800">批量改价</h3>
                  <span className="text-xs text-slate-400">同时修改多个渠道</span>
                </div>
                <button onClick={() => setShowModal('')} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
              </div>
            </div>
            <div className="p-5 space-y-5">
              {/* 日期范围 + 房型 */}
              <div className="grid grid-cols-3 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">开始日期</label><input type="date" value={batchRange.start} onChange={(e) => setBatchRange((v) => ({ ...v, start: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">结束日期</label><input type="date" value={batchRange.end} onChange={(e) => setBatchRange((v) => ({ ...v, end: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">适用房型</label><select value={batchRoomType} onChange={(e) => setBatchRoomType(e.target.value)} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"><option>全部房型</option>{roomTypeNames.map(rt => <option key={rt}>{rt}</option>)}</select></div>
              </div>

              {/* 适用日期类型 */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">适用日期</label>
                <div className="flex gap-2">
                  {[
                    { key: 'all' as const, label: '全部日期' },
                    { key: 'weekday' as const, label: '仅工作日' },
                    { key: 'weekend' as const, label: '仅周末' },
                  ].map((opt) => (
                    <button
                      key={opt.key}
                      onClick={() => setBatchDayType(opt.key)}
                      className={`px-4 py-2 text-xs font-medium rounded-lg border transition-colors ${batchDayType === opt.key ? 'bg-emerald-50 text-emerald-600 border-emerald-200' : 'bg-white text-slate-500 border-slate-200 hover:bg-slate-50'}`}
                    >
                      {opt.label}
                    </button>
                  ))}
                </div>
              </div>

              {/* 调整方式 */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">调整方式</label>
                  <select value={batchMode} onChange={(e) => setBatchMode(e.target.value as 'percentage' | 'fixed')} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                    <option value="percentage">百分比调整</option>
                    <option value="fixed">固定价格</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">调整值</label>
                  <input value={batchValue} onChange={(e) => setBatchValue(e.target.value)} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder={batchMode === 'percentage' ? '+10 或 -15' : '¥328'} />
                </div>
              </div>

              {/* 渠道选择（核心增强）*/}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">同步渠道</label>
                <div className="grid grid-cols-3 gap-2">
                  {['门店价', ...CHANNEL_LIST].map((ch) => {
                    const checked = batchApplyTo[ch] ?? true;
                    return (
                      <button
                        key={ch}
                        onClick={() => setBatchApplyTo((prev) => ({ ...prev, [ch]: !checked }))}
                        className={`flex items-center gap-2 px-3 py-2.5 rounded-xl border text-sm font-medium transition-colors ${checked ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-slate-50 text-slate-400 border-slate-200'}`}
                      >
                        <div className={`w-4 h-4 rounded flex items-center justify-center ${checked ? 'bg-emerald-500 text-white' : 'border border-slate-300'}`}>
                          {checked && <Check className="w-3 h-3" />}
                        </div>
                        {ch}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* 预览影响 */}
              {batchValue && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <RefreshCw className="w-4 h-4 text-emerald-600" />
                    <span className="text-sm font-semibold text-emerald-800">改价预览</span>
                  </div>
                  <div className="text-sm text-emerald-700">
                    {batchRoomType === '全部房型' ? '全部房型' : batchRoomType} · {batchDayType === 'all' ? '全部日期' : batchDayType === 'weekday' ? '仅工作日' : '仅周末'}
                    {batchMode === 'percentage' ? ` · ${batchValue}%` : ` · 固定¥${batchValue}`}
                    {' · '}{Object.entries(batchApplyTo).filter(([, v]) => v).map(([k]) => k).join('/')}
                  </div>
                  <div className="mt-2 text-xs text-emerald-600">
                    预计影响：{Object.entries(batchApplyTo).filter(([, v]) => v).length}个渠道 · 大床房 ¥298→{batchMode === 'percentage' ? `¥${Math.round(298 * (1 + Number(batchValue) / 100))}` : `¥${batchValue}`}
                  </div>
                </div>
              )}

              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-amber-700">批量改价将覆盖所选日期范围内的现有价格，改价不会低于房型最低售价保护。</p>
              </div>
            </div>
            <div className="flex-shrink-0 flex justify-end gap-3 p-5 border-t border-slate-100">
              <button onClick={() => setShowModal('')} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleBatchPrice} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25">确认批量改价</button>
            </div>
          </div>
        </div>
      )}
      <PricingSuggestions suggestions={[]} />
    </div>
  );
}
