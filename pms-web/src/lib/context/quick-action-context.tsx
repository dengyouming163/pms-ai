'use client';

import React, { createContext, useContext, useState, useCallback, useMemo } from 'react';
import {
  LogIn, LogOut, SprayCan, X, ArrowRight, Plus, Minus, BedDouble,
  User, Calendar, Clock, AlertCircle, CheckCircle2, Globe, Wrench, Sparkles
} from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api-client';
import { useStore } from '@/lib/context/store-context';

// ========== Types ==========
interface DailyRoom {
  id: string; roomNumber: string; roomTypeName: string; floor: number;
  price: number; status: string; guest?: string; guestPhone?: string;
  checkIn?: string; checkOut?: string; source?: string; deposit?: number; orderNo?: string;
}

interface Booking {
  id: string; guestName: string; guestPhone: string; guestIdCard?: string;
  roomTypeName: string; roomId?: string; roomNumber?: string;
  checkIn: string; checkOut: string; nights: number;
  totalPrice: number; deposit: number; source: string; sourceIcon: string;
  status: 'pending' | 'confirmed'; remark?: string; channelColor: string;
}

interface QuickActionContextType {
  openCheckin: () => void;
  openCheckout: () => void;
  openHousekeeping: () => void;
}

const QuickActionContext = createContext<QuickActionContextType>({
  openCheckin: () => {}, openCheckout: () => {}, openHousekeeping: () => {},
});

export const useQuickAction = () => useContext(QuickActionContext);

export function QuickActionProvider({ children }: { children: React.ReactNode }) {
  // Dialog states
  const [checkinOpen, setCheckinOpen] = useState(false);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [housekeepingOpen, setHousekeepingOpen] = useState(false);

  // Checkin states
  const [checkinStep, setCheckinStep] = useState(1);
  const [checkinSource, setCheckinSource] = useState<'reservation' | 'channel' | 'walk-in'>('reservation');
  const [availableRooms, setAvailableRooms] = useState<DailyRoom[]>([]);
  const [bookings, setBookings] = useState<Booking[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<DailyRoom | null>(null);
  const [selectedBooking, setSelectedBooking] = useState<Booking | null>(null);
  const [guests, setGuests] = useState([{ name: '', phone: '', idCard: '' }]);
  const [checkInDate, setCheckInDate] = useState('');
  const [checkOutDate, setCheckOutDate] = useState('');
  const [deposit, setDeposit] = useState('');
  const [payMethod, setPayMethod] = useState('cash');
  const [guestCount, setGuestCount] = useState(1);
  const [remark, setRemark] = useState('');
  const [checkinSuccess, setCheckinSuccess] = useState(false);

  // Checkout states
  const [checkoutStep, setCheckoutStep] = useState(1);
  const [occupiedRooms, setOccupiedRooms] = useState<DailyRoom[]>([]);
  const [checkoutRoom, setCheckoutRoom] = useState<DailyRoom | null>(null);
  const [checkoutMode, setCheckoutMode] = useState<'normal' | 'late' | 'early'>('normal');
  const [extraCharges, setExtraCharges] = useState([{ name: '', amount: 0 }]);
  const [refundMethod, setRefundMethod] = useState('original');
  const [checkoutRemark, setCheckoutRemark] = useState('');
  const [checkoutSuccess, setCheckoutSuccess] = useState(false);
  const [depositAmount] = useState(500);
  const [checkoutItems, setCheckoutItems] = useState({ keyReturned: false, roomChecked: false, minibarChecked: false });
  const [invoiceNeeded, setInvoiceNeeded] = useState(false);
  const [invoiceType, setInvoiceType] = useState('company');
  const [invoiceTitle, setInvoiceTitle] = useState('');
  const [invoiceTaxId, setInvoiceTaxId] = useState('');

  // Housekeeping states
  interface HkTask {
    id: string; roomNumber: string; roomTypeName: string; floor: number;
    status: 'pending' | 'in_progress' | 'completed' | 'inspected';
    assignee: string; type: string; priority: 'urgent' | 'high' | 'normal' | 'low';
    remark: string; createdAt: string; startedAt?: string; completedAt?: string;
    inspectedAt?: string; inspector?: string; duration?: string;
  }
  const [hkTasks, setHkTasks] = useState<HkTask[]>([]);
  const [hkLoading, setHkLoading] = useState(false);
  const [hkTab, setHkTab] = useState<'pending' | 'in_progress' | 'completed'>('pending');
  const [hkAssignee, setHkAssignee] = useState('');
  const [hkAssignRoom, setHkAssignRoom] = useState<HkTask | null>(null);
  const [hkAssignPriority, setHkAssignPriority] = useState<'urgent' | 'high' | 'normal' | 'low'>('normal');
  const [hkAssignDuration, setHkAssignDuration] = useState('30');
  const [hkAssignRemark, setHkAssignRemark] = useState('');
  const [hkNewType, setHkNewType] = useState<'退房清洁' | '日常保洁' | '报修'>('退房清洁');
  const [hkNewPriority, setHkNewPriority] = useState<'urgent' | 'normal' | 'low'>('normal');
  const [hkNewRemark, setHkNewRemark] = useState('');
  const [hkNewRoom, setHkNewRoom] = useState('');
  const [showHkAdd, setShowHkAdd] = useState(false);
  const [showAddTask, setShowAddTask] = useState(false);
  const [addTaskRoom, setAddTaskRoom] = useState('');
  const [addTaskType, setAddTaskType] = useState('日常清洁');
  const [addTaskPriority, setAddTaskPriority] = useState<'urgent' | 'high' | 'normal' | 'low'>('normal');
  const [addTaskRemark, setAddTaskRemark] = useState('');
  const [hkCleaners, setHkCleaners] = useState<Array<{ id: string; name: string; phone: string }>>([]);

  // Customer matching for check-in
  const [customerMatches, setCustomerMatches] = useState<Array<{id: string; name: string; phone: string; preferences?: string; stayCount?: number; tags?: string[]; memberLevel?: {key: string; name: string; icon: string}}>>([]);
  const [matchedCustomer, setMatchedCustomer] = useState<{id: string; name: string; phone: string; preferences?: string; stayCount?: number; tags?: string[]; memberLevel?: {key: string; name: string; icon: string}} | null>(null);
  const [showCustomerMatch, setShowCustomerMatch] = useState(false);
  const customerSearchTimeout = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const searchCustomer = useCallback((keyword: string) => {
    if (keyword.length < 2) { setCustomerMatches([]); setShowCustomerMatch(false); return; }
    apiGet(`/api/customers?type=search&keyword=${encodeURIComponent(keyword)}`)
      .then((d: any) => { setCustomerMatches(d.results || []); setShowCustomerMatch((d.results || []).length > 0); })
      .catch(() => { setCustomerMatches([]); setShowCustomerMatch(false); });
  }, []);

  const handlePhoneInput = useCallback((value: string, idx: number) => {
    const n = [...guests]; n[idx] = { ...n[idx], phone: value }; setGuests(n);
    setMatchedCustomer(null);
    if (customerSearchTimeout.current) clearTimeout(customerSearchTimeout.current);
    customerSearchTimeout.current = setTimeout(() => searchCustomer(value), 300);
  }, [guests, searchCustomer]);

  const selectMatchedCustomer = useCallback((customer: {id: string; name: string; phone: string; preferences?: string; stayCount?: number; tags?: string[]; memberLevel?: {key: string; name: string; icon: string}}) => {
    setMatchedCustomer(customer);
    setGuests(prev => [{ ...prev[0], name: customer.name, phone: customer.phone }]);
    setShowCustomerMatch(false);
    setCustomerMatches([]);
  }, []);

  // Date helpers
  const today = useMemo(() => new Date().toISOString().split('T')[0], []);
  const tomorrow = useMemo(() => {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    return d.toISOString().split('T')[0];
  }, []);

  // 从 API 加载客房任务
  const fetchHkTasks = useCallback(async () => {
    setHkLoading(true);
    try {
      const res = await apiGet<{ success: boolean; data: { tasks: HkTask[]; cleaners: Array<{ id: string; name: string; phone: string }> } }>('/api/housekeeping');
      if (res.success && res.data) {
        setHkTasks(res.data.tasks || []);
        setHkCleaners(res.data.cleaners || []);
      }
    } catch (err) {
      console.error('加载客房任务失败:', err);
    } finally {
      setHkLoading(false);
    }
  }, []);

  // 刷新任务列表（静默，不显示loading）
  const refreshHkTasks = useCallback(async () => {
    try {
      const res = await apiGet<{ success: boolean; data: { tasks: HkTask[]; cleaners: Array<{ id: string; name: string; phone: string }> } }>('/api/housekeeping');
      if (res.success && res.data) {
        setHkTasks(res.data.tasks || []);
      }
    } catch { /* silently fail */ }
  }, []);

  // Fetch rooms + bookings when dialog opens
  const fetchRoomsData = useCallback(async () => {
    try {
      const res = await apiGet<{ rooms?: DailyRoom[] }>(`/api/rooms?type=daily&date=${today}`);
      const rooms: DailyRoom[] = res.rooms || [];
      setAvailableRooms(rooms.filter((r: DailyRoom) => r.status === 'available'));
      setOccupiedRooms(rooms.filter((r: DailyRoom) => r.status === 'occupied'));

      const bData = await apiGet<{ bookings?: Booking[] }>('/api/rooms?type=bookings');
      setBookings(bData.bookings || []);
    } catch { /* ignore */ }
  }, [today]);

  const openCheckin = useCallback(() => {
    setCheckinOpen(true); setCheckinStep(1);
    setSelectedRoom(null); setSelectedBooking(null);
    setGuests([{ name: '', phone: '', idCard: '' }]);
    setCheckInDate(today); setCheckOutDate(tomorrow);
    setDeposit(''); setPayMethod('cash'); setGuestCount(1); setRemark('');
    setCheckinSource('reservation');
    setMatchedCustomer(null); setCustomerMatches([]); setShowCustomerMatch(false);
    fetchRoomsData();
  }, [today, tomorrow, fetchRoomsData]);

  const openCheckout = useCallback(() => {
    setCheckoutOpen(true); setCheckoutStep(1);
    setCheckoutRoom(null); setCheckoutMode('normal');
    setExtraCharges([{ name: '', amount: 0 }]); setRefundMethod('original');
    setCheckoutRemark('');
    fetchRoomsData();
  }, [fetchRoomsData]);

  const openHousekeeping = useCallback(() => { setHousekeepingOpen(true); fetchHkTasks(); }, []);

  // Computed values
  const nights = checkInDate && checkOutDate ? Math.max(1, Math.round((new Date(checkOutDate).getTime() - new Date(checkInDate).getTime()) / 86400000)) : 1;
  const totalRoomCharge = selectedRoom ? selectedRoom.price * nights : 0;
  const checkoutNights = checkoutRoom ? Math.max(1, Math.round((new Date(today).getTime() - new Date(checkoutRoom.checkIn || today).getTime()) / 86400000)) : 1;
  const checkoutRoomCharge = checkoutRoom ? checkoutRoom.price * checkoutNights : 0;
  const checkoutTotalExtra = extraCharges.reduce((s, c) => s + c.amount, 0);
  const lateCheckoutFee = checkoutMode === 'late' ? Math.round((checkoutRoom?.price ?? 0) * 0.5) : 0;
  const earlyCheckoutRefund = checkoutMode === 'early' ? Math.round((checkoutRoom?.price ?? 0) * 0.5) : 0;
  const checkoutRefund = Math.max(0, depositAmount + earlyCheckoutRefund - checkoutTotalExtra - lateCheckoutFee);

  const handleConfirmCheckin = async () => {
    if (!selectedRoom) return;
    try {
      const payload: any = {
        action: "checkIn", roomId: selectedRoom.id,
        guestName: guests[0].name, guestPhone: guests[0].phone,
        checkInDate, checkOutDate, deposit: Number(deposit) || 0,
        paymentMethod: payMethod, guestCount,
        source: selectedBooking?.source || checkinSource,
        guestIdCard: guests[0].idCard || undefined,
        multiGuests: guests, remark: remark || undefined,
        createOrder: true,
      };
      await apiPost("/api/rooms", payload);
      setCheckinOpen(false); setCheckinSuccess(true);
      setTimeout(() => setCheckinSuccess(false), 2500);
    } catch (err: any) {
      console.error("入住失败:", err);
    }
  };

  const handleConfirmCheckout = async () => {
    if (!checkoutRoom) return;
    try {
      await apiPost('/api/rooms', {
        action: 'checkOut',
        roomId: checkoutRoom.id,
        extraCharges: extraCharges.filter(c => c.name && c.amount > 0),
        refundMethod,
        checkoutMode,
        invoiceNeeded: invoiceNeeded || undefined,
        invoiceType: invoiceNeeded ? invoiceType : undefined,
        invoiceTitle: invoiceNeeded ? invoiceTitle : undefined,
        invoiceTaxId: invoiceNeeded ? invoiceTaxId : undefined,
        checkoutItems,
        remark: checkoutRemark || undefined,
      });
      setCheckoutOpen(false); setCheckoutSuccess(true);
      setTimeout(() => setCheckoutSuccess(false), 2500);
    } catch (err) {
      console.error('退房失败:', err);
    }
  };

  const handleAssignTask = async () => {
    if (!hkAssignRoom || !hkAssignee) return;
    const assignee = hkCleaners.find(c => c.name === hkAssignee || c.id === hkAssignee);
    try {
      await apiPost('/api/housekeeping', {
        action: 'assign',
        taskId: hkAssignRoom.id,
        assigneeId: assignee?.id || hkAssignee,
        assigneeName: hkAssignee,
        priority: hkAssignPriority,
        estimatedDuration: Number(hkAssignDuration) || undefined,
        remark: hkAssignRemark || undefined,
      });
      setHkAssignRoom(null);
      setHkAssignee('');
      setHkAssignPriority('normal');
      setHkAssignDuration('30');
      setHkAssignRemark('');
      refreshHkTasks();
    } catch (err) {
      console.error('派单失败:', err);
    }
  };

  const handleCompleteTask = async (taskId: string) => {
    try {
      await apiPost('/api/housekeeping', { action: 'complete', taskId });
      refreshHkTasks();
    } catch (err) {
      console.error('完成任务失败:', err);
    }
  };

  const handleInspectTask = async (taskId: string) => {
    try {
      await apiPost('/api/housekeeping', { action: 'inspect', taskId, inspectorId: 'current', inspectorName: '管理员' });
      refreshHkTasks();
    } catch (err) {
      console.error('检查验收失败:', err);
    }
  };

  // handleAddHkTask 已废弃，功能已合并至 handleAddTask

  const handleAddTask = async () => {
    if (!addTaskRoom) return;
    const room = availableRooms.find(r => r.id === addTaskRoom) || occupiedRooms.find(r => r.id === addTaskRoom);
    try {
      await apiPost('/api/housekeeping', {
        action: 'create',
        storeId: '',
        roomId: addTaskRoom,
        roomNumber: room?.roomNumber || addTaskRoom,
        roomTypeName: room?.roomTypeName || '',
        floor: room?.floor || 1,
        taskType: addTaskType,
        priority: addTaskPriority,
        remark: addTaskRemark || undefined,
      });
      setAddTaskRoom(''); setAddTaskType('日常清洁'); setAddTaskPriority('normal'); setAddTaskRemark(''); setShowAddTask(false);
      refreshHkTasks();
    } catch (err) {
      console.error('创建任务失败:', err);
    }
  };

  // Select a booking and prefill data
  const handleSelectBooking = (booking: Booking) => {
    setSelectedBooking(booking);
    setGuests([{ name: booking.guestName, phone: booking.guestPhone, idCard: booking.guestIdCard || '' }]);
    setCheckInDate(booking.checkIn); setCheckOutDate(booking.checkOut);
    setDeposit(String(booking.deposit)); setGuestCount(1); setRemark(booking.remark || '');

    // If booking has a specific room, select it
    if (booking.roomId) {
      const room = availableRooms.find(r => r.id === booking.roomId);
      if (room) { setSelectedRoom(room); setCheckinStep(2); return; }
    }
    // Otherwise need to pick a room
    setSelectedRoom(null);
    setCheckinStep(2);
  };

  const statusLabel: Record<string, string> = { pending: '待派单', in_progress: '清洁中', completed: '待检查', inspected: '已通过' };
  const statusColor: Record<string, string> = { pending: 'bg-amber-100 text-amber-700', in_progress: 'bg-blue-100 text-blue-700', completed: 'bg-purple-100 text-purple-700', inspected: 'bg-emerald-100 text-emerald-700' };
  const inputCls = "w-full px-3 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500";

  const groupByType = (rooms: DailyRoom[]) => {
    const map = new Map<string, DailyRoom[]>();
    rooms.forEach(r => { const list = map.get(r.roomTypeName) || []; list.push(r); map.set(r.roomTypeName, list); });
    return map;
  };

  // Channel bookings & reservation bookings
  const channelBookings = bookings.filter(b => b.source !== '门店预订' && b.source !== '前台');
  const reservationBookings = bookings.filter(b => b.source === '门店预订' || b.source === '前台');

  // Channel color mapping
  const channelColors: Record<string, string> = {
    '携程': 'bg-blue-50 border-blue-200 text-blue-700',
    '美团': 'bg-yellow-50 border-yellow-200 text-yellow-700',
    '飞猪': 'bg-orange-50 border-orange-200 text-orange-700',
    'Booking': 'bg-indigo-50 border-indigo-200 text-indigo-700',
    '爱彼迎': 'bg-pink-50 border-pink-200 text-pink-700',
    '途家': 'bg-teal-50 border-teal-200 text-teal-700',
    '木鸟': 'bg-green-50 border-green-200 text-green-700',
    '小猪': 'bg-rose-50 border-rose-200 text-rose-700',
    '同程': 'bg-cyan-50 border-cyan-200 text-cyan-700',
  };
  const getChannelColor = (source: string) => channelColors[source] || 'bg-slate-50 border-slate-200 text-slate-700';

  return (
    <QuickActionContext.Provider value={{ openCheckin, openCheckout, openHousekeeping }}>
      {children}

      {/* ========== CHECK-IN DIALOG ========== */}
      {checkinOpen && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center" onClick={() => setCheckinOpen(false)}>
          <div className="bg-white rounded-2xl w-[860px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-slate-100 bg-gradient-to-r from-emerald-500 to-emerald-600 rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><LogIn className="w-5 h-5 text-white" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-white">快速入住</h3>
                  <p className="text-xs text-emerald-100">选择来源 → 选择房间 → 填写信息 → 确认入住</p>
                </div>
              </div>
              <button onClick={() => setCheckinOpen(false)} className="p-1 hover:bg-white/20 rounded-lg transition-colors"><X className="w-5 h-5 text-white" /></button>
            </div>

            {/* Steps */}
            <div className="flex-shrink-0 flex items-center gap-2 px-6 pt-4 pb-2">
              {[{ step: 1, label: '选择来源' }, { step: 2, label: '选择房间' }, { step: 3, label: '填写信息' }].map((s, i) => (
                <React.Fragment key={s.step}>
                  <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${checkinStep >= s.step ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-50 text-slate-400'}`}>
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${checkinStep >= s.step ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{s.step}</span>
                    {s.label}
                  </div>
                  {i < 2 && <ArrowRight className="w-4 h-4 text-slate-300" />}
                </React.Fragment>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-3 min-h-0">
              {/* Step 1: Select Source */}
              {checkinStep === 1 && (
                <div className="space-y-4">
                  {/* Source type tabs */}
                  <div className="grid grid-cols-3 gap-3">
                    {([
                      { key: 'reservation' as const, label: '预订入住', desc: `${reservationBookings.length}条待入住`, icon: Calendar, color: 'emerald' },
                      { key: 'channel' as const, label: '渠道订单', desc: `${channelBookings.length}条待处理`, icon: Globe, color: 'blue' },
                      { key: 'walk-in' as const, label: '散客入住', desc: `${availableRooms.length}间可售`, icon: User, color: 'amber' },
                    ]).map(s => (
                      <button key={s.key} onClick={() => setCheckinSource(s.key)}
                        className={`p-4 rounded-xl border-2 text-left transition-all ${
                          checkinSource === s.key
                            ? s.color === 'emerald' ? 'border-emerald-500 bg-emerald-50' : s.color === 'blue' ? 'border-blue-500 bg-blue-50' : 'border-amber-500 bg-amber-50'
                            : 'border-slate-100 bg-white hover:border-slate-200'
                        }`}>
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center mb-2 ${
                          s.color === 'emerald' ? 'bg-emerald-100' : s.color === 'blue' ? 'bg-blue-100' : 'bg-amber-100'
                        }`}>
                          <s.icon className={`w-5 h-5 ${s.color === 'emerald' ? 'text-emerald-600' : s.color === 'blue' ? 'text-blue-600' : 'text-amber-600'}`} />
                        </div>
                        <div className={`text-sm font-semibold ${checkinSource === s.key ? 'text-slate-800' : 'text-slate-600'}`}>{s.label}</div>
                        <div className="text-xs text-slate-400 mt-0.5">{s.desc}</div>
                      </button>
                    ))}
                  </div>

                  {/* Reservation bookings list */}
                  {checkinSource === 'reservation' && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-semibold text-slate-700">待入住预订</h4>
                        <span className="text-xs text-slate-400">{reservationBookings.length}条记录</span>
                      </div>
                      {reservationBookings.length === 0 ? (
                        <div className="text-center py-8 text-slate-400">
                          <Calendar className="w-10 h-10 mx-auto mb-2 opacity-50" />
                          <p className="text-sm">暂无待入住预订</p>
                          <p className="text-xs mt-1">可切换到&ldquo;散客入住&rdquo;直接办理</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {reservationBookings.map(b => (
                            <button key={b.id} onClick={() => handleSelectBooking(b)}
                              className="w-full flex items-center justify-between p-4 rounded-xl border border-slate-100 bg-white hover:border-emerald-200 hover:bg-emerald-50/30 transition-all">
                              <div className="flex items-center gap-3">
                                <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center"><Calendar className="w-5 h-5 text-emerald-600" /></div>
                                <div className="text-left">
                                  <div className="font-semibold text-slate-800">{b.guestName} <span className="text-xs font-normal text-slate-400 ml-1">{b.guestPhone}</span></div>
                                  <div className="text-xs text-slate-500 mt-0.5">{b.roomTypeName} · {b.checkIn} ~ {b.checkOut} · {b.nights}晚</div>
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-sm font-semibold text-emerald-600">¥{b.totalPrice}</div>
                                <div className="text-xs text-slate-400">含押金¥{b.deposit}</div>
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Channel bookings list */}
                  {checkinSource === 'channel' && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-semibold text-slate-700">线上渠道订单</h4>
                        <span className="text-xs text-slate-400">{channelBookings.length}条待处理</span>
                      </div>
                      {channelBookings.length === 0 ? (
                        <div className="text-center py-8 text-slate-400">
                          <Globe className="w-10 h-10 mx-auto mb-2 opacity-50" />
                          <p className="text-sm">暂无渠道订单</p>
                        </div>
                      ) : (
                        <div className="space-y-2">
                          {channelBookings.map(b => (
                            <button key={b.id} onClick={() => handleSelectBooking(b)}
                              className="w-full flex items-center justify-between p-4 rounded-xl border bg-white hover:shadow-sm transition-all">
                              <div className="flex items-center gap-3">
                                <div className={`w-10 h-10 rounded-xl flex items-center justify-center border ${getChannelColor(b.source)}`}>
                                  <Globe className="w-4 h-4" />
                                </div>
                                <div className="text-left">
                                  <div className="font-semibold text-slate-800">
                                    {b.guestName}
                                    <span className={`ml-2 inline-flex items-center px-2 py-0.5 rounded-md text-xs font-medium border ${getChannelColor(b.source)}`}>
                                      {b.source}
                                    </span>
                                  </div>
                                  <div className="text-xs text-slate-500 mt-0.5">{b.roomTypeName} · {b.checkIn} ~ {b.checkOut} · {b.nights}晚</div>
                                  {b.remark && <div className="text-xs text-slate-400 mt-0.5">备注：{b.remark}</div>}
                                </div>
                              </div>
                              <div className="text-right">
                                <div className="text-sm font-semibold text-blue-600">¥{b.totalPrice}</div>
                                <div className="text-xs text-slate-400">已付¥{b.totalPrice - b.deposit} · 押金¥{b.deposit}</div>
                                {b.status === 'confirmed' && <span className="text-xs text-emerald-600 font-medium">已确认</span>}
                                {b.status === 'pending' && <span className="text-xs text-amber-600 font-medium">待确认</span>}
                              </div>
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Walk-in: show available rooms directly */}
                  {checkinSource === 'walk-in' && (
                    <div>
                      <div className="flex items-center justify-between mb-3">
                        <h4 className="text-sm font-semibold text-slate-700">空闲房间</h4>
                        <span className="text-xs text-slate-400">{availableRooms.length}间可售</span>
                      </div>
                      {availableRooms.length === 0 ? (
                        <div className="text-center py-8 text-slate-400">
                          <BedDouble className="w-10 h-10 mx-auto mb-2 opacity-50" />
                          <p className="text-sm">暂无空闲房间</p>
                        </div>
                      ) : (
                        <div className="space-y-4">
                          {Array.from(groupByType(availableRooms)).map(([typeName, rooms]) => (
                            <div key={typeName}>
                              <div className="flex items-center gap-2 mb-2">
                                <BedDouble className="w-4 h-4 text-emerald-600" />
                                <span className="text-sm font-semibold text-slate-700">{typeName}</span>
                                <span className="text-xs text-slate-400">{rooms.length}间可售</span>
                              </div>
                              <div className="grid grid-cols-4 gap-2">
                                {rooms.map(room => (
                                  <button key={room.id} onClick={() => { setSelectedRoom(room); setCheckinStep(3); }}
                                    className={`p-3 rounded-xl border-2 text-left transition-all ${selectedRoom?.id === room.id ? 'border-emerald-500 bg-emerald-50' : 'border-slate-100 bg-white hover:border-emerald-200 hover:bg-emerald-50/50'}`}>
                                    <div className="text-base font-bold text-slate-800">{room.roomNumber}</div>
                                    <div className="text-xs text-slate-400 mt-0.5">{room.floor}F · ¥{room.price}/晚</div>
                                  </button>
                                ))}
                              </div>
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  )}

                  {/* Next step button for reservation/channel */}
                  {checkinSource !== 'walk-in' && selectedBooking && (
                    <div className="pt-2">
                      <button onClick={() => setCheckinStep(2)}
                        className="w-full py-3 text-sm font-medium text-white bg-emerald-500 rounded-xl hover:bg-emerald-600 transition-colors shadow-sm">
                        下一步：选择房间
                      </button>
                    </div>
                  )}
                </div>
              )}

              {/* Step 2: Select Room (for reservation/channel) */}
              {checkinStep === 2 && selectedBooking && (
                <div className="space-y-4">
                  {/* Booking summary */}
                  <div className="bg-emerald-50 p-4 rounded-xl space-y-2">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-semibold text-emerald-700">
                        {selectedBooking.source === '门店预订' || selectedBooking.source === '前台' ? '预订信息' : '渠道订单信息'}
                      </span>
                      <span className={`text-xs px-2 py-0.5 rounded-md border ${getChannelColor(selectedBooking.source)}`}>{selectedBooking.source}</span>
                    </div>
                    <div className="grid grid-cols-2 gap-2 text-sm">
                      <div><span className="text-slate-500">客人：</span><span className="text-slate-800 font-medium">{selectedBooking.guestName}</span></div>
                      <div><span className="text-slate-500">电话：</span><span className="text-slate-800">{selectedBooking.guestPhone}</span></div>
                      <div><span className="text-slate-500">房型：</span><span className="text-slate-800">{selectedBooking.roomTypeName}</span></div>
                      <div><span className="text-slate-500">入住：</span><span className="text-slate-800">{selectedBooking.checkIn} ~ {selectedBooking.checkOut}</span></div>
                    </div>
                  </div>

                  {/* Room selection */}
                  <div>
                    <h4 className="text-sm font-semibold text-slate-700 mb-2">选择入住房间</h4>
                    {availableRooms.filter(r => r.roomTypeName === selectedBooking.roomTypeName).length === 0 ? (
                      <div className="p-4 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-700">
                        该房型暂无空闲房间，请选择其他房型或调整预订
                      </div>
                    ) : (
                      <div className="space-y-4">
                        {/* Preferred room type */}
                        <div>
                          <div className="flex items-center gap-2 mb-2">
                            <BedDouble className="w-4 h-4 text-emerald-600" />
                            <span className="text-sm font-semibold text-slate-700">{selectedBooking.roomTypeName}</span>
                            <span className="text-xs px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-600">预订房型</span>
                          </div>
                          <div className="grid grid-cols-4 gap-2">
                            {availableRooms.filter(r => r.roomTypeName === selectedBooking.roomTypeName).map(room => (
                              <button key={room.id} onClick={() => { setSelectedRoom(room); setCheckinStep(3); }}
                                className={`p-3 rounded-xl border-2 text-left transition-all ${selectedRoom?.id === room.id ? 'border-emerald-500 bg-emerald-50' : 'border-slate-100 bg-white hover:border-emerald-200'}`}>
                                <div className="text-base font-bold text-slate-800">{room.roomNumber}</div>
                                <div className="text-xs text-slate-400 mt-0.5">{room.floor}F · ¥{room.price}/晚</div>
                              </button>
                            ))}
                          </div>
                        </div>

                        {/* Other room types */}
                        {Array.from(groupByType(availableRooms.filter(r => r.roomTypeName !== selectedBooking.roomTypeName))).map(([typeName, rooms]) => (
                          <div key={typeName}>
                            <div className="flex items-center gap-2 mb-2">
                              <BedDouble className="w-4 h-4 text-slate-400" />
                              <span className="text-sm font-semibold text-slate-600">{typeName}</span>
                              <span className="text-xs text-slate-400">{rooms.length}间可售</span>
                            </div>
                            <div className="grid grid-cols-4 gap-2">
                              {rooms.map(room => (
                                <button key={room.id} onClick={() => { setSelectedRoom(room); setCheckinStep(3); }}
                                  className={`p-3 rounded-xl border-2 text-left transition-all ${selectedRoom?.id === room.id ? 'border-emerald-500 bg-emerald-50' : 'border-slate-100 bg-white hover:border-emerald-200'}`}>
                                  <div className="text-base font-bold text-slate-800">{room.roomNumber}</div>
                                  <div className="text-xs text-slate-400 mt-0.5">{room.floor}F · ¥{room.price}/晚</div>
                                </button>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Step 3: Fill Info */}
              {checkinStep === 3 && selectedRoom && (
                <div className="space-y-5">
                  {/* Selected room info */}
                  <div className="flex items-center justify-between bg-emerald-50 p-4 rounded-xl">
                    <div className="flex items-center gap-3">
                      <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-emerald-600" /></div>
                      <div>
                        <div className="font-semibold text-slate-800">{selectedRoom.roomTypeName} · {selectedRoom.roomNumber}</div>
                        <div className="text-sm text-slate-500">{selectedRoom.floor}F · ¥{selectedRoom.price}/晚</div>
                      </div>
                    </div>
                    <button onClick={() => setCheckinStep(checkinSource === 'walk-in' ? 1 : 2)} className="text-sm text-emerald-600 hover:text-emerald-700 font-medium">更换房间</button>
                  </div>

                  {/* Channel source tag (if from channel) */}
                  {selectedBooking && selectedBooking.source !== '门店预订' && selectedBooking.source !== '前台' && (
                    <div className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg border text-sm font-medium ${getChannelColor(selectedBooking.source)}`}>
                      <Globe className="w-4 h-4" />{selectedBooking.source}订单
                    </div>
                  )}

                  {/* Guest info */}
                  <div>
                    <div className="flex items-center justify-between mb-3">
                      <label className="text-sm font-semibold text-slate-700">入住人信息</label>
                      <button onClick={() => setGuests([...guests, { name: '', phone: '', idCard: '' }])}
                        className="flex items-center gap-1 text-xs text-emerald-600 hover:text-emerald-700 font-medium">
                        <Plus className="w-3.5 h-3.5" />添加入住人
                      </button>
                    </div>
                    {/* Matched customer card */}
                    {matchedCustomer && (
                      <div className="mb-3 p-3 bg-emerald-50 rounded-xl border border-emerald-200">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <div className="w-8 h-8 bg-emerald-200 text-emerald-800 rounded-full flex items-center justify-center font-bold text-sm">{matchedCustomer.name[0]}</div>
                            <div>
                              <div className="flex items-center gap-1.5">
                                <span className="text-sm font-semibold text-emerald-800">{matchedCustomer.name}</span>
                                <span className="text-[10px] px-1.5 py-0.5 bg-amber-100 text-amber-700 rounded">{matchedCustomer.memberLevel?.icon} {matchedCustomer.memberLevel?.name}</span>
                              </div>
                              <div className="flex items-center gap-1 text-[10px] text-emerald-600 mt-0.5">
                                <span>{matchedCustomer.stayCount}次入住</span>
                                {matchedCustomer.tags?.slice(0, 3).map((t: string) => <span key={t} className="px-1 bg-emerald-100 rounded">{t}</span>)}
                              </div>
                            </div>
                          </div>
                          <button onClick={() => setMatchedCustomer(null)} className="text-xs text-emerald-600 hover:text-emerald-800">取消匹配</button>
                        </div>
                        {matchedCustomer.preferences && matchedCustomer.preferences.length > 0 && (
                          <div className="mt-2 flex items-center gap-1 flex-wrap">
                            <Sparkles className="w-3 h-3 text-amber-500 flex-shrink-0" />
                            <span className="text-[10px] text-amber-600 font-medium">偏好：</span>
                            {matchedCustomer.preferences.split(',').map((p: string, i: number) => (
                              <span key={i} className="text-[10px] px-1.5 py-0.5 bg-amber-50 text-amber-700 rounded border border-amber-200">{p.trim()}</span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                    {guests.map((g, idx) => (
                      <div key={idx} className="flex gap-2 mb-2">
                        <div className="flex-1 relative">
                          {idx === 0 && <span className="absolute -top-1.5 left-3 text-[10px] text-red-500">*姓名</span>}
                          <input className={inputCls + (idx === 0 ? ' pt-5' : '')} placeholder="客人姓名" value={g.name}
                            onChange={e => { const n = [...guests]; n[idx] = { ...n[idx], name: e.target.value }; setGuests(n); }} />
                        </div>
                        <div className="flex-1 relative">
                          {idx === 0 && <span className="absolute -top-1.5 left-3 text-[10px] text-red-500">*手机号</span>}
                          <input className={inputCls + (idx === 0 ? ' pt-5' : '')} placeholder="输入手机号自动匹配客户" value={g.phone}
                            onChange={e => { if (idx === 0) handlePhoneInput(e.target.value, idx); else { const n = [...guests]; n[idx] = { ...n[idx], phone: e.target.value }; setGuests(n); } }} />
                          {/* Customer match dropdown */}
                          {idx === 0 && showCustomerMatch && customerMatches.length > 0 && (
                            <div className="absolute top-full left-0 right-0 mt-1 bg-white rounded-xl border border-slate-200 shadow-lg z-20 max-h-48 overflow-y-auto">
                              {customerMatches.map((cm) => (
                                <button key={cm.id} className="w-full flex items-center gap-3 px-3 py-2.5 hover:bg-emerald-50 text-left transition-colors"
                                  onClick={() => selectMatchedCustomer(cm)}>
                                  <div className="w-7 h-7 bg-emerald-100 text-emerald-700 rounded-full flex items-center justify-center font-bold text-xs">{cm.name[0]}</div>
                                  <div className="flex-1 min-w-0">
                                    <div className="flex items-center gap-1.5">
                                      <span className="text-sm font-medium text-slate-800">{cm.name}</span>
                                      <span className="text-[10px] text-slate-400">{cm.phone}</span>
                                    </div>
                                    <div className="flex items-center gap-1 text-[10px] text-slate-400">
                                      <span>{cm.stayCount}次入住</span>
                                      <span>·</span>
                                      {(cm.tags ?? []).slice(0, 2).map((t: string) => <span key={t} className="text-emerald-600">{t}</span>)}
                                    </div>
                                  </div>
                                  <span className="text-[10px] text-emerald-600">点击匹配</span>
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <div className="flex-1">
                          <input className={inputCls} placeholder="身份证号(选填)" value={g.idCard}
                            onChange={e => { const n = [...guests]; n[idx] = { ...n[idx], idCard: e.target.value }; setGuests(n); }} />
                        </div>
                        {guests.length > 1 && (
                          <button onClick={() => setGuests(guests.filter((_, i) => i !== idx))} className="p-2 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                            <Minus className="w-4 h-4" />
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {/* Dates */}
                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className="text-sm font-semibold text-slate-700 mb-1.5 block">入住日期</label>
                      <input type="date" className={inputCls} value={checkInDate} onChange={e => setCheckInDate(e.target.value)} />
                    </div>
                    <div>
                      <label className="text-sm font-semibold text-slate-700 mb-1.5 block">离店日期</label>
                      <input type="date" className={inputCls} value={checkOutDate} onChange={e => setCheckOutDate(e.target.value)} />
                    </div>
                  </div>

                  {/* Deposit & Payment */}
                  <div className="grid grid-cols-3 gap-4">
                    <div>
                      <label className="text-sm font-semibold text-slate-700 mb-1.5 block">押金金额</label>
                      <div className="relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-slate-400 text-sm">¥</span>
                        <input type="number" className={inputCls + " pl-7"} placeholder="500" value={deposit} onChange={e => setDeposit(e.target.value)} />
                      </div>
                    </div>
                    <div>
                      <label className="text-sm font-semibold text-slate-700 mb-1.5 block">支付方式</label>
                      <select className={inputCls} value={payMethod} onChange={e => setPayMethod(e.target.value)}>
                        <option value="cash">现金</option>
                        <option value="wechat">微信</option>
                        <option value="alipay">支付宝</option>
                        <option value="card">银行卡</option>
                        {selectedBooking && selectedBooking.source !== '门店预订' && selectedBooking.source !== '前台' && <option value="prepaid">线上已付</option>}
                      </select>
                    </div>
                    <div>
                      <label className="text-sm font-semibold text-slate-700 mb-1.5 block">入住人数</label>
                      <select className={inputCls} value={guestCount} onChange={e => setGuestCount(Number(e.target.value))}>
                        {[1,2,3,4,5,6].map(n => <option key={n} value={n}>{n}人</option>)}
                      </select>
                    </div>
                  </div>

                  {/* Remark */}
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-1.5 block">备注</label>
                    <input className={inputCls} placeholder="如有特殊需求请备注" value={remark} onChange={e => setRemark(e.target.value)} />
                  </div>

                  {/* Summary */}
                  <div className="bg-slate-50 p-4 rounded-xl space-y-2">
                    <div className="flex justify-between text-sm"><span className="text-slate-500">房费</span><span className="text-slate-700">¥{selectedRoom.price} × {nights}晚 = ¥{totalRoomCharge}</span></div>
                    {deposit && <div className="flex justify-between text-sm"><span className="text-slate-500">押金</span><span className="text-slate-700">¥{deposit}</span></div>}
                    {selectedBooking && selectedBooking.source !== '门店预订' && selectedBooking.source !== '前台' && (
                      <div className="flex justify-between text-sm"><span className="text-slate-500">渠道已付</span><span className="text-emerald-600">-¥{selectedBooking.totalPrice - selectedBooking.deposit}</span></div>
                    )}
                    <div className="border-t border-slate-200 pt-2 flex justify-between font-semibold">
                      <span>应收合计</span>
                      <span className="text-emerald-600 text-lg">¥{Math.max(0, totalRoomCharge + (deposit ? Number(deposit) : 0) - (selectedBooking && selectedBooking.source !== '门店预订' && selectedBooking.source !== '前台' ? selectedBooking.totalPrice - selectedBooking.deposit : 0))}</span>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 border-t border-slate-100 p-5 bg-slate-50/50 rounded-b-2xl">
              <div className="flex justify-end gap-3">
                <button onClick={() => { if (checkinStep > 1) setCheckinStep(checkinStep - 1); else setCheckinOpen(false); }}
                  className="px-6 py-2.5 text-sm text-slate-600 hover:text-slate-800 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
                  {checkinStep > 1 ? '上一步' : '取消'}
                </button>
                {checkinStep === 3 && (
                  <button onClick={handleConfirmCheckin}
                    disabled={!selectedRoom || !guests[0].name || !guests[0].phone}
                    className="px-8 py-2.5 text-sm font-medium text-white bg-emerald-500 rounded-xl hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm">
                    确认入住
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== CHECK-OUT DIALOG ========== */}
      {checkoutOpen && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center" onClick={() => setCheckoutOpen(false)}>
          <div className="bg-white rounded-2xl w-[860px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between p-5 border-b border-slate-100 bg-gradient-to-r from-blue-500 to-blue-600 rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><LogOut className="w-5 h-5 text-white" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-white">快速退房</h3>
                  <p className="text-xs text-blue-100">选择房间 → 核查结算 → 完成退房</p>
                </div>
              </div>
              <button onClick={() => setCheckoutOpen(false)} className="p-1 hover:bg-white/20 rounded-lg transition-colors"><X className="w-5 h-5 text-white" /></button>
            </div>

            {/* Steps */}
            <div className="flex-shrink-0 flex items-center gap-2 px-6 pt-4 pb-2">
              {[{ step: 1, label: '选择房间' }, { step: 2, label: '核查结算' }].map((s, i) => (
                <React.Fragment key={s.step}>
                  <div className={`flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-medium transition-colors ${checkoutStep >= s.step ? 'bg-blue-50 text-blue-700' : 'bg-slate-50 text-slate-400'}`}>
                    <span className={`w-6 h-6 rounded-full flex items-center justify-center text-xs font-bold ${checkoutStep >= s.step ? 'bg-blue-500 text-white' : 'bg-slate-200 text-slate-500'}`}>{s.step}</span>
                    {s.label}
                  </div>
                  {i === 0 && <ArrowRight className="w-4 h-4 text-slate-300" />}
                </React.Fragment>
              ))}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-3 min-h-0">
              {checkoutStep === 1 && (
                <div>
                  {occupiedRooms.length === 0 ? (
                    <div className="text-center py-12 text-slate-400">
                      <BedDouble className="w-12 h-12 mx-auto mb-2 opacity-50" />
                      <p>暂无在住房间</p>
                    </div>
                  ) : (
                    <div className="space-y-2">
                      {occupiedRooms.map(room => (
                        <button key={room.id} onClick={() => { setCheckoutRoom(room); setCheckoutStep(2); }}
                          className={`w-full flex items-center justify-between p-4 rounded-xl border-2 transition-all ${checkoutRoom?.id === room.id ? 'border-blue-500 bg-blue-50' : 'border-slate-100 bg-white hover:border-blue-200'}`}>
                          <div className="flex items-center gap-3">
                            <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-blue-600" /></div>
                            <div className="text-left">
                              <div className="font-semibold text-slate-800">{room.roomTypeName} · {room.roomNumber}</div>
                              <div className="flex items-center gap-2 text-xs text-slate-500">
                                <span>{room.floor}F</span>
                                <span>·</span>
                                <span>{room.guest || '未知客人'}</span>
                                <span>·</span>
                                <span>¥{room.price}/晚</span>
                                {room.guest && room.checkIn && (
                                  <>
                                    <span>·</span>
                                    <span className="text-blue-600">{room.checkIn} 入住</span>
                                  </>
                                )}
                              </div>
                            </div>
                          </div>
                          <div className="flex items-center gap-2">
                            {room.source && room.source !== 'booking' && (
                              <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${room.source === 'ctrip' ? 'bg-blue-100 text-blue-700' : room.source === 'meituan' ? 'bg-amber-100 text-amber-700' : room.source === 'fliggy' ? 'bg-orange-100 text-orange-700' : 'bg-purple-100 text-purple-700'}`}>
                                {room.source === 'ctrip' ? '携程' : room.source === 'meituan' ? '美团' : room.source === 'fliggy' ? '飞猪' : room.source === 'booking' ? 'Booking' : 'OTA'}
                              </span>
                            )}
                            <ArrowRight className="w-4 h-4 text-slate-400" />
                          </div>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {checkoutStep === 2 && checkoutRoom && (
                <div className="space-y-4">
                  {/* 入住详情 */}
                  <div className="bg-blue-50/60 p-4 rounded-xl border border-blue-100">
                    <div className="flex items-center justify-between mb-3">
                      <div className="flex items-center gap-2">
                        <div className="w-8 h-8 bg-blue-100 rounded-lg flex items-center justify-center"><BedDouble className="w-4 h-4 text-blue-600" /></div>
                        <span className="font-semibold text-slate-800">{checkoutRoom.roomTypeName} · {checkoutRoom.roomNumber}</span>
                      </div>
                      <button onClick={() => setCheckoutStep(1)} className="text-xs text-blue-600 hover:text-blue-700 font-medium">更换房间</button>
                    </div>
                    <div className="grid grid-cols-4 gap-3">
                      <div className="bg-white rounded-lg p-2.5 border border-blue-50">
                        <div className="text-xs text-slate-400 mb-0.5">客人</div>
                        <div className="text-sm font-medium text-slate-700 truncate">{checkoutRoom.guest || '未知'}</div>
                      </div>
                      <div className="bg-white rounded-lg p-2.5 border border-blue-50">
                        <div className="text-xs text-slate-400 mb-0.5">入住日期</div>
                        <div className="text-sm font-medium text-slate-700">{checkoutRoom.checkIn || '-'}</div>
                      </div>
                      <div className="bg-white rounded-lg p-2.5 border border-blue-50">
                        <div className="text-xs text-slate-400 mb-0.5">离店日期</div>
                        <div className="text-sm font-medium text-slate-700">{checkoutRoom.checkOut || '-'}</div>
                      </div>
                      <div className="bg-white rounded-lg p-2.5 border border-blue-50">
                        <div className="text-xs text-slate-400 mb-0.5">来源渠道</div>
                        <div className="text-sm font-medium text-slate-700 flex items-center gap-1">
                          {checkoutRoom.source === 'ctrip' ? '携程' : checkoutRoom.source === 'meituan' ? '美团' : checkoutRoom.source === 'fliggy' ? '飞猪' : checkoutRoom.source === 'booking' ? 'Booking' : '预定'}
                          {checkoutRoom.source && checkoutRoom.source !== 'booking' && (
                            <span className="text-xs text-slate-400">· OTA</span>
                          )}
                        </div>
                      </div>
                    </div>
                    {checkoutRoom.guestPhone && (
                      <div className="mt-2 text-xs text-slate-500">联系电话：{checkoutRoom.guestPhone}</div>
                    )}
                  </div>

                  {/* 退房方式 */}
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">退房方式</label>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { key: 'normal' as const, label: '正常退房', desc: '按原计划退房', icon: LogOut },
                        { key: 'late' as const, label: '延迟退房', desc: '延后退房时间', icon: Clock },
                        { key: 'early' as const, label: '提前退房', desc: '提前结束入住', icon: AlertCircle },
                      ]).map(m => (
                        <button key={m.key} onClick={() => setCheckoutMode(m.key)}
                          className={`p-3 rounded-xl border-2 text-left transition-all ${checkoutMode === m.key ? 'border-blue-500 bg-blue-50' : 'border-slate-100 bg-white hover:border-blue-200'}`}>
                          <m.icon className={`w-5 h-5 mb-1 ${checkoutMode === m.key ? 'text-blue-600' : 'text-slate-400'}`} />
                          <div className={`text-sm font-medium ${checkoutMode === m.key ? 'text-blue-700' : 'text-slate-700'}`}>{m.label}</div>
                          <div className="text-xs text-slate-400">{m.desc}</div>
                        </button>
                      ))}
                    </div>
                  </div>

                  {checkoutMode === 'late' && (
                    <div>
                      <label className="text-sm font-semibold text-slate-700 mb-2 block">延迟退房时间</label>
                      <div className="grid grid-cols-3 gap-2">
                        {[
                          { label: '14:00', fee: '免费' },
                          { label: '18:00', fee: `¥${Math.round(checkoutRoom.price * 0.5)}` },
                          { label: '次日12:00', fee: `¥${checkoutRoom.price}` },
                        ].map(opt => (
                          <div key={opt.label} className="p-3 rounded-xl border border-slate-200 bg-white text-center">
                            <div className="text-sm font-semibold text-slate-700">{opt.label}</div>
                            <div className="text-xs text-slate-400 mt-0.5">加收 {opt.fee}</div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}

                  {checkoutMode === 'early' && (
                    <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-700">
                      提前退房：未住完天数按半日房价退还，即每晚退还 ¥{earlyCheckoutRefund}
                    </div>
                  )}

                  {/* 额外消费 - 快捷添加 */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-semibold text-slate-700">额外消费</label>
                      <button onClick={() => setExtraCharges([...extraCharges, { name: '', amount: 0 }])}
                        className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 font-medium">
                        <Plus className="w-3.5 h-3.5" />自定义添加
                      </button>
                    </div>
                    {/* 快捷消费项 */}
                    <div className="flex flex-wrap gap-2 mb-3">
                      {[
                        { name: 'Minibar', amount: 68 },
                        { name: '早餐', amount: 38 },
                        { name: '洗衣服务', amount: 50 },
                        { name: '停车费', amount: 30 },
                        { name: '延迟退房费', amount: Math.round(checkoutRoom.price * 0.5) },
                        { name: '房间赔偿', amount: 200 },
                        { name: '加床费', amount: 100 },
                        { name: '延时入住费', amount: Math.round(checkoutRoom.price * 0.5) },
                      ].map(item => {
                        const alreadyAdded = extraCharges.some(c => c.name === item.name);
                        return (
                          <button key={item.name}
                            onClick={() => { if (!alreadyAdded) setExtraCharges([...extraCharges, { name: item.name, amount: item.amount }]); }}
                            disabled={alreadyAdded}
                            className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-colors border ${alreadyAdded ? 'bg-slate-100 text-slate-400 border-slate-200 cursor-not-allowed' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300 hover:text-blue-600 hover:bg-blue-50'}`}>
                            {item.name} ¥{item.amount}
                            {alreadyAdded && ' ✓'}
                          </button>
                        );
                      })}
                    </div>
                    {/* 已添加的消费项列表 */}
                    {extraCharges.length > 0 && (
                      <div className="space-y-2">
                        {extraCharges.map((charge, idx) => (
                          <div key={idx} className="flex items-center gap-2 bg-slate-50 rounded-lg px-3 py-2">
                            <input className="flex-1 bg-transparent text-sm text-slate-700 font-medium outline-none" value={charge.name}
                              onChange={e => { const n = [...extraCharges]; n[idx] = { ...n[idx], name: e.target.value }; setExtraCharges(n); }} />
                            <div className="flex items-center gap-1">
                              <span className="text-slate-400 text-sm">¥</span>
                              <input type="number" className="w-20 bg-white border border-slate-200 rounded-lg px-2 py-1 text-sm text-slate-700 text-right outline-none focus:border-blue-400" value={charge.amount || ''}
                                onChange={e => { const n = [...extraCharges]; n[idx] = { ...n[idx], amount: Number(e.target.value) }; setExtraCharges(n); }} />
                            </div>
                            <button onClick={() => setExtraCharges(extraCharges.filter((_, i) => i !== idx))} className="p-1 text-red-400 hover:text-red-600 hover:bg-red-50 rounded-lg">
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  {/* 物品检查确认 */}
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">物品检查</label>
                    <div className="grid grid-cols-3 gap-2">
                      {([
                        { key: 'keyReturned' as const, label: '钥匙已回收', icon: '🔑' },
                        { key: 'roomChecked' as const, label: '房间已检查', icon: '🔍' },
                        { key: 'minibarChecked' as const, label: 'Minibar已核', icon: '🍷' },
                      ]).map(item => (
                        <button key={item.key} onClick={() => setCheckoutItems({ ...checkoutItems, [item.key]: !checkoutItems[item.key] })}
                          className={`flex items-center gap-2.5 p-3 rounded-xl border-2 transition-all ${checkoutItems[item.key] ? 'border-emerald-500 bg-emerald-50' : 'border-slate-100 bg-white hover:border-slate-200'}`}>
                          <span className="text-lg">{item.icon}</span>
                          <span className={`text-sm font-medium ${checkoutItems[item.key] ? 'text-emerald-700' : 'text-slate-500'}`}>{item.label}</span>
                          {checkoutItems[item.key] && <span className="ml-auto text-emerald-500 text-xs font-bold">✓</span>}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 结算明细 */}
                  <div className="bg-slate-50 p-4 rounded-xl space-y-2">
                    <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-2">结算明细</div>
                    <div className="flex justify-between text-sm"><span className="text-slate-500">房费({checkoutNights}晚 × ¥{checkoutRoom.price})</span><span className="text-slate-700">¥{checkoutRoomCharge}</span></div>
                    {checkoutTotalExtra > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">额外消费</span><span className="text-slate-700">¥{checkoutTotalExtra}</span></div>}
                    {lateCheckoutFee > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">延迟退房费</span><span className="text-orange-600">¥{lateCheckoutFee}</span></div>}
                    {earlyCheckoutRefund > 0 && <div className="flex justify-between text-sm"><span className="text-slate-500">提前退房退还</span><span className="text-emerald-600">-¥{earlyCheckoutRefund}</span></div>}
                    <div className="flex justify-between text-sm"><span className="text-slate-500">押金</span><span className="text-slate-700">¥{depositAmount}</span></div>
                    <div className="border-t border-slate-200 pt-2 flex justify-between font-semibold">
                      <span>应退金额</span>
                      <span className={`text-lg ${checkoutRefund >= 0 ? 'text-blue-600' : 'text-red-600'}`}>¥{checkoutRefund}</span>
                    </div>
                  </div>

                  {/* 退款方式 */}
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-2 block">退款方式</label>
                    <div className="grid grid-cols-4 gap-2">
                      {[
                        { key: 'original', label: '原路退回' },
                        { key: 'cash', label: '现金退款' },
                        { key: 'transfer', label: '银行卡转账' },
                        { key: 'none', label: '无需退款' },
                      ].map(m => (
                        <button key={m.key} onClick={() => setRefundMethod(m.key)}
                          className={`py-2.5 px-3 rounded-xl border text-sm font-medium transition-colors ${refundMethod === m.key ? 'border-blue-500 bg-blue-50 text-blue-700' : 'border-slate-200 bg-white text-slate-600 hover:border-slate-300'}`}>
                          {m.label}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* 发票需求 */}
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <label className="text-sm font-semibold text-slate-700">发票需求</label>
                      <button onClick={() => setInvoiceNeeded(!invoiceNeeded)}
                        className={`relative w-10 h-5 rounded-full transition-colors ${invoiceNeeded ? 'bg-emerald-500' : 'bg-slate-200'}`}>
                        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow-sm transition-transform ${invoiceNeeded ? 'left-5.5 translate-x-0' : 'left-0.5'}`} />
                      </button>
                    </div>
                    {invoiceNeeded && (
                      <div className="bg-slate-50 rounded-xl p-4 space-y-3">
                        <div className="flex gap-2">
                          <button onClick={() => setInvoiceType('company')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${invoiceType === 'company' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500'}`}>
                            企业发票
                          </button>
                          <button onClick={() => setInvoiceType('personal')}
                            className={`px-4 py-2 rounded-lg text-sm font-medium border transition-colors ${invoiceType === 'personal' ? 'bg-blue-50 border-blue-300 text-blue-700' : 'bg-white border-slate-200 text-slate-500'}`}>
                            个人发票
                          </button>
                        </div>
                        <input className={inputCls} placeholder={invoiceType === 'company' ? '公司名称 / 开票抬头' : '个人姓名'} value={invoiceTitle} onChange={e => setInvoiceTitle(e.target.value)} />
                        {invoiceType === 'company' && (
                          <input className={inputCls} placeholder="统一社会信用代码 / 税号" value={invoiceTaxId} onChange={e => setInvoiceTaxId(e.target.value)} />
                        )}
                      </div>
                    )}
                  </div>

                  {/* 渠道同步提示 */}
                  {checkoutRoom.source && checkoutRoom.source !== 'booking' && (
                    <div className="p-3 rounded-xl bg-purple-50 border border-purple-200 text-sm text-purple-700 flex items-start gap-2">
                      <span className="text-base">📡</span>
                      <div>
                        <span className="font-medium">渠道同步提醒：</span>此订单来自
                        {checkoutRoom.source === 'ctrip' ? '携程' : checkoutRoom.source === 'meituan' ? '美团' : checkoutRoom.source === 'fliggy' ? '飞猪' : checkoutRoom.source === 'booking' ? 'Booking' : 'OTA渠道'}，
                        退房后将自动同步退房状态至渠道，并关闭渠道订单
                      </div>
                    </div>
                  )}

                  {/* 备注 */}
                  <div>
                    <label className="text-sm font-semibold text-slate-700 mb-1.5 block">备注</label>
                    <input className={inputCls} placeholder="退房备注(选填)" value={checkoutRemark} onChange={e => setCheckoutRemark(e.target.value)} />
                  </div>

                  <div className="p-3 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-700 flex items-start gap-2">
                    <AlertCircle className="w-4 h-4 mt-0.5 flex-shrink-0" />
                    <span>退房后房间将变为&ldquo;脏房&rdquo;状态，需安排清洁后才能再次入住</span>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 border-t border-slate-100 p-5 bg-slate-50/50 rounded-b-2xl">
              <div className="flex justify-between items-center">
                {checkoutStep === 2 && checkoutRoom && (
                  <div className="text-sm text-slate-500">
                    {checkoutItems.keyReturned && checkoutItems.roomChecked ? (
                      <span className="text-emerald-600 font-medium">✓ 物品检查已确认</span>
                    ) : (
                      <span className="text-amber-600">⚠ 请确认物品检查</span>
                    )}
                  </div>
                )}
                <div className="flex gap-3 ml-auto">
                  <button onClick={() => { if (checkoutStep === 2) setCheckoutStep(1); else setCheckoutOpen(false); }}
                    className="px-6 py-2.5 text-sm text-slate-600 hover:text-slate-800 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
                    {checkoutStep === 2 ? '上一步' : '取消'}
                  </button>
                  {checkoutStep === 2 && (
                    <button onClick={handleConfirmCheckout} disabled={!checkoutRoom}
                      className="px-8 py-2.5 text-sm font-medium text-white bg-blue-500 rounded-xl hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors shadow-sm">
                      确认退房
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ========== HOUSEKEEPING DIALOG ========== */}
      {housekeepingOpen && (
        <div className="fixed inset-0 bg-black/40 z-[60] flex items-center justify-center" onClick={() => setHousekeepingOpen(false)}>
          <div className="bg-white rounded-2xl w-[860px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="flex-shrink-0 flex items-center justify-between px-6 py-4 bg-gradient-to-r from-amber-500 to-orange-500 rounded-t-2xl">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><SprayCan className="w-5 h-5 text-white" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-white">房务任务</h3>
                  <p className="text-xs text-amber-100">报脏报修 · 派单清洁 · 检查确认</p>
                </div>
              </div>
              <button onClick={() => setHousekeepingOpen(false)} className="p-1 hover:bg-white/20 rounded-lg transition-colors"><X className="w-5 h-5 text-white" /></button>
            </div>

            {/* Stats + Add Button */}
            <div className="flex-shrink-0 flex items-center justify-between px-6 pt-4 pb-2">
              <div className="grid grid-cols-5 gap-2 flex-1">
                {([
                  { label: '紧急', count: hkTasks.filter(t => t.priority === 'urgent' && t.status !== 'inspected').length, color: 'text-red-600', bg: 'bg-red-50', icon: '🔴' },
                  { label: '待处理', count: hkTasks.filter(t => t.status === 'pending').length, color: 'text-amber-600', bg: 'bg-amber-50', icon: '📋' },
                  { label: '清洁中', count: hkTasks.filter(t => t.status === 'in_progress').length, color: 'text-blue-600', bg: 'bg-blue-50', icon: '🧹' },
                  { label: '待检查', count: hkTasks.filter(t => t.status === 'completed').length, color: 'text-purple-600', bg: 'bg-purple-50', icon: '🔍' },
                  { label: '已通过', count: hkTasks.filter(t => t.status === 'inspected').length, color: 'text-emerald-600', bg: 'bg-emerald-50', icon: '✅' },
                ]).map(s => (
                  <div key={s.label} className={`${s.bg} px-3 py-2 rounded-xl text-center`}>
                    <div className="text-lg">{s.icon}</div>
                    <div className={`text-xl font-bold ${s.color}`}>{s.count}</div>
                    <div className="text-xs text-slate-500">{s.label}</div>
                  </div>
                ))}
              </div>
              <button onClick={() => setShowAddTask(true)}
                className="ml-3 px-4 py-2.5 text-sm font-medium text-white bg-amber-500 rounded-xl hover:bg-amber-600 transition-colors flex items-center gap-1.5 whitespace-nowrap">
                <Plus className="w-4 h-4" /> 报脏/报修
              </button>
            </div>

            {/* Tabs */}
            <div className="flex-shrink-0 flex gap-1 px-6 pb-2 border-b border-slate-100">
              {(['pending', 'in_progress', 'completed'] as const).map((tab) => {
                const tabLabels: Record<string, string> = { pending: '待处理', in_progress: '清洁中', completed: '待检查' };
                const tabCounts: Record<string, number> = { pending: hkTasks.filter(t => t.status === 'pending').length, in_progress: hkTasks.filter(t => t.status === 'in_progress').length, completed: hkTasks.filter(t => t.status === 'completed').length };
                return (
                  <button key={tab} onClick={() => setHkTab(tab)}
                    className={`px-4 py-2 text-sm font-medium rounded-t-lg transition-colors ${hkTab === tab ? 'text-amber-600 bg-amber-50 border-b-2 border-amber-500' : 'text-slate-500 hover:text-slate-700'}`}>
                    {tabLabels[tab]} ({tabCounts[tab]})
                  </button>
                );
              })}
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto px-6 py-4 min-h-0">
              {hkTasks.filter(t => t.status === hkTab).length === 0 ? (
                <div className="text-center py-12 text-slate-400">
                  <CheckCircle2 className="w-12 h-12 mx-auto mb-2 opacity-50" />
                  <p>{hkTab === 'pending' ? '暂无待处理任务' : hkTab === 'in_progress' ? '暂无清洁中任务' : '暂无待检查任务'}</p>
                </div>
              ) : (
                <div className="space-y-2">
                  {hkTasks.filter(t => t.status === hkTab).sort((a, b) => {
                    const po: Record<string, number> = { urgent: 0, high: 1, normal: 2, low: 3 };
                    return (po[a.priority] ?? 2) - (po[b.priority] ?? 2);
                  }).map(task => (
                    <div key={task.id} className="flex items-center justify-between p-4 rounded-xl border border-slate-100 bg-white hover:shadow-sm transition-shadow">
                      <div className="flex items-center gap-3">
                        {/* Priority indicator */}
                        <div className={`w-1.5 h-12 rounded-full ${task.priority === 'urgent' ? 'bg-red-500' : task.priority === 'high' ? 'bg-orange-500' : task.priority === 'normal' ? 'bg-blue-400' : 'bg-slate-300'}`} />
                        <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${task.type === '维修' ? 'bg-red-50' : task.type === '深度清洁' ? 'bg-purple-50' : 'bg-amber-50'}`}>
                          {task.type === '维修' ? <Wrench className="w-5 h-5 text-red-500" /> : task.type === '深度清洁' ? <Sparkles className="w-5 h-5 text-purple-500" /> : <SprayCan className="w-5 h-5 text-amber-600" />}
                        </div>
                        <div>
                          <div className="flex items-center gap-2">
                            <span className="font-semibold text-slate-800">{task.roomNumber} · {task.roomTypeName}</span>
                            <span className={`text-xs px-1.5 py-0.5 rounded font-medium ${task.type === '维修' ? 'bg-red-50 text-red-600' : task.type === '深度清洁' ? 'bg-purple-50 text-purple-600' : 'bg-amber-50 text-amber-600'}`}>{task.type}</span>
                            {task.priority === 'urgent' && <span className="text-xs px-1.5 py-0.5 rounded bg-red-100 text-red-700 font-bold">紧急</span>}
                          </div>
                          <div className="text-xs text-slate-400 mt-0.5">
                            {task.floor}F · {task.assignee ? `${task.assignee}` : '待派单'}
                            {task.startedAt && ` · 开始于 ${task.startedAt}`}
                            {task.duration && ` · 预计${task.duration}分钟`}
                            {task.remark && ` · "${task.remark}"`}
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        {task.status === 'pending' && (
                          <button onClick={() => { setHkAssignRoom(task); setHkAssignee(task.assignee || ''); setHkAssignPriority(task.priority); }}
                            className="px-3 py-1.5 text-xs font-medium text-amber-600 bg-amber-50 border border-amber-200 rounded-lg hover:bg-amber-100 transition-colors">
                            派单
                          </button>
                        )}
                        {task.status === 'in_progress' && (
                          <button onClick={() => handleCompleteTask(task.id)}
                            className="px-3 py-1.5 text-xs font-medium text-blue-600 bg-blue-50 border border-blue-200 rounded-lg hover:bg-blue-100 transition-colors">
                            标记完成
                          </button>
                        )}
                        {task.status === 'completed' && (
                          <button onClick={() => handleInspectTask(task.id)}
                            className="px-3 py-1.5 text-xs font-medium text-emerald-600 bg-emerald-50 border border-emerald-200 rounded-lg hover:bg-emerald-100 transition-colors">
                            检查通过
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}

              {/* Inspected tasks (collapsed) */}
              {hkTab === 'completed' && hkTasks.filter(t => t.status === 'inspected').length > 0 && (
                <div className="mt-4">
                  <div className="flex items-center gap-2 mb-2 text-slate-400 text-xs">
                    <CheckCircle2 className="w-4 h-4" /> 已检查通过 ({hkTasks.filter(t => t.status === 'inspected').length})
                  </div>
                  <div className="space-y-1">
                    {hkTasks.filter(t => t.status === 'inspected').map(task => (
                      <div key={task.id} className="flex items-center justify-between p-3 rounded-lg bg-emerald-50/50 border border-emerald-100">
                        <div className="flex items-center gap-2 text-sm">
                          <CheckCircle2 className="w-4 h-4 text-emerald-500" />
                          <span className="text-slate-600">{task.roomNumber} · {task.roomTypeName}</span>
                          <span className="text-xs text-slate-400">{task.assignee}完成 · {task.completedAt}</span>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              {/* Assign modal */}
              {hkAssignRoom && (
                <div className="fixed inset-0 bg-black/30 z-[70] flex items-center justify-center" onClick={() => setHkAssignRoom(null)}>
                  <div className="bg-white rounded-2xl p-6 w-96 shadow-xl" onClick={e => e.stopPropagation()}>
                    <h4 className="font-semibold text-slate-800 mb-1">派单 - {hkAssignRoom.roomNumber} {hkAssignRoom.roomTypeName}</h4>
                    <p className="text-xs text-slate-400 mb-4">{hkAssignRoom.type}任务 · {hkAssignRoom.floor}F</p>

                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">清洁人员</label>
                        <select className={inputCls + " w-full"} value={hkAssignee} onChange={e => setHkAssignee(e.target.value)}>
                          <option value="">选择人员</option>
                          {hkCleaners.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">优先级</label>
                        <select className={inputCls + " w-full"} value={hkAssignPriority} onChange={e => setHkAssignPriority(e.target.value as 'urgent' | 'high' | 'normal' | 'low')}>
                          <option value="urgent">🔴 紧急 - VIP退房</option>
                          <option value="high">🟠 高 - 今日入住</option>
                          <option value="normal">🔵 普通</option>
                          <option value="low">⚪ 低</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">预计耗时</label>
                        <select className={inputCls + " w-full"} value={hkAssignDuration} onChange={e => setHkAssignDuration(e.target.value)}>
                          <option value="20">20分钟</option>
                          <option value="30">30分钟</option>
                          <option value="45">45分钟</option>
                          <option value="60">60分钟</option>
                          <option value="90">90分钟（深度清洁）</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">备注</label>
                        <input className={inputCls + " w-full"} placeholder="如：客人要求环保清洁、注意地毯污渍等" value={hkAssignRemark} onChange={e => setHkAssignRemark(e.target.value)} />
                      </div>
                    </div>

                    <div className="flex gap-2 mt-5">
                      <button onClick={() => setHkAssignRoom(null)} className="flex-1 px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200">取消</button>
                      <button onClick={handleAssignTask} disabled={!hkAssignee} className="flex-1 px-4 py-2 text-sm font-medium text-white bg-amber-500 rounded-xl hover:bg-amber-600 disabled:opacity-40">确认派单</button>
                    </div>
                  </div>
                </div>
              )}

              {/* Add Task modal */}
              {showAddTask && (
                <div className="fixed inset-0 bg-black/30 z-[70] flex items-center justify-center" onClick={() => setShowAddTask(false)}>
                  <div className="bg-white rounded-2xl p-6 w-[420px] shadow-xl" onClick={e => e.stopPropagation()}>
                    <h4 className="font-semibold text-slate-800 mb-4">报脏 / 报修</h4>
                    <div className="space-y-3">
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">房间号</label>
                        <select className={inputCls + " w-full"} value={addTaskRoom} onChange={e => setAddTaskRoom(e.target.value)}>
                          <option value="">选择房间</option>
                          {[...availableRooms, ...occupiedRooms].map(r => (
                            <option key={r.id} value={r.id}>{r.roomNumber} - {r.roomTypeName} ({statusLabel[r.status] || r.status})</option>
                          ))}
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">任务类型</label>
                        <select className={inputCls + " w-full"} value={addTaskType} onChange={e => setAddTaskType(e.target.value)}>
                          <option value="日常清洁">🧹 日常清洁</option>
                          <option value="深度清洁">✨ 深度清洁</option>
                          <option value="维修">🔧 维修</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">优先级</label>
                        <select className={inputCls + " w-full"} value={addTaskPriority} onChange={e => setAddTaskPriority(e.target.value as 'urgent' | 'high' | 'normal' | 'low')}>
                          <option value="urgent">🔴 紧急</option>
                          <option value="high">🟠 高</option>
                          <option value="normal">🔵 普通</option>
                          <option value="low">⚪ 低</option>
                        </select>
                      </div>
                      <div>
                        <label className="text-xs font-medium text-slate-500 mb-1 block">问题描述</label>
                        <textarea className={inputCls + " w-full min-h-[80px] resize-none"} placeholder="如：地毯有咖啡渍、空调不制热、卫生间水龙头漏水等" value={addTaskRemark} onChange={e => setAddTaskRemark(e.target.value)} />
                      </div>
                    </div>
                    <div className="flex gap-2 mt-5">
                      <button onClick={() => setShowAddTask(false)} className="flex-1 px-4 py-2 text-sm text-slate-600 bg-slate-100 rounded-xl hover:bg-slate-200">取消</button>
                      <button onClick={handleAddTask} disabled={!addTaskRoom} className="flex-1 px-4 py-2 text-sm font-medium text-white bg-amber-500 rounded-xl hover:bg-amber-600 disabled:opacity-40">提交</button>
                    </div>
                  </div>
                </div>
              )}
            </div>

            {/* Footer */}
            <div className="flex-shrink-0 border-t border-slate-100 p-4 bg-slate-50/50 rounded-b-2xl">
              <div className="flex justify-between items-center">
                <div className="text-xs text-slate-400">
                  今日已完成 {hkTasks.filter(t => t.status === 'inspected').length} 间 · 清洁人员 {new Set(hkTasks.filter(t => t.assignee).map(t => t.assignee)).size} 人
                </div>
                <button onClick={() => setHousekeepingOpen(false)} className="px-6 py-2.5 text-sm text-slate-600 hover:text-slate-800 bg-white border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors">
                  关闭
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Success Toasts */}
      {checkinSuccess && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[80] flex items-center gap-2 px-6 py-3 bg-emerald-500 text-white rounded-xl shadow-lg animate-bounce">
          <CheckCircle2 className="w-5 h-5" /><span className="font-medium">入住办理成功</span>
        </div>
      )}
      {checkoutSuccess && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-[80] flex items-center gap-2 px-6 py-3 bg-blue-500 text-white rounded-xl shadow-lg animate-bounce">
          <CheckCircle2 className="w-5 h-5" /><span className="font-medium">退房办理成功</span>
        </div>
      )}
    </QuickActionContext.Provider>
  );
}
