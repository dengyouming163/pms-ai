'use client';

import { useEffect, useState, useCallback, Suspense } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { TabBar } from '@/components/tab-bar';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { X, ChevronLeft, ChevronRight, BedDouble, CalendarDays, Users, AlertCircle, Clock, LogIn, LogOut, CheckCircle2, Edit2, Trash2, Upload, Plus, ImageIcon } from 'lucide-react';
import { apiGet, apiPost } from '@/lib/api-client';
import { HousekeepingAlerts } from '@/components/ai/housekeeping-alerts';
import { RoomActionPopover } from '@/components/room-action-popover';
import { useStore } from '@/lib/context/store-context';
import { useHasPermission } from '@/lib/auth/auth-context';
import { Store } from '@/lib/api/types';
import { AssetPicker } from '@/components/promotion/asset-picker';

// --- Types ---
interface DailyRoom {
  id: string; roomTypeId: string; roomTypeName: string; roomNumber: string;
  floor: number; status: 'available' | 'booked' | 'occupied' | 'dirty' | 'maintenance' | 'locked';
  price: number; guest?: string; checkIn?: string; checkOut?: string; orderNo?: string;
}

interface DailySummary {
  total: number; available: number; booked: number; occupied: number;
  dirty: number; maintenance: number; locked: number; occupancyRate: number;
}

interface DailyData {
  date: string; rooms: DailyRoom[]; floors: number[]; summary: DailySummary;
}

interface MonthlyDayStatus {
  date: string; day: number; total: number; available: number; booked: number;
  occupied: number; blocked: number; isWeekend: boolean; isPast: boolean; isToday: boolean;
}

interface MonthlyRoomType {
  roomTypeId: string; roomTypeName: string; totalRooms: number; basePrice: number;
  dailyStatus: MonthlyDayStatus[];
}

interface MonthlyData {
  year: number; month: number; daysInMonth: number; roomTypes: MonthlyRoomType[];
  monthSummary: {
    totalRooms: number; todayOccupied: number; todayBooked: number;
    todayAvailable: number; todayOccupancyRate: number; avgOccupancyRate: number;
  };
}

// --- Constants ---
const tabs = [
  { key: 'chart', label: '房态图' },
  { key: 'daily', label: '日房态' },
  { key: 'monthly', label: '月房态' },
  { key: 'roomTypes', label: '房型管理' },
  { key: 'inventory', label: '库存管理' },
];

const roomStatusConfig: Record<string, { label: string; type: 'success' | 'info' | 'warning' | 'danger' | 'default'; bg: string; border: string; text: string }> = {
  available: { label: '空闲', type: 'success', bg: 'bg-emerald-50', border: 'border-emerald-300', text: 'text-emerald-700' },
  booked: { label: '已预订', type: 'info', bg: 'bg-blue-50', border: 'border-blue-300', text: 'text-blue-700' },
  occupied: { label: '已入住', type: 'warning', bg: 'bg-amber-50', border: 'border-amber-300', text: 'text-amber-700' },
  dirty: { label: '脏房', type: 'danger', bg: 'bg-orange-50', border: 'border-orange-300', text: 'text-orange-700' },
  maintenance: { label: '维修', type: 'danger', bg: 'bg-red-50', border: 'border-red-300', text: 'text-red-700' },
  locked: { label: '锁房', type: 'default', bg: 'bg-slate-100', border: 'border-slate-300', text: 'text-slate-600' },
};

const weekDays = ['一', '二', '三', '四', '五', '六', '日'];

function formatDate(date: Date): string {
  return date.toISOString().split('T')[0];
}

function getOccupancyColor(rate: number): string {
  if (rate >= 90) return 'bg-red-500';
  if (rate >= 70) return 'bg-amber-500';
  if (rate >= 50) return 'bg-emerald-500';
  return 'bg-blue-400';
}

function getOccupancyBg(rate: number): string {
  if (rate >= 90) return 'bg-red-50 border-red-200';
  if (rate >= 70) return 'bg-amber-50 border-amber-200';
  if (rate >= 50) return 'bg-emerald-50 border-emerald-200';
  return 'bg-blue-50 border-blue-200';
}

/* ===== 房型管理类型 ===== */
interface RoomType {
  id: string; storeId: string; name: string; bedType: string;
  area: number; maxGuests: number; facilities: string[];
  images: string[]; roomCount: number; basePrice: number;
}
interface RoomItem {
  id: string; storeId: string; roomTypeId: string; roomTypeName: string;
  roomNumber: string; floor: number; status: string;
  attributes: string[]; price: number;
}

/* ===== 区块标题栏组件 ===== */
function SectionTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      {children}
    </div>
  );
}

// --- Main Component ---
function RoomsContent() {
  const searchParams = useSearchParams();
  const tabParam = searchParams.get('tab');
  const [activeTab, setActiveTab] = useState(tabParam || 'daily');

  // 当URL参数变化时同步Tab
  useEffect(() => {
    if (tabParam) setActiveTab(tabParam);
  }, [tabParam]);

  // Daily state
  const [dailyData, setDailyData] = useState<DailyData | null>(null);
  const [currentDate, setCurrentDate] = useState(formatDate(new Date()));
  const [selectedRoom, setSelectedRoom] = useState<DailyRoom | null>(null);
  const [showRoomModal, setShowRoomModal] = useState(false);

  // Monthly state — 滚动30天
  const [monthlyData, setMonthlyData] = useState<MonthlyData | null>(null);
  const [rangeStart, setRangeStart] = useState(formatDate(new Date()));
  const [hoveredDay, setHoveredDay] = useState<{ roomTypeId: string; day: number } | null>(null);
  // 房态图
  const [chartDates, setChartDates] = useState<string[]>([]);
  const [chartData, setChartData] = useState<Record<string, DailyRoom[]>>({});
  const [chartStart, setChartStart] = useState(formatDate(new Date()));
  const CHART_DAYS = 30;
  // 快捷操作+分组
  const [quickRoom, setQuickRoom] = useState<DailyRoom | null>(null);
  const [quickPos, setQuickPos] = useState({ x: 0, y: 0 });
  const [dailyGroupBy, setDailyGroupBy] = useState<'floor' | 'roomType'>('floor');

  // Check-in/out modal state
  const [showCheckInModal, setShowCheckInModal] = useState(false);
  const [checkInRoom, setCheckInRoom] = useState<DailyRoom | null>(null);
  const [checkInForm, setCheckInForm] = useState({ guestName: '', guestPhone: '', idCard: '', checkInDate: formatDate(new Date()), checkOutDate: '', deposit: '0', paymentStatus: 'unpaid', amountPaid: '0', paymentMethod: 'cash', remark: '' });
  const [showCheckOutModal, setShowCheckOutModal] = useState(false);
  const [checkOutRoom, setCheckOutRoom] = useState<DailyRoom | null>(null);
  const [showCheckInSuccess, setShowCheckInSuccess] = useState(false);
  const [showCheckOutSuccess, setShowCheckOutSuccess] = useState(false);

  // Room operation modal state
  const [showBookModal, setShowBookModal] = useState(false);
  const [bookForm, setBookForm] = useState({ guestName: '', guestPhone: '', checkInDate: '', checkOutDate: '', remark: '' });
  const [showLockModal, setShowLockModal] = useState(false);
  const [lockReason, setLockReason] = useState('');
  const [showExtendModal, setShowExtendModal] = useState(false);
  const [extendDate, setExtendDate] = useState('');
  const [showChangeRoomModal, setShowChangeRoomModal] = useState(false);
  const [targetRoom, setTargetRoom] = useState('');
  const [changeReason, setChangeReason] = useState('');
  const [showCancelBookModal, setShowCancelBookModal] = useState(false);
  const [cancelReason, setCancelReason] = useState('');
  const [showModifyBookModal, setShowModifyBookModal] = useState(false);
  const [modifyForm, setModifyForm] = useState({ guestName: '', guestPhone: '', checkInDate: '', checkOutDate: '', remark: '' });
  const [showMaintenanceModal, setShowMaintenanceModal] = useState(false);
  const [maintenanceReason, setMaintenanceReason] = useState('');
  const [operationSuccess, setOperationSuccess] = useState('');

  // 房型管理 state
  const canEditRooms = useHasPermission('rooms:edit');
  const { currentStore } = useStore();
  const [stores, setStores] = useState<Store[]>([]);
  const [roomTypes, setRoomTypes] = useState<RoomType[]>([]);
  const [roomItems, setRoomItems] = useState<RoomItem[]>([]);
  const [showRoomTypeModal, setShowRoomTypeModal] = useState(false);
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [editingRoomType, setEditingRoomType] = useState<RoomType | null>(null);
  const [roomTypeForm, setRoomTypeForm] = useState({ storeId: '', name: '', bedType: '', area: 28, maxGuests: 2, basePrice: 298, roomCount: 10, facilities: [] as string[], images: [] as string[] });
  const [showRoomManageModal, setShowRoomManageModal] = useState(false);
  const [managingRoomType, setManagingRoomType] = useState<RoomType | null>(null);
  const [showAddRoomModal, setShowAddRoomModal] = useState(false);
  const [addRoomForm, setAddRoomForm] = useState({ roomNumber: '', floor: 1, attributes: [] as string[], price: 0 });
  const [editingRoom, setEditingRoom] = useState<RoomItem | null>(null);
  const [editRoomForm, setEditRoomForm] = useState({ roomNumber: '', floor: 1, status: 'available', attributes: [] as string[], price: 0 });

  const fetchDailyData = useCallback((date: string) => {
    apiGet(`/api/rooms?type=daily&date=${date}`).then(setDailyData);
  }, []);

  const fetchMonthlyData = useCallback((start: string) => {
    apiGet(`/api/rooms?type=monthly&start=${start}&days=30`).then(setMonthlyData);
  }, []);
  const fetchChart = useCallback(() => {
    const s = new Date(chartStart); const ds: string[] = []; const fs: Promise<any>[] = [];
    for (let i = 0; i < CHART_DAYS; i++) { const d = new Date(s); d.setDate(d.getDate() + i); const ds2 = formatDate(d); ds.push(ds2); fs.push(apiGet(`/api/rooms?type=daily&date=${ds2}`)); }
    Promise.all(fs).then(r => { const m: Record<string, DailyRoom[]> = {}; r.forEach((d,i) => { m[ds[i]] = d?.rooms || []; }); setChartDates(ds); setChartData(m); });
  }, [chartStart]);

  useEffect(() => { fetchDailyData(currentDate); }, [currentDate, fetchDailyData]);
  useEffect(() => { fetchMonthlyData(rangeStart); }, [rangeStart, fetchMonthlyData]);
  useEffect(() => { if (activeTab === 'chart') fetchChart(); }, [activeTab, chartStart, fetchChart]);

  // 初始加载房型数据
  useEffect(() => {
    apiGet('/api/stores').then(setStores);
    apiGet('/api/stores?type=roomTypes').then(setRoomTypes);
    apiGet('/api/stores?type=rooms').then(data => setRoomItems(Array.isArray(data) ? data : data.rooms || []));
  }, []);

  // 房型管理 - 打开编辑房型弹窗
  const handleEditRoomType = (rt: RoomType) => {
    setEditingRoomType(rt);
    setRoomTypeForm({ storeId: rt.storeId, name: rt.name, bedType: rt.bedType, area: rt.area, maxGuests: rt.maxGuests, basePrice: rt.basePrice, roomCount: rt.roomCount, facilities: [...rt.facilities], images: [...(rt.images || [])] });
    setShowRoomTypeModal(true);
  };

  // 房型管理 - 打开新增房型弹窗
  const handleAddRoomType = () => {
    setEditingRoomType(null);
    setRoomTypeForm({ storeId: currentStore?.id || '', name: '', bedType: '', area: 28, maxGuests: 2, basePrice: 298, roomCount: 10, facilities: [], images: [] });
    setShowRoomTypeModal(true);
  };

  // 房型管理 - 保存房型
  const handleSaveRoomType = async () => {
    if (!roomTypeForm.name || !roomTypeForm.storeId) return;
    if (editingRoomType) {
      await apiPost('/api/stores', { action: 'editRoomType', id: editingRoomType.id, ...roomTypeForm });
    } else {
      await apiPost('/api/stores', { action: 'addRoomType', ...roomTypeForm });
    }
    setShowRoomTypeModal(false);
    const data = await apiGet('/api/stores?type=roomTypes');
    setRoomTypes(Array.isArray(data) ? data : data.roomTypes || []);
  };

  // 房型管理 - 删除房型
  const handleDeleteRoomType = async (rt: RoomType) => {
    if (!confirm(`确定删除房型「${rt.name}」吗？此操作不可撤销。`)) return;
    try {
      const res = await apiPost('/api/stores', { action: 'deleteRoomType', id: rt.id });
      if (!res.success) {
        toast.error(res.error || '删除失败');
        return;
      }
      toast.success('房型已删除');
      // 刷新房型列表
      const data = await apiGet('/api/stores?type=roomTypes');
      setRoomTypes(Array.isArray(data) ? data : data.roomTypes || []);
    } catch (e: any) {
      toast.error(e.message || '删除失败');
    }
  };

  // 房型管理 - 打开管理房间弹窗
  const handleManageRooms = (rt: RoomType) => {
    setManagingRoomType(rt);
    setShowRoomManageModal(true);
  };

  // 房型管理 - 添加房间
  const handleAddRoom = async () => {
    if (!managingRoomType || !addRoomForm.roomNumber) return;
    const newRoom = {
      storeId: managingRoomType.storeId, roomTypeId: managingRoomType.id,
      roomTypeName: managingRoomType.name, roomNumber: addRoomForm.roomNumber,
      floor: addRoomForm.floor, status: 'available', price: addRoomForm.price || managingRoomType.basePrice,
    };
    await apiPost('/api/stores', { action: 'addRoom', ...newRoom });
    setAddRoomForm({ roomNumber: '', floor: 1, attributes: [], price: 0 });
    setShowAddRoomModal(false);
    const [roomsData, roomTypesData] = await Promise.all([
      apiGet('/api/stores?type=rooms&storeId=' + managingRoomType.storeId),
      apiGet('/api/stores?type=roomTypes' + ('')),
    ]);
    setRoomItems(Array.isArray(roomsData) ? roomsData : roomsData.rooms || []);
    setRoomTypes(Array.isArray(roomTypesData) ? roomTypesData : roomTypesData.roomTypes || []);
  };

  // 房型管理 - 编辑房间
  const handleSaveEditRoom = async () => {
    if (!editingRoom) return;
    await apiPost('/api/stores', { action: 'editRoom', id: editingRoom.id, ...editRoomForm });
    setEditingRoom(null);
    if (managingRoomType) {
      const data = await apiGet('/api/stores?type=rooms&storeId=' + managingRoomType.storeId);
      setRoomItems(Array.isArray(data) ? data : data.rooms || []);
    }
  };

  // 房型管理 - 删除房间
  const handleDeleteRoom = async (roomId: string) => {
    await apiPost('/api/stores', { action: 'deleteRoom', id: roomId });
    if (managingRoomType) {
      const [roomsData, roomTypesData] = await Promise.all([
        apiGet('/api/stores?type=rooms&storeId=' + managingRoomType.storeId),
        apiGet('/api/stores?type=roomTypes' + ('')),
      ]);
      setRoomItems(Array.isArray(roomsData) ? roomsData : roomsData.rooms || []);
      setRoomTypes(Array.isArray(roomTypesData) ? roomTypesData : roomTypesData.roomTypes || []);
    }
  };

  const navigateDate = (offset: number) => {
    const d = new Date(currentDate);
    d.setDate(d.getDate() + offset);
    setCurrentDate(formatDate(d));
  };

  const goToday = () => setCurrentDate(formatDate(new Date()));

  const navigateMonth = (offset: number) => {
    const d = new Date(rangeStart); d.setDate(d.getDate() + offset * 7); setRangeStart(formatDate(d));
  };

  // 快捷操作
  const handleQuickAction = (room: DailyRoom, e: React.MouseEvent) => { e.stopPropagation(); setQuickRoom(room); setQuickPos({ x: e.clientX, y: e.clientY }); };
  const handleQuickOp = (action: string) => {
    if (!quickRoom) return; const r = quickRoom; setQuickRoom(null);
    if (action === 'detail') { setSelectedRoom(r); setShowRoomModal(true); return; }
    if (action === 'checkin') { setSelectedRoom(r); handleOpenCheckIn(r); return; }
    if (action === 'book') { setSelectedRoom(r); handleOpenBook(r); return; }
    if (action === 'lock') { setSelectedRoom(r); setShowLockModal(true); return; }
    if (action === 'dirty') { roomApi('markDirty', { roomId: r.id }).then(() => { fetchDailyData(currentDate); if (activeTab === 'chart') fetchChart(); }); return; }
    if (action === 'clean') { roomApi('markClean', { roomId: r.id }).then(() => { fetchDailyData(currentDate); if (activeTab === 'chart') fetchChart(); }); return; }
    if (action === 'unlock') { roomApi('unlock', { roomId: r.id }).then(() => { fetchDailyData(currentDate); if (activeTab === 'chart') fetchChart(); }); return; }
    if (action === 'checkout') { handleOpenCheckOut(r); return; }
    if (action === 'extend') { handleOpenExtend(r); return; }
    if (action === 'change') { setSelectedRoom(r); setShowChangeRoomModal(true); return; }
    if (action === 'cancel') { setSelectedRoom(r); setShowCancelBookModal(true); return; }
    if (action === 'modify') { setSelectedRoom(r); handleOpenModifyBook(r); return; }
    if (action === 'maintenance') { setSelectedRoom(r); setShowMaintenanceModal(true); return; }
    if (action === 'restore') { roomApi('restoreAvailable', { roomId: r.id }).then(() => { fetchDailyData(currentDate); if (activeTab === 'chart') fetchChart(); }); return; }
  };

  const isToday = (dateStr: string) => dateStr === formatDate(new Date());

  // API helper: call room operation then refresh data
  const roomApi = async (action: string, params: Record<string, string> = {}) => {
    const data = await apiPost('/api/rooms', { action, ...params });
    if (data.success) {
      fetchDailyData(currentDate); // refresh from server
    }
    return data;
  };

  // Check-in handlers
  const handleOpenCheckIn = (room: DailyRoom) => {
    setCheckInRoom(room);
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
    setCheckInForm({ guestName: '', guestPhone: '', idCard: '', checkInDate: formatDate(new Date()), checkOutDate: formatDate(dayAfter), deposit: '0', paymentStatus: 'unpaid', amountPaid: '0', paymentMethod: 'cash', remark: '' });
    setShowCheckInModal(true);
  };

  const handleConfirmCheckIn = async () => {
    if (!checkInRoom || !checkInForm.guestName || !checkInForm.guestPhone) return;
    await roomApi('checkIn', {
      roomId: checkInRoom.id,
      guestName: checkInForm.guestName,
      guestPhone: checkInForm.guestPhone,
      checkInDate: checkInForm.checkInDate,
      checkOutDate: checkInForm.checkOutDate,
      deposit: Number(checkInForm.deposit) || 0 as any,
      paymentStatus: checkInForm.paymentStatus,
      amountPaid: Number(checkInForm.amountPaid) || 0 as any,
      paymentMethod: checkInForm.paymentMethod,
      source: 'walk_in',
      remark: checkInForm.remark,
    });
    setShowCheckInModal(false);
    setShowRoomModal(false);
    setShowCheckInSuccess(true);
    setTimeout(() => setShowCheckInSuccess(false), 2000);
  };

  // Check-out handlers
  const handleOpenCheckOut = (room: DailyRoom) => {
    setCheckOutRoom(room);
    setShowCheckOutModal(true);
  };

  const handleConfirmCheckOut = async () => {
    if (!checkOutRoom) return;
    await roomApi('checkOut', { roomId: checkOutRoom.id });
    setShowCheckOutModal(false);
    setShowRoomModal(false);
    setShowCheckOutSuccess(true);
    setTimeout(() => setShowCheckOutSuccess(false), 2000);
  };

  // Book room
  const handleOpenBook = (room: DailyRoom) => {
    const tomorrow = new Date(); tomorrow.setDate(tomorrow.getDate() + 1);
    const dayAfter = new Date(); dayAfter.setDate(dayAfter.getDate() + 2);
    setBookForm({ guestName: '', guestPhone: '', checkInDate: formatDate(tomorrow), checkOutDate: formatDate(dayAfter), remark: '' });
    setShowBookModal(true);
  };
  const handleConfirmBook = async () => {
    if (!selectedRoom || !bookForm.guestName || !bookForm.guestPhone) return;
    await roomApi('book', {
      roomId: selectedRoom.id,
      guestName: bookForm.guestName,
      guestPhone: bookForm.guestPhone,
      checkInDate: bookForm.checkInDate,
      checkOutDate: bookForm.checkOutDate,
      remark: bookForm.remark,
    });
    setShowBookModal(false);
    setShowRoomModal(false);
    setOperationSuccess('预订成功');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Lock room
  const handleConfirmLock = async () => {
    if (!selectedRoom) return;
    await roomApi('lock', { roomId: selectedRoom.id, reason: lockReason });
    setShowLockModal(false);
    setShowRoomModal(false);
    setLockReason('');
    setOperationSuccess('锁房成功');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Extend stay
  const handleOpenExtend = (room: DailyRoom) => {
    setExtendDate(room.checkOut || '');
    setShowExtendModal(true);
  };
  const handleConfirmExtend = async () => {
    if (!selectedRoom || !extendDate) return;
    await roomApi('extendStay', { roomId: selectedRoom.id, checkOutDate: extendDate });
    setShowExtendModal(false);
    setShowRoomModal(false);
    setOperationSuccess('续住成功');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Change room
  const handleConfirmChangeRoom = async () => {
    if (!selectedRoom || !targetRoom) return;
    const targetRoomData = dailyData?.rooms.find((r) => r.id === targetRoom);
    if (!targetRoomData || targetRoomData.status !== 'available') return;
    await roomApi('changeRoom', { fromRoomId: selectedRoom.id, toRoomId: targetRoom, reason: changeReason });
    setShowChangeRoomModal(false);
    setShowRoomModal(false);
    setTargetRoom('');
    setChangeReason('');
    setOperationSuccess('换房成功');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Cancel booking
  const handleConfirmCancelBook = async () => {
    if (!selectedRoom) return;
    await roomApi('cancelBook', { roomId: selectedRoom.id, reason: cancelReason });
    setShowCancelBookModal(false);
    setShowRoomModal(false);
    setCancelReason('');
    setOperationSuccess('预订已取消');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Modify booking
  const handleOpenModifyBook = (room: DailyRoom) => {
    setModifyForm({ guestName: room.guest || '', guestPhone: '', checkInDate: room.checkIn || '', checkOutDate: room.checkOut || '', remark: '' });
    setShowModifyBookModal(true);
  };
  const handleConfirmModifyBook = async () => {
    if (!selectedRoom) return;
    await roomApi('modifyBook', {
      roomId: selectedRoom.id,
      guestName: modifyForm.guestName,
      guestPhone: modifyForm.guestPhone,
      checkInDate: modifyForm.checkInDate,
      checkOutDate: modifyForm.checkOutDate,
    });
    setShowModifyBookModal(false);
    setShowRoomModal(false);
    setOperationSuccess('修改成功');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Mark clean
  const handleMarkClean = async () => {
    if (!selectedRoom) return;
    await roomApi('markClean', { roomId: selectedRoom.id });
    setShowRoomModal(false);
    setOperationSuccess('已标记为干净');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Maintenance
  const handleConfirmMaintenance = async () => {
    if (!selectedRoom) return;
    await roomApi('setMaintenance', { roomId: selectedRoom.id, reason: maintenanceReason });
    setShowMaintenanceModal(false);
    setShowRoomModal(false);
    setMaintenanceReason('');
    setOperationSuccess('已标记为维修');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Restore available
  const handleRestoreAvailable = async () => {
    if (!selectedRoom) return;
    await roomApi('restoreAvailable', { roomId: selectedRoom.id });
    setShowRoomModal(false);
    setOperationSuccess('已恢复为可用');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Unlock
  const handleUnlock = async () => {
    if (!selectedRoom) return;
    await roomApi('unlock', { roomId: selectedRoom.id });
    setShowRoomModal(false);
    setOperationSuccess('已解锁');
    setTimeout(() => setOperationSuccess(''), 2000);
  };

  // Get first day of range offset (0=Mon, 6=Sun)
  const getMonthStartOffset = () => {
    const firstDay = new Date(rangeStart).getDay();
    return firstDay === 0 ? 6 : firstDay - 1;
  };

  const formatDisplayDate = (dateStr: string) => {
    const d = new Date(dateStr);
    const weekDay = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${weekDay}`;
  };

  return (
    <div className="space-y-5">
      <PageHeader title="房态管理" subtitle="实时监控房间状态，日/月双视图全景掌控" icon={<BedDouble className="w-5 h-5" />} />

      <HousekeepingAlerts alerts={[]} />

      <div className="flex items-center justify-between">
        <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />
        {activeTab === 'roomTypes' && (
          <button onClick={handleAddRoomType} className="px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors flex items-center gap-1.5"><Plus className="w-4 h-4" />新增房型</button>
        )}
      </div>

      {/* ============ ROOM CHART (房态图) ============ */}
      {activeTab === 'chart' && chartDates.length > 0 && (
        <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-auto">
          <div className="sticky left-0 flex items-center justify-between px-4 py-2 border-b bg-slate-50">
            <button onClick={() => { const d = new Date(chartStart); d.setDate(d.getDate() - 30); setChartStart(formatDate(d)); }} className="px-3 py-1 text-xs bg-white border rounded-lg hover:bg-slate-100"><ChevronLeft className="w-3 h-3 inline mr-1"/>前30天</button>
            <button onClick={() => setChartStart(formatDate(new Date()))} className="px-3 py-1 text-xs bg-emerald-50 text-emerald-600 rounded-lg hover:bg-emerald-100">今天</button>
            <button onClick={() => { const d = new Date(chartStart); d.setDate(d.getDate() + 30); setChartStart(formatDate(d)); }} className="px-3 py-1 text-xs bg-white border rounded-lg hover:bg-slate-100">后30天<ChevronRight className="w-3 h-3 inline ml-1"/></button>
          </div>
          <div className="min-w-[800px]">
            <div className="sticky top-0 z-10 bg-white border-b border-slate-200 flex"><div className="w-24 flex-shrink-0 px-3 py-2 text-xs font-medium text-slate-500 bg-slate-50 border-r">房号</div>
              {chartDates.map(date => { const d2 = new Date(date); const wd = ['日','一','二','三','四','五','六'][d2.getDay()]; const we = d2.getDay()===0||d2.getDay()===6; const it = date===formatDate(new Date()); return (<div key={date} className={`flex-1 min-w-[72px] text-center py-2 border-r ${we?'bg-red-50/30':''} ${it?'ring-2 ring-emerald-400 ring-inset':''}`}><p className="text-[11px] font-medium text-slate-600">{date.slice(5)}</p><p className={`text-[10px] ${we?'text-red-400':'text-slate-400'}`}>{wd}</p></div>); })}
            </div>
            {(() => { const rns = [...new Set(Object.values(chartData).flatMap(rs => rs.map(r => r.roomNumber)).filter(Boolean))].sort(); return rns.map(rn => (<div key={rn} className="flex border-b border-slate-100 hover:bg-slate-50/30"><div className="w-24 flex-shrink-0 px-3 py-2 flex items-center border-r bg-slate-50/50"><span className="text-xs font-bold text-slate-700">{rn}</span></div>{chartDates.map(date => { const room = chartData[date]?.find(r => r.roomNumber === rn); const st = room?.status || 'available'; const cfg = roomStatusConfig[st] || roomStatusConfig.available; return (<div key={date} className={`flex-1 min-w-[72px] h-16 border-r flex items-center justify-center cursor-pointer ${cfg.bg} hover:ring-2 hover:ring-slate-400 hover:z-10 transition-all`} onClick={(e) => { if (room) handleQuickAction(room, e); }}>{room?.guest ? <span className="text-[9px] text-slate-600 truncate px-1">{room.guest.slice(0,3)}</span> : <div className={`w-2 h-2 rounded-full ${st==='available'?'bg-emerald-400':st==='occupied'?'bg-amber-400':st==='booked'?'bg-blue-400':'bg-slate-300'}`}/>}</div>); })}</div>)); })()}
            <div className="flex items-center gap-4 px-4 py-2 border-t bg-slate-50 text-xs text-slate-500">{Object.entries(roomStatusConfig).map(([k,v]) => (<span key={k} className="flex items-center gap-1"><span className={`w-3 h-3 rounded ${v.bg} border ${v.border}`}/>{v.label}</span>))}<span className="ml-auto text-slate-400">点击格子操作房间</span></div>
          </div>
        </div>
      )}

      {/* ============ DAILY ROOM STATUS ============ */}
      {activeTab === 'daily' && dailyData && (
        <div className="space-y-4">
          {/* Summary cards */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-emerald-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{dailyData.summary.occupancyRate}%</p><p className="text-xs text-slate-500">出租率</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center"><Users className="w-5 h-5 text-blue-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{dailyData.summary.occupied}</p><p className="text-xs text-slate-500">已入住</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center"><Clock className="w-5 h-5 text-amber-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{dailyData.summary.booked}</p><p className="text-xs text-slate-500">已预订</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-emerald-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{dailyData.summary.available}</p><p className="text-xs text-slate-500">可售房</p></div>
            </div>
          </div>

          {/* Legend + Date Navigation */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-5">
                {Object.entries(roomStatusConfig).map(([key, config]) => (
                  <div key={key} className="flex items-center gap-1.5">
                    <div className={`w-3.5 h-3.5 rounded ${config.bg} border ${config.border}`} />
                    <span className="text-xs text-slate-600">{config.label}</span>
                    <span className="text-xs font-medium text-slate-800">({dailyData.summary[key as keyof DailySummary] || 0})</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center justify-center gap-4 py-2">
              <button onClick={() => navigateDate(-1)} className="p-2 hover:bg-slate-100 rounded-lg transition-colors"><ChevronLeft className="w-5 h-5 text-slate-400" /></button>
              <button onClick={goToday} className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-medium hover:bg-emerald-100 transition-colors">今天</button>
              <span className="text-base font-semibold text-slate-800 min-w-[200px] text-center">
                {formatDisplayDate(dailyData.date)}
                {isToday(dailyData.date) && <span className="ml-2 text-xs text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">今日</span>}
              </span>
              <button onClick={() => navigateDate(1)} className="p-2 hover:bg-slate-100 rounded-lg transition-colors"><ChevronRight className="w-5 h-5 text-slate-400" /></button>
            </div>
          </div>

          {/* 分组切换 */}
          <div className="flex items-center gap-2">
            <span className="text-xs text-slate-500">分组：</span>
            <button onClick={() => setDailyGroupBy('floor')} className={`px-3 py-1 text-xs rounded-lg ${dailyGroupBy==='floor'?'bg-emerald-100 text-emerald-700 font-medium':'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>按楼层</button>
            <button onClick={() => setDailyGroupBy('roomType')} className={`px-3 py-1 text-xs rounded-lg ${dailyGroupBy==='roomType'?'bg-emerald-100 text-emerald-700 font-medium':'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>按房型</button>
          </div>

          {/* Room grid */}
          {dailyGroupBy === 'floor' ? dailyData.floors.map((floor) => {
            const fRooms = dailyData.rooms.filter(r => r.floor === floor);
            const fOcc = fRooms.filter(r => r.status === 'occupied' || r.status === 'booked').length;
            const fRate = Math.round(fOcc / fRooms.length * 100);
            return (<div key={floor} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5"><div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-slate-700">{floor}楼</h3><div className="flex items-center gap-3"><span className="text-xs text-slate-500">{fRooms.length}间</span><div className="flex items-center gap-1.5"><div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${getOccupancyColor(fRate)}`} style={{width:`${fRate}%`}}/></div><span className="text-xs font-medium text-slate-600">{fRate}%</span></div></div></div><div className="grid grid-cols-10 gap-2">{fRooms.map(room => { const cfg = roomStatusConfig[room.status] || roomStatusConfig.available; return (<div key={room.id} className={`border ${cfg.border} ${cfg.bg} rounded-xl p-2 text-center cursor-pointer hover:shadow-md hover:scale-[1.03] transition-all relative`} onClick={(e) => handleQuickAction(room, e)}><p className="text-sm font-bold text-slate-800">{room.roomNumber}</p><p className="text-[10px] text-slate-500 mt-0.5 truncate">{room.roomTypeName}</p><StatusBadge label={cfg.label} type={cfg.type} className="mt-1 !text-[10px] !px-1 !py-0"/>{room.guest && <p className="text-[10px] text-slate-400 mt-0.5 truncate">{room.guest}</p>}</div>); })}</div></div>);
          }) : (() => { const tns = [...new Set(dailyData.rooms.map(r => r.roomTypeName).filter(Boolean))]; return tns.map(tn => { const tRooms = dailyData.rooms.filter(r => r.roomTypeName === tn); const tOcc = tRooms.filter(r => r.status === 'occupied' || r.status === 'booked').length; const tRate = Math.round(tOcc / tRooms.length * 100); return (<div key={tn} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5"><div className="flex items-center justify-between mb-3"><h3 className="text-sm font-semibold text-slate-700">{tn}</h3><div className="flex items-center gap-3"><span className="text-xs text-slate-500">{tRooms.length}间</span><div className="flex items-center gap-1.5"><div className="w-16 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full rounded-full ${getOccupancyColor(tRate)}`} style={{width:`${tRate}%`}}/></div><span className="text-xs font-medium text-slate-600">{tRate}%</span></div></div></div><div className="grid grid-cols-10 gap-2">{tRooms.map(room => { const cfg = roomStatusConfig[room.status] || roomStatusConfig.available; return (<div key={room.id} className={`border ${cfg.border} ${cfg.bg} rounded-xl p-2 text-center cursor-pointer hover:shadow-md hover:scale-[1.03] transition-all relative`} onClick={(e) => handleQuickAction(room, e)}><p className="text-sm font-bold text-slate-800">{room.roomNumber}</p><StatusBadge label={cfg.label} type={cfg.type} className="mt-1 !text-[10px] !px-1 !py-0"/>{room.guest && <p className="text-[10px] text-slate-400 mt-0.5 truncate">{room.guest}</p>}</div>); })}</div></div>); }); })()}

          {/* Status distribution bar */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4">
            <h4 className="text-sm font-semibold text-slate-700 mb-3">房态分布</h4>
            <div className="flex h-6 rounded-full overflow-hidden">
              {Object.entries(roomStatusConfig).map(([key, config]) => {
                const count = dailyData.summary[key as keyof DailySummary] as number || 0;
                if (count === 0) return null;
                return (
                  <div key={key} className={`${config.bg} border-r border-white last:border-r-0 flex items-center justify-center`} style={{ width: `${count / dailyData.summary.total * 100}%` }}>
                    <span className="text-[10px] font-medium text-slate-700">{count}</span>
                  </div>
                );
              })}
            </div>
            <div className="flex justify-between mt-2 text-xs text-slate-500">
              <span>0</span>
              <span>共 {dailyData.summary.total} 间</span>
            </div>
          </div>
        </div>
      )}

      {/* ============ MONTHLY ROOM STATUS ============ */}
      {activeTab === 'monthly' && monthlyData && (
        <div className="space-y-4">
          {/* Month summary cards */}
          <div className="grid grid-cols-4 gap-3">
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center"><CalendarDays className="w-5 h-5 text-emerald-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{monthlyData.monthSummary.avgOccupancyRate}%</p><p className="text-xs text-slate-500">月均出租率</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center"><Users className="w-5 h-5 text-amber-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{monthlyData.monthSummary.todayOccupied}</p><p className="text-xs text-slate-500">今日在住</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center"><Clock className="w-5 h-5 text-blue-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{monthlyData.monthSummary.todayBooked}</p><p className="text-xs text-slate-500">今日预订</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200 p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-emerald-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{monthlyData.monthSummary.todayAvailable}</p><p className="text-xs text-slate-500">今日可售</p></div>
            </div>
          </div>

          {/* Month navigation — 30天滚动 */}
          <div className="bg-white rounded-2xl border border-slate-200 shadow-sm p-4 flex items-center justify-center gap-4">
            <button onClick={() => navigateMonth(-1)} className="p-2 hover:bg-slate-100 rounded-lg"><ChevronLeft className="w-5 h-5 text-slate-400"/></button>
            <button onClick={() => setRangeStart(formatDate(new Date()))} className="px-3 py-1.5 bg-emerald-50 text-emerald-600 rounded-lg text-xs font-medium hover:bg-emerald-100">今天</button>
            <span className="text-lg font-semibold text-slate-800 min-w-[280px] text-center">{rangeStart} ~ {(() => { const d = new Date(rangeStart); d.setDate(d.getDate() + 29); return formatDate(d); })()}</span>
            <button onClick={() => navigateMonth(1)} className="p-2 hover:bg-slate-100 rounded-lg"><ChevronRight className="w-5 h-5 text-slate-400"/></button>
          </div>

          {/* Monthly calendar grid per room type */}
          {monthlyData.roomTypes.map((rt) => (
            <div key={rt.roomTypeId} className="bg-white rounded-2xl border border-slate-200 shadow-sm p-5">
              {/* Room type header */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-lg flex items-center justify-center text-white text-xs font-bold">
                    {rt.roomTypeName.charAt(0)}
                  </div>
                  <div>
                    <h4 className="text-sm font-semibold text-slate-800">{rt.roomTypeName}</h4>
                    <p className="text-xs text-slate-500">共{rt.totalRooms}间 · 基础价¥{rt.basePrice}</p>
                  </div>
                </div>
                <div className="flex items-center gap-4 text-xs text-slate-500">
                  <span className="flex items-center gap-1"><span className="w-3 h-3 bg-emerald-100 rounded border border-emerald-300" />充裕</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 bg-amber-100 rounded border border-amber-300" />紧张</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 bg-red-100 rounded border border-red-300" />满房</span>
                  <span className="flex items-center gap-1"><span className="w-3 h-3 bg-slate-50 rounded border border-slate-200" />过去</span>
                </div>
              </div>

              {/* Weekday headers */}
              <div className="grid grid-cols-7 gap-1 mb-1">
                {weekDays.map((wd, i) => (
                  <div key={i} className={`text-center text-xs font-medium py-1 ${i >= 5 ? 'text-red-400' : 'text-slate-400'}`}>
                    {wd}
                  </div>
                ))}
              </div>

              {/* Calendar grid */}
              <div className="grid grid-cols-7 gap-1">
                {/* Empty cells for offset */}
                {Array.from({ length: getMonthStartOffset() }, (_, i) => (
                  <div key={`empty-${i}`} className="h-16" />
                ))}
                {/* Day cells */}
                {rt.dailyStatus.map((day) => {
                  const occupancyRate = Math.round((day.occupied + day.booked) / day.total * 100);
                  const isHovered = hoveredDay?.roomTypeId === rt.roomTypeId && hoveredDay?.day === day.day;
                  return (
                    <div
                      key={day.date}
                      className={`h-16 rounded-lg border p-1.5 cursor-pointer transition-all relative ${day.isPast ? 'bg-slate-50/50 border-slate-100' : day.isToday ? 'ring-2 ring-emerald-500 ring-offset-1' : 'hover:shadow-md'} ${!day.isPast ? getOccupancyBg(occupancyRate) : ''}`}
                      onMouseEnter={() => setHoveredDay({ roomTypeId: rt.roomTypeId, day: day.day })}
                      onMouseLeave={() => setHoveredDay(null)}
                      onClick={() => {
                        if (!day.isPast) {
                          setCurrentDate(day.date);
                          setActiveTab('daily');
                        }
                      }}
                    >
                      <div className="flex items-center justify-between">
                        <span className={`text-xs font-medium ${day.isToday ? 'text-emerald-600' : day.isWeekend ? 'text-red-500' : day.isPast ? 'text-slate-400' : 'text-slate-700'}`}>
                          {day.date.slice(5)}
                        </span>
                        {!day.isPast && (
                          <span className={`text-[10px] font-bold ${occupancyRate >= 90 ? 'text-red-600' : occupancyRate >= 70 ? 'text-amber-600' : 'text-emerald-600'}`}>
                            {occupancyRate}%
                          </span>
                        )}
                      </div>
                      {!day.isPast && (
                        <div className="mt-0.5">
                          <p className="text-[10px] text-slate-500 leading-tight">余{day.available}</p>
                        </div>
                      )}
                      {/* Hover tooltip */}
                      {isHovered && !day.isPast && (
                        <div className="absolute z-10 left-1/2 -translate-x-1/2 top-full mt-1 bg-slate-800 text-white text-xs rounded-lg px-3 py-2 whitespace-nowrap shadow-lg">
                          <p className="font-medium">{day.date}</p>
                          <p>总房数: {day.total} · 可售: {day.available}</p>
                          <p>在住: {day.occupied} · 预订: {day.booked} · 锁定: {day.blocked}</p>
                          <div className="absolute -top-1 left-1/2 -translate-x-1/2 w-2 h-2 bg-slate-800 rotate-45" />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ))}
        </div>
      )}

      {/* ============ 房型管理 Tab ============ */}
      {activeTab === 'roomTypes' && (
        <div>
          <SectionTitle title="房型列表" />

          {roomTypes.length === 0 ? (
            <div className="bg-white rounded-2xl border border-slate-200/80 p-12 text-center">
              <BedDouble className="w-12 h-12 text-slate-300 mx-auto mb-3" />
              <p className="text-slate-500">该门店暂无房型数据</p>
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-4">
              {roomTypes.map(rt => {
                const storeName = stores.find(s => s.id === rt.storeId)?.name || '';
                const rtRooms = roomItems.filter(r => r.roomTypeId === rt.id);
                const availableCount = rtRooms.filter(r => r.status === 'available').length;
                return (
                  <div key={rt.id} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                    {/* 房型图片区 */}
                    <div className="h-28 bg-gradient-to-br from-emerald-400 to-teal-500 flex items-center justify-center relative">
                      <BedDouble className="w-10 h-10 text-white/30" />
                      <span className="absolute top-3 left-3 px-2 py-1 bg-white/90 rounded-lg text-xs font-medium text-slate-700">{storeName}</span>
                      <span className="absolute top-3 right-3 px-2 py-1 bg-white/90 rounded-lg text-xs text-slate-500">📷 {rt.images?.length || 0}张</span>
                    </div>
                    <div className="p-4">
                      <div className="flex items-start justify-between">
                        <div>
                          <h4 className="font-semibold text-slate-800">{rt.name}</h4>
                          <p className="text-sm text-slate-500 mt-0.5">{rt.bedType} · {rt.area}m² · 最多{rt.maxGuests}人</p>
                        </div>
                        <div className="text-right">
                          <p className="text-xl font-bold text-emerald-600">¥{rt.basePrice}</p>
                          <p className="text-xs text-slate-400">基准价/晚</p>
                        </div>
                      </div>
                      {/* 设施标签 */}
                      <div className="flex flex-wrap gap-1.5 mt-3">
                        {rt.facilities.map(f => (
                          <span key={f} className="px-2 py-0.5 bg-slate-50 rounded-md text-xs text-slate-600">{f}</span>
                        ))}
                      </div>
                      {/* 房间统计 */}
                      <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                        <div className="flex items-center gap-3 text-xs text-slate-500">
                          <span>共{rtRooms.length}间</span>
                          <span className="text-emerald-600">空闲{availableCount}</span>
                          <span>在住{rtRooms.filter(r => r.status === 'occupied').length}</span>
                        </div>
                        <div className="flex gap-1">
                          <button onClick={() => handleEditRoomType(rt)} className="px-2.5 py-1 text-xs text-emerald-600 bg-emerald-50 rounded-lg hover:bg-emerald-100 transition-colors">编辑</button>
                          <button onClick={() => handleManageRooms(rt)} className="px-2.5 py-1 text-xs text-slate-500 bg-slate-50 rounded-lg hover:bg-slate-100 transition-colors">管理房间</button>
                          <button
                            type="button"
                            onClick={() => handleDeleteRoomType(rt)}
                            className="flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded-md transition-colors"
                          >
                            <Trash2 className="w-3 h-3" />
                            删除
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* ============ ROOM DETAIL MODAL ============ */}
      {showRoomModal && selectedRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowRoomModal(false)}>
          <div className="bg-white rounded-2xl w-[420px] shadow-xl h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            {/* Header */}
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className={`w-10 h-10 ${roomStatusConfig[selectedRoom.status]?.bg} rounded-xl flex items-center justify-center`}>
                  <BedDouble className={`w-5 h-5 ${roomStatusConfig[selectedRoom.status]?.text}`} />
                </div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">{selectedRoom.roomNumber}</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.roomTypeName}</p>
                </div>
              </div>
              <button onClick={() => setShowRoomModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>

            {/* Details - scrollable */}
            <div className="p-5 space-y-3 flex-1 overflow-y-auto min-h-0">
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">状态</span>
                <StatusBadge label={roomStatusConfig[selectedRoom.status]?.label || selectedRoom.status} type={roomStatusConfig[selectedRoom.status]?.type || 'default'} />
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">楼层</span>
                <span className="text-sm font-medium text-slate-800">{selectedRoom.floor}楼</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-slate-500">价格</span>
                <span className="text-sm font-medium text-emerald-600">¥{selectedRoom.price}/晚</span>
              </div>

              {selectedRoom.guest && (
                <>
                  <div className="border-t border-slate-100 pt-3 mt-3">
                    <p className="text-xs font-medium text-slate-400 mb-2 uppercase tracking-wider">入住信息</p>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-sm text-slate-500">客人</span>
                    <span className="text-sm font-medium text-slate-800">{selectedRoom.guest}</span>
                  </div>
                  {selectedRoom.orderNo && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-500">订单号</span>
                      <span className="text-sm font-mono text-slate-700">{selectedRoom.orderNo}</span>
                    </div>
                  )}
                  {selectedRoom.checkIn && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-500">入住</span>
                      <span className="text-sm text-slate-700">{selectedRoom.checkIn}</span>
                    </div>
                  )}
                  {selectedRoom.checkOut && (
                    <div className="flex justify-between items-center">
                      <span className="text-sm text-slate-500">离店</span>
                      <span className="text-sm text-slate-700">{selectedRoom.checkOut}</span>
                    </div>
                  )}
                </>
              )}
            </div>

            {/* Actions - fixed bottom */}
            <div className="grid grid-cols-3 gap-2 p-5 border-t border-slate-100 flex-shrink-0">
              {selectedRoom.status === 'available' && (
                <>
                  <button onClick={() => handleOpenCheckIn(selectedRoom)} className="px-3 py-2 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 transition-colors">入住</button>
                  <button onClick={() => handleOpenBook(selectedRoom)} className="px-3 py-2 bg-blue-50 text-blue-600 rounded-xl text-sm font-medium hover:bg-blue-100 transition-colors">预订</button>
                  <button onClick={() => setShowLockModal(true)} className="px-3 py-2 bg-slate-50 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-100 transition-colors">锁房</button>
                </>
              )}
              {selectedRoom.status === 'occupied' && (
                <>
                  <button onClick={() => handleOpenCheckOut(selectedRoom)} className="px-3 py-2 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 transition-colors">退房</button>
                  <button onClick={() => handleOpenExtend(selectedRoom)} className="px-3 py-2 bg-amber-50 text-amber-600 rounded-xl text-sm font-medium hover:bg-amber-100 transition-colors">续住</button>
                  <button onClick={() => setShowChangeRoomModal(true)} className="px-3 py-2 bg-blue-50 text-blue-600 rounded-xl text-sm font-medium hover:bg-blue-100 transition-colors">换房</button>
                </>
              )}
              {selectedRoom.status === 'booked' && (
                <>
                  <button onClick={() => handleOpenCheckIn(selectedRoom)} className="px-3 py-2 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 transition-colors">办理入住</button>
                  <button onClick={() => setShowCancelBookModal(true)} className="px-3 py-2 bg-red-50 text-red-600 rounded-xl text-sm font-medium hover:bg-red-100 transition-colors">取消预订</button>
                  <button onClick={() => handleOpenModifyBook(selectedRoom)} className="px-3 py-2 bg-slate-50 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-100 transition-colors">修改</button>
                </>
              )}
              {selectedRoom.status === 'dirty' && (
                <>
                  <button onClick={handleMarkClean} className="px-3 py-2 bg-emerald-50 text-emerald-600 rounded-xl text-sm font-medium hover:bg-emerald-100 transition-colors">标记干净</button>
                  <button onClick={() => setShowLockModal(true)} className="px-3 py-2 bg-slate-50 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-100 transition-colors">锁房</button>
                  <button onClick={() => setShowMaintenanceModal(true)} className="px-3 py-2 bg-slate-50 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-100 transition-colors">维修</button>
                </>
              )}
              {selectedRoom.status === 'maintenance' && (
                <>
                  <button onClick={handleRestoreAvailable} className="px-3 py-2 bg-emerald-50 text-emerald-600 rounded-xl text-sm font-medium hover:bg-emerald-100 transition-colors">恢复可用</button>
                  <button onClick={() => setShowLockModal(true)} className="px-3 py-2 bg-slate-50 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-100 transition-colors">锁房</button>
                  <button />
                </>
              )}
              {selectedRoom.status === 'locked' && (
                <>
                  <button onClick={handleUnlock} className="px-3 py-2 bg-emerald-50 text-emerald-600 rounded-xl text-sm font-medium hover:bg-emerald-100 transition-colors">解锁</button>
                  <button onClick={() => setShowMaintenanceModal(true)} className="px-3 py-2 bg-slate-50 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-100 transition-colors">维修</button>
                  <button />
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ========== CHECK-IN MODAL ========== */}
      {showCheckInModal && checkInRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowCheckInModal(false)}>
          <div className="bg-white rounded-2xl w-[520px] shadow-xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-emerald-100 rounded-xl flex items-center justify-center"><LogIn className="w-5 h-5 text-emerald-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">办理入住</h3>
                  <p className="text-xs text-slate-500">{checkInRoom.roomTypeName} - {checkInRoom.roomNumber} · ¥{checkInRoom.price}/晚</p>
                </div>
              </div>
              <button onClick={() => setShowCheckInModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">客人姓名 <span className="text-red-500">*</span></label>
                  <input value={checkInForm.guestName} onChange={(e) => setCheckInForm({ ...checkInForm, guestName: e.target.value })} placeholder="请输入客人姓名" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">手机号 <span className="text-red-500">*</span></label>
                  <input value={checkInForm.guestPhone} onChange={(e) => setCheckInForm({ ...checkInForm, guestPhone: e.target.value })} placeholder="请输入手机号" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">身份证号</label>
                <input value={checkInForm.idCard} onChange={(e) => setCheckInForm({ ...checkInForm, idCard: e.target.value })} placeholder="请输入身份证号（选填）" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">入住日期</label>
                  <input type="date" value={checkInForm.checkInDate} onChange={(e) => setCheckInForm({ ...checkInForm, checkInDate: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">离店日期</label>
                  <input type="date" value={checkInForm.checkOutDate} onChange={(e) => setCheckInForm({ ...checkInForm, checkOutDate: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1">押金（元）</label><input type="number" value={checkInForm.deposit} onChange={(e) => setCheckInForm({ ...checkInForm, deposit: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"/></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1">入住人数</label><select className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" defaultValue="1"><option>1人</option><option>2人</option><option>3人</option><option>4人</option></select></div>
              </div>
              <div className="bg-slate-50 rounded-xl p-3 space-y-2">
                <p className="text-xs font-medium text-slate-500">收款信息 · 订单来源：自来客</p>
                <div className="grid grid-cols-2 gap-3">
                  <div><label className="text-xs text-slate-500">房费收款</label><select value={checkInForm.paymentStatus} onChange={(e) => setCheckInForm({ ...checkInForm, paymentStatus: e.target.value })} className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs"><option value="unpaid">未收</option><option value="paid">已收</option><option value="partial">部分</option></select></div>
                  <div><label className="text-xs text-slate-500">已收金额</label><input type="number" value={checkInForm.amountPaid} onChange={(e) => setCheckInForm({ ...checkInForm, amountPaid: e.target.value })} placeholder="0" className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs"/></div>
                  <div><label className="text-xs text-slate-500">收款方式</label><select value={checkInForm.paymentMethod} onChange={(e) => setCheckInForm({ ...checkInForm, paymentMethod: e.target.value })} className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs"><option value="cash">现金</option><option value="wechat">微信</option><option value="alipay">支付宝</option><option value="bank">银行卡</option><option value="transfer">对公转账</option></select></div>
                  <div><label className="text-xs text-slate-500">押金已收</label><input type="number" value={checkInForm.deposit} onChange={(e) => setCheckInForm({ ...checkInForm, deposit: e.target.value })} placeholder="0" className="w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs"/></div>
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">备注</label>
                <textarea value={checkInForm.remark} onChange={(e) => setCheckInForm({ ...checkInForm, remark: e.target.value })} placeholder="特殊需求、注意事项等" rows={2} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowCheckInModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmCheckIn} disabled={!checkInForm.guestName || !checkInForm.guestPhone} className="flex-1 px-4 py-2.5 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">确认入住</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== CHECK-OUT MODAL ========== */}
      {showCheckOutModal && checkOutRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowCheckOutModal(false)}>
          <div className="bg-white rounded-2xl w-[520px] shadow-xl h-[85vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center"><LogOut className="w-5 h-5 text-red-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">办理退房</h3>
                  <p className="text-xs text-slate-500">{checkOutRoom.roomTypeName} - {checkOutRoom.roomNumber}</p>
                </div>
              </div>
              <button onClick={() => setShowCheckOutModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              {/* Guest info */}
              <div className="bg-slate-50 rounded-xl p-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div><span className="text-slate-500">客人：</span><span className="font-medium text-slate-800">{checkOutRoom.guest}</span></div>
                  <div><span className="text-slate-500">房间：</span><span className="font-medium text-slate-800">{checkOutRoom.roomNumber}</span></div>
                  <div><span className="text-slate-500">入住：</span><span className="font-medium text-slate-800">{checkOutRoom.checkIn}</span></div>
                  <div><span className="text-slate-500">离店：</span><span className="font-medium text-slate-800">{checkOutRoom.checkOut}</span></div>
                </div>
              </div>
              {/* Billing */}
              <div>
                <p className="text-sm font-medium text-slate-700 mb-2">费用明细</p>
                <div className="space-y-2">
                  <div className="flex justify-between text-sm"><span className="text-slate-500">房费</span><span className="font-medium text-slate-800">¥{checkOutRoom.price} × {checkOutRoom.checkIn && checkOutRoom.checkOut ? Math.max(1, Math.round((new Date(checkOutRoom.checkOut).getTime() - new Date(checkOutRoom.checkIn).getTime()) / 86400000)) : 1}晚</span></div>
                  <div className="flex justify-between text-sm"><span className="text-slate-500">押金</span><span className="font-medium text-slate-800">¥500</span></div>
                  <div className="flex justify-between text-sm"><span className="text-slate-500">其他消费</span><span className="font-medium text-slate-800">¥0</span></div>
                  <div className="border-t border-slate-200 pt-2 flex justify-between text-sm"><span className="font-medium text-slate-700">应退押金</span><span className="font-bold text-emerald-600">¥500</span></div>
                </div>
              </div>
              {/* Refund method */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">退款方式</label>
                <select className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" defaultValue="original">
                  <option value="original">原路退回</option>
                  <option value="cash">现金退款</option>
                  <option value="transfer">银行卡转账</option>
                </select>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
                退房后房间将变为&ldquo;脏房&rdquo;状态，需清洁后方可再次入住
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowCheckOutModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmCheckOut} className="flex-1 px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 transition-colors">确认退房</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== 快捷操作弹窗 ========== */}
      {quickRoom && <RoomActionPopover room={quickRoom} position={quickPos} onClose={() => setQuickRoom(null)} onAction={handleQuickOp} />}

      {/* ========== SUCCESS TOAST ========== */}
      {(showCheckInSuccess || showCheckOutSuccess || operationSuccess) && (
        <div className="fixed top-20 left-1/2 -translate-x-1/2 z-50 animate-bounce">
          <div className={`flex items-center gap-2 px-5 py-3 rounded-xl shadow-lg text-white text-sm font-medium ${showCheckInSuccess ? 'bg-emerald-500' : showCheckOutSuccess ? 'bg-blue-500' : 'bg-emerald-500'}`}>
            <CheckCircle2 className="w-5 h-5" />
            {showCheckInSuccess ? '入住办理成功！' : showCheckOutSuccess ? '退房办理成功！' : operationSuccess}
          </div>
        </div>
      )}

      {/* ========== BOOK ROOM MODAL ========== */}
      {showBookModal && selectedRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowBookModal(false)}>
          <div className="bg-white rounded-2xl w-[480px] shadow-xl h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center"><CalendarDays className="w-5 h-5 text-blue-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">预订房间</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.roomTypeName} - {selectedRoom.roomNumber} · ¥{selectedRoom.price}/晚</p>
                </div>
              </div>
              <button onClick={() => setShowBookModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">客人姓名 <span className="text-red-500">*</span></label>
                  <input value={bookForm.guestName} onChange={(e) => setBookForm({ ...bookForm, guestName: e.target.value })} placeholder="请输入客人姓名" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">手机号 <span className="text-red-500">*</span></label>
                  <input value={bookForm.guestPhone} onChange={(e) => setBookForm({ ...bookForm, guestPhone: e.target.value })} placeholder="请输入手机号" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">入住日期</label>
                  <input type="date" value={bookForm.checkInDate} onChange={(e) => setBookForm({ ...bookForm, checkInDate: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">离店日期</label>
                  <input type="date" value={bookForm.checkOutDate} onChange={(e) => setBookForm({ ...bookForm, checkOutDate: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">备注</label>
                <textarea value={bookForm.remark} onChange={(e) => setBookForm({ ...bookForm, remark: e.target.value })} placeholder="预订备注" rows={2} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 resize-none" />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowBookModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmBook} disabled={!bookForm.guestName || !bookForm.guestPhone} className="flex-1 px-4 py-2.5 bg-blue-500 text-white rounded-xl text-sm font-medium hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">确认预订</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== LOCK ROOM MODAL ========== */}
      {showLockModal && selectedRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowLockModal(false)}>
          <div className="bg-white rounded-2xl w-[420px] shadow-xl h-[50vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-slate-100 rounded-xl flex items-center justify-center"><AlertCircle className="w-5 h-5 text-slate-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">锁房</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.roomNumber} · {selectedRoom.roomTypeName}</p>
                </div>
              </div>
              <button onClick={() => setShowLockModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 text-sm text-amber-700">
                锁房后该房间将不可预订和入住，请确认操作
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">锁房原因</label>
                <select value={lockReason} onChange={(e) => setLockReason(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-slate-500/20 focus:border-slate-500">
                  <option value="">请选择原因</option>
                  <option value="self_use">自用</option>
                  <option value="renovation">装修</option>
                  <option value="event">活动预留</option>
                  <option value="vip_reserve">VIP预留</option>
                  <option value="other">其他</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowLockModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmLock} className="flex-1 px-4 py-2.5 bg-slate-600 text-white rounded-xl text-sm font-medium hover:bg-slate-700 transition-colors">确认锁房</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== EXTEND STAY MODAL ========== */}
      {showExtendModal && selectedRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowExtendModal(false)}>
          <div className="bg-white rounded-2xl w-[420px] shadow-xl h-[55vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-100 rounded-xl flex items-center justify-center"><Clock className="w-5 h-5 text-amber-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">续住</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.roomNumber} · {selectedRoom.guest}</p>
                </div>
              </div>
              <button onClick={() => setShowExtendModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="bg-slate-50 rounded-xl p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-slate-500">当前入住</span><span className="font-medium text-slate-800">{selectedRoom.checkIn}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">当前离店</span><span className="font-medium text-slate-800">{selectedRoom.checkOut}</span></div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">新离店日期 <span className="text-red-500">*</span></label>
                <div className="flex gap-2 mb-2">
                  {[1,2,3,5,7].map(n => (
                    <button key={n} type="button" onClick={() => {
                      if (!selectedRoom.checkOut) return;
                      const d = new Date(selectedRoom.checkOut);
                      d.setDate(d.getDate() + n);
                      setExtendDate(d.toISOString().split('T')[0]);
                    }} className="px-2.5 py-1 text-xs rounded-lg border border-amber-200 text-amber-700 hover:bg-amber-50 transition-colors">+{n}晚</button>
                  ))}
                </div>
                <input type="date" value={extendDate} onChange={(e) => setExtendDate(e.target.value)} min={selectedRoom.checkOut} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-amber-500/20 focus:border-amber-500" />
              </div>
              {extendDate && selectedRoom.checkOut && (
                <div className="bg-emerald-50 border border-emerald-200 rounded-xl p-3 text-sm text-emerald-700">
                  续住 {Math.max(0, Math.round((new Date(extendDate).getTime() - new Date(selectedRoom.checkOut).getTime()) / 86400000))} 晚，额外房费 ¥{Math.max(0, Math.round((new Date(extendDate).getTime() - new Date(selectedRoom.checkOut).getTime()) / 86400000)) * selectedRoom.price}
                </div>
              )}
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowExtendModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmExtend} disabled={!extendDate} className="flex-1 px-4 py-2.5 bg-amber-500 text-white rounded-xl text-sm font-medium hover:bg-amber-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">确认续住</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== CHANGE ROOM MODAL ========== */}
      {showChangeRoomModal && selectedRoom && dailyData && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowChangeRoomModal(false)}>
          <div className="bg-white rounded-2xl w-[520px] shadow-xl h-[75vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-blue-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">换房</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.guest} · 从 {selectedRoom.roomNumber} 换到</p>
                </div>
              </div>
              <button onClick={() => setShowChangeRoomModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-2">选择目标房间 <span className="text-red-500">*</span></label>
                {(() => {
                  const allAvail = dailyData.rooms.filter(r => r.status === 'available' && r.id !== selectedRoom.id);
                  const sameType = allAvail.filter(r => r.roomTypeId === selectedRoom.roomTypeId);
                  const diffType = allAvail.filter(r => r.roomTypeId !== selectedRoom.roomTypeId);
                  const groups = [];
                  if (sameType.length > 0) groups.push({ label: '同房型 · ' + selectedRoom.roomTypeName, rooms: sameType });
                  // Group different types by roomTypeName
                  const diffGroups: Record<string, typeof allAvail> = {};
                  diffType.forEach(r => { if (!diffGroups[r.roomTypeName]) diffGroups[r.roomTypeName] = []; diffGroups[r.roomTypeName].push(r); });
                  Object.entries(diffGroups).forEach(([name, rooms]) => groups.push({ label: name, rooms }));

                  if (allAvail.length === 0) return <div className="text-center py-8 text-sm text-slate-400">无空闲房间可换</div>;

                  return groups.map(g => (
                    <div key={g.label} className="mb-3">
                      <p className="text-xs font-medium text-slate-400 mb-1.5">{g.label} ({g.rooms.length}间)</p>
                      <div className="grid grid-cols-4 gap-2">
                        {g.rooms.map(r => (
                          <button key={r.id} onClick={() => setTargetRoom(r.id)}
                            className={`p-2.5 rounded-xl border text-center transition-all ${targetRoom===r.id?'border-blue-500 bg-blue-50 ring-2 ring-blue-500/20':'border-slate-200 hover:border-blue-300 hover:bg-blue-50/50'}`}>
                            <p className="text-sm font-bold text-slate-800">{r.roomNumber}</p>
                            <p className="text-[10px] text-emerald-600 font-medium">¥{r.price}</p>
                          </button>
                        ))}
                      </div>
                    </div>
                  ));
                })()}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">换房原因</label>
                <input value={changeReason} onChange={(e) => setChangeReason(e.target.value)} placeholder="如：客人要求换房、设备故障等" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
              </div>
              <div className="bg-blue-50 border border-blue-200 rounded-xl p-3 text-sm text-blue-700">
                换房后原房间将变为&ldquo;脏房&rdquo;状态，需清洁后方可再次入住
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowChangeRoomModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmChangeRoom} disabled={!targetRoom} className="flex-1 px-4 py-2.5 bg-blue-500 text-white rounded-xl text-sm font-medium hover:bg-blue-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">确认换房</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== CANCEL BOOKING MODAL ========== */}
      {showCancelBookModal && selectedRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowCancelBookModal(false)}>
          <div className="bg-white rounded-2xl w-[420px] shadow-xl h-[55vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center"><AlertCircle className="w-5 h-5 text-red-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">取消预订</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.roomNumber} · {selectedRoom.guest}</p>
                </div>
              </div>
              <button onClick={() => setShowCancelBookModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                取消预订后房间将恢复为&ldquo;空闲&rdquo;状态，此操作不可撤销
              </div>
              <div className="bg-slate-50 rounded-xl p-3 text-sm space-y-1">
                <div className="flex justify-between"><span className="text-slate-500">客人</span><span className="font-medium text-slate-800">{selectedRoom.guest}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">入住日期</span><span className="font-medium text-slate-800">{selectedRoom.checkIn}</span></div>
                <div className="flex justify-between"><span className="text-slate-500">离店日期</span><span className="font-medium text-slate-800">{selectedRoom.checkOut}</span></div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">取消原因 <span className="text-red-500">*</span></label>
                <select value={cancelReason} onChange={(e) => setCancelReason(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500">
                  <option value="">请选择原因</option>
                  <option value="guest_request">客人要求</option>
                  <option value="no_show">未到店</option>
                  <option value="payment_issue">付款问题</option>
                  <option value="room_issue">房间问题</option>
                  <option value="other">其他</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowCancelBookModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">返回</button>
              <button onClick={handleConfirmCancelBook} disabled={!cancelReason} className="flex-1 px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">确认取消</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MODIFY BOOKING MODAL ========== */}
      {showModifyBookModal && selectedRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowModifyBookModal(false)}>
          <div className="bg-white rounded-2xl w-[480px] shadow-xl h-[70vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-blue-100 rounded-xl flex items-center justify-center"><CalendarDays className="w-5 h-5 text-blue-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">修改预订</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.roomNumber} · {selectedRoom.roomTypeName}</p>
                </div>
              </div>
              <button onClick={() => setShowModifyBookModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">客人姓名</label>
                  <input value={modifyForm.guestName} onChange={(e) => setModifyForm({ ...modifyForm, guestName: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">手机号</label>
                  <input value={modifyForm.guestPhone} onChange={(e) => setModifyForm({ ...modifyForm, guestPhone: e.target.value })} placeholder="请输入手机号" className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">入住日期</label>
                  <input type="date" value={modifyForm.checkInDate} onChange={(e) => setModifyForm({ ...modifyForm, checkInDate: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1">离店日期</label>
                  <input type="date" value={modifyForm.checkOutDate} onChange={(e) => setModifyForm({ ...modifyForm, checkOutDate: e.target.value })} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">备注</label>
                <textarea value={modifyForm.remark} onChange={(e) => setModifyForm({ ...modifyForm, remark: e.target.value })} placeholder="修改备注" rows={2} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-500/20 focus:border-blue-500 resize-none" />
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowModifyBookModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmModifyBook} className="flex-1 px-4 py-2.5 bg-blue-500 text-white rounded-xl text-sm font-medium hover:bg-blue-600 transition-colors">保存修改</button>
            </div>
          </div>
        </div>
      )}

      {/* ========== MAINTENANCE MODAL ========== */}
      {showMaintenanceModal && selectedRoom && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowMaintenanceModal(false)}>
          <div className="bg-white rounded-2xl w-[420px] shadow-xl h-[55vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-red-100 rounded-xl flex items-center justify-center"><AlertCircle className="w-5 h-5 text-red-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">标记维修</h3>
                  <p className="text-xs text-slate-500">{selectedRoom.roomNumber} · {selectedRoom.roomTypeName}</p>
                </div>
              </div>
              <button onClick={() => setShowMaintenanceModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="bg-red-50 border border-red-200 rounded-xl p-3 text-sm text-red-700">
                标记维修后该房间将不可预订和入住，待维修完成后再恢复
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1">维修原因 <span className="text-red-500">*</span></label>
                <select value={maintenanceReason} onChange={(e) => setMaintenanceReason(e.target.value)} className="w-full px-3 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500">
                  <option value="">请选择原因</option>
                  <option value="ac">空调故障</option>
                  <option value="plumbing">水管/卫浴问题</option>
                  <option value="electrical">电路问题</option>
                  <option value="furniture">家具损坏</option>
                  <option value="deep_clean">深度清洁</option>
                  <option value="other">其他</option>
                </select>
              </div>
            </div>
            <div className="flex gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowMaintenanceModal(false)} className="flex-1 px-4 py-2.5 border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleConfirmMaintenance} disabled={!maintenanceReason} className="flex-1 px-4 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 disabled:opacity-40 disabled:cursor-not-allowed transition-colors">确认维修</button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 房型弹窗（新增/编辑） ===================== */}
      {showRoomTypeModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowRoomTypeModal(false)}>
          <div className="bg-white rounded-2xl w-[560px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 relative flex-shrink-0">
              <button onClick={() => setShowRoomTypeModal(false)} className="absolute top-4 right-4 p-1 hover:bg-white/20 rounded-lg"><X className="w-5 h-5 text-white" /></button>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-white" /></div>
                <h3 className="text-lg font-bold text-white">{editingRoomType ? '编辑房型' : '新增房型'}</h3>
              </div>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">房型名称 <span className="text-red-400">*</span></label>
                  <input value={roomTypeForm.name} onChange={e => setRoomTypeForm(f => ({ ...f, name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="如: 大床房" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">所属门店 <span className="text-red-400">*</span></label>
                  <select value={roomTypeForm.storeId} onChange={e => setRoomTypeForm(f => ({ ...f, storeId: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white">
                    <option value="">请选择</option>
                    {stores.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
                  </select>
                </div>
              </div>
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">床型</label>
                  <select value={roomTypeForm.bedType} onChange={e => setRoomTypeForm(f => ({ ...f, bedType: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white">
                    <option value="">请选择</option>
                    <option>1.8m大床</option><option>2.0m大床</option><option>1.2m双床</option><option>1.5m双床</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">面积(m²)</label>
                  <input type="number" value={roomTypeForm.area} onChange={e => setRoomTypeForm(f => ({ ...f, area: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">最多入住</label>
                  <input type="number" value={roomTypeForm.maxGuests} onChange={e => setRoomTypeForm(f => ({ ...f, maxGuests: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">基准价格(元/晚)</label>
                  <input type="number" value={roomTypeForm.basePrice} onChange={e => setRoomTypeForm(f => ({ ...f, basePrice: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">房间数量</label>
                  <input type="number" value={roomTypeForm.roomCount} onChange={e => setRoomTypeForm(f => ({ ...f, roomCount: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">房间设施</label>
                <div className="flex flex-wrap gap-2">
                  {['电视', '空调', '独立卫浴', '浴缸', 'WiFi', '迷你吧', '保险箱', '客厅', '阳台', '书桌', '儿童设施'].map(f => (
                    <button key={f} onClick={() => setRoomTypeForm(form => ({ ...form, facilities: form.facilities.includes(f) ? form.facilities.filter(x => x !== f) : [...form.facilities, f] }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${roomTypeForm.facilities.includes(f) ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:border-emerald-300 hover:bg-emerald-50'}`}>
                      {f}
                    </button>
                  ))}
                </div>
              </div>
              {/* 房型图片 — 素材库多选 */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">房型图片</label>
                <button
                  type="button"
                  onClick={() => setShowAssetPicker(true)}
                  className="w-full min-h-[80px] border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center gap-1 text-slate-400 hover:border-emerald-500 hover:text-emerald-500 transition-colors cursor-pointer"
                >
                  <ImageIcon className="w-6 h-6" />
                  <span className="text-sm">从素材库选择图片（{roomTypeForm.images.length > 0 ? `已选${roomTypeForm.images.length}张` : '点击选择'}）</span>
                </button>
                {/* 已选图片预览 */}
                {roomTypeForm.images.length > 0 && (
                  <div className="flex gap-2 mt-2 overflow-x-auto">
                    {roomTypeForm.images.map((url, idx) => (
                      <div key={idx} className="relative shrink-0 w-16 h-16 rounded-lg overflow-hidden bg-slate-100">
                        <img src={url} alt="" className="w-full h-full object-cover" />
                        <button
                          type="button"
                          onClick={() => setRoomTypeForm(prev => ({
                            ...prev, images: prev.images.filter((_, i) => i !== idx)
                          }))}
                          className="absolute top-0 right-0 w-5 h-5 bg-red-500 text-white rounded-bl-lg flex items-center justify-center text-xs"
                        >×</button>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowRoomTypeModal(false)} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleSaveRoomType} disabled={!roomTypeForm.name || !roomTypeForm.storeId} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50">{editingRoomType ? '保存修改' : '确认创建'}</button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 管理房间弹窗 ===================== */}
      {showRoomManageModal && managingRoomType && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowRoomManageModal(false)}>
          <div className="bg-white rounded-2xl w-[720px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 relative flex-shrink-0">
              <button onClick={() => setShowRoomManageModal(false)} className="absolute top-4 right-4 p-1 hover:bg-white/20 rounded-lg"><X className="w-5 h-5 text-white" /></button>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-white" /></div>
                <div>
                  <h3 className="text-lg font-bold text-white">管理房间 - {managingRoomType.name}</h3>
                  <p className="text-sm text-white/70">{stores.find(s => s.id === managingRoomType.storeId)?.name} · 共{roomItems.filter(r => r.roomTypeId === managingRoomType.id).length}间</p>
                </div>
              </div>
            </div>
            <div className="p-5 flex-1 overflow-y-auto">
              {/* 房间状态统计 */}
              {(() => {
                const rtRooms = roomItems.filter(r => r.roomTypeId === managingRoomType.id);
                const stats = {
                  available: rtRooms.filter(r => r.status === 'available').length,
                  occupied: rtRooms.filter(r => r.status === 'occupied').length,
                  maintenance: rtRooms.filter(r => r.status === 'maintenance').length,
                  cleaning: rtRooms.filter(r => r.status === 'cleaning').length,
                };
                return (
                  <div className="grid grid-cols-4 gap-3 mb-5">
                    <div className="p-3 bg-emerald-50 rounded-xl text-center"><p className="text-2xl font-bold text-emerald-600">{stats.available}</p><p className="text-xs text-emerald-600/70">空闲</p></div>
                    <div className="p-3 bg-blue-50 rounded-xl text-center"><p className="text-2xl font-bold text-blue-600">{stats.occupied}</p><p className="text-xs text-blue-600/70">在住</p></div>
                    <div className="p-3 bg-orange-50 rounded-xl text-center"><p className="text-2xl font-bold text-orange-600">{stats.maintenance}</p><p className="text-xs text-orange-600/70">维护</p></div>
                    <div className="p-3 bg-purple-50 rounded-xl text-center"><p className="text-2xl font-bold text-purple-600">{stats.cleaning}</p><p className="text-xs text-purple-600/70">清洁</p></div>
                  </div>
                );
              })()}
              {/* 操作栏 */}
              <div className="flex items-center justify-between mb-4">
                <p className="text-sm font-medium text-slate-700">房间列表</p>
                <button onClick={() => { setAddRoomForm({ roomNumber: '', floor: 1, attributes: [], price: managingRoomType.basePrice }); setShowAddRoomModal(true); }}
                  className="px-3 py-1.5 text-xs font-medium text-white bg-emerald-500 hover:bg-emerald-600 rounded-lg flex items-center gap-1"><Plus className="w-3.5 h-3.5" /> 添加房间</button>
              </div>
              {/* 房间列表 */}
              {(() => {
                const rtRooms = roomItems.filter(r => r.roomTypeId === managingRoomType.id);
                if (rtRooms.length === 0) {
                  return <div className="bg-slate-50 rounded-xl p-8 text-center"><BedDouble className="w-10 h-10 text-slate-300 mx-auto mb-2" /><p className="text-sm text-slate-500">暂无房间，请点击&ldquo;添加房间&rdquo;</p></div>;
                }
                return (
                  <div className="space-y-2">
                    {rtRooms.map(room => (
                      <div key={room.id} className="flex items-center justify-between p-3 bg-white border border-slate-200/80 rounded-xl hover:shadow-sm transition-shadow">
                        <div className="flex items-center gap-4">
                          <div className="w-14 text-center">
                            <p className="text-lg font-bold text-slate-800">{room.roomNumber}</p>
                            <p className="text-xs text-slate-400">{room.floor}F</p>
                          </div>
                          <div className="h-8 w-px bg-slate-200" />
                          <div className="flex items-center gap-2">
                            <StatusBadge label={room.status === 'available' ? '空闲' : room.status === 'occupied' ? '在住' : room.status === 'maintenance' ? '维护' : '清洁'} type={room.status === 'available' ? 'success' : room.status === 'occupied' ? 'warning' : 'danger'} />
                            <span className="text-sm text-slate-500">¥{room.price}/晚</span>
                          </div>
                          {room.attributes.length > 0 && (
                            <div className="flex gap-1">
                              {room.attributes.slice(0, 3).map(a => <span key={a} className="px-1.5 py-0.5 bg-slate-50 rounded text-xs text-slate-500">{a}</span>)}
                              {room.attributes.length > 3 && <span className="text-xs text-slate-400">+{room.attributes.length - 3}</span>}
                            </div>
                          )}
                        </div>
                        {canEditRooms && <div className="flex items-center gap-1">
                          <button onClick={() => { setEditingRoom(room); setEditRoomForm({ roomNumber: room.roomNumber, floor: room.floor, status: room.status, attributes: [...room.attributes], price: room.price }); }}
                            className="p-1.5 hover:bg-slate-100 rounded-lg"><Edit2 className="w-3.5 h-3.5 text-slate-400" /></button>
                          <button onClick={() => handleDeleteRoom(room.id)} className="p-1.5 hover:bg-red-50 rounded-lg"><Trash2 className="w-3.5 h-3.5 text-red-400" /></button>
                        </div>}
                      </div>
                    ))}
                  </div>
                );
              })()}
            </div>
            <div className="flex justify-end p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowRoomManageModal(false)} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">关闭</button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 添加房间弹窗 ===================== */}
      {showAddRoomModal && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center" onClick={() => setShowAddRoomModal(false)}>
          <div className="bg-white rounded-2xl w-[480px] h-[70vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-slate-800">添加房间</h3>
                <button onClick={() => setShowAddRoomModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
              </div>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">房间号 <span className="text-red-400">*</span></label>
                  <input value={addRoomForm.roomNumber} onChange={e => setAddRoomForm(f => ({ ...f, roomNumber: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="如: 301" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">楼层</label>
                  <input type="number" value={addRoomForm.floor} onChange={e => setAddRoomForm(f => ({ ...f, floor: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">价格(元/晚)</label>
                <input type="number" value={addRoomForm.price} onChange={e => setAddRoomForm(f => ({ ...f, price: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                <p className="text-xs text-slate-400 mt-1">默认使用房型基准价 ¥{managingRoomType?.basePrice}</p>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">房间属性</label>
                <div className="flex flex-wrap gap-2">
                  {['朝南', '朝北', '靠山', '靠海', '角落', '连通', '无障碍', '高楼层'].map(a => (
                    <button key={a} onClick={() => setAddRoomForm(f => ({ ...f, attributes: f.attributes.includes(a) ? f.attributes.filter(x => x !== a) : [...f.attributes, a] }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${addRoomForm.attributes.includes(a) ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:border-emerald-300 hover:bg-emerald-50'}`}>
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowAddRoomModal(false)} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleAddRoom} disabled={!addRoomForm.roomNumber} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50">确认添加</button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 编辑房间弹窗 ===================== */}
      {editingRoom && (
        <div className="fixed inset-0 bg-black/50 z-[60] flex items-center justify-center" onClick={() => setEditingRoom(null)}>
          <div className="bg-white rounded-2xl w-[480px] h-[70vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-100 flex-shrink-0">
              <div className="flex items-center justify-between">
                <h3 className="text-lg font-semibold text-slate-800">编辑房间 {editingRoom.roomNumber}</h3>
                <button onClick={() => setEditingRoom(null)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
              </div>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">房间号</label>
                  <input value={editRoomForm.roomNumber} onChange={e => setEditRoomForm(f => ({ ...f, roomNumber: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">楼层</label>
                  <input type="number" value={editRoomForm.floor} onChange={e => setEditRoomForm(f => ({ ...f, floor: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">房间状态</label>
                  <select value={editRoomForm.status} onChange={e => setEditRoomForm(f => ({ ...f, status: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white">
                    <option value="available">空闲</option>
                    <option value="occupied">在住</option>
                    <option value="maintenance">维护</option>
                    <option value="cleaning">清洁</option>
                  </select>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">价格(元/晚)</label>
                  <input type="number" value={editRoomForm.price} onChange={e => setEditRoomForm(f => ({ ...f, price: Number(e.target.value) }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">房间属性</label>
                <div className="flex flex-wrap gap-2">
                  {['朝南', '朝北', '靠山', '靠海', '角落', '连通', '无障碍', '高楼层'].map(a => (
                    <button key={a} onClick={() => setEditRoomForm(f => ({ ...f, attributes: f.attributes.includes(a) ? f.attributes.filter(x => x !== a) : [...f.attributes, a] }))}
                      className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${editRoomForm.attributes.includes(a) ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 text-slate-600 hover:border-emerald-300 hover:bg-emerald-50'}`}>
                      {a}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setEditingRoom(null)} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleSaveEditRoom} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25">保存修改</button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 库存管理 Tab ============ */}
      {activeTab === 'inventory' && (
        <InventoryTab />
      )}

      <AssetPicker
        open={showAssetPicker}
        onClose={() => setShowAssetPicker(false)}
        type="image"
        multi
        onSelect={(assets: { url: string }[]) => {
          setRoomTypeForm(prev => ({
            ...prev,
            images: [...prev.images, ...assets.map(a => a.url)]
          }));
          setShowAssetPicker(false);
        }}
      />

    </div>
  );
}

// 库存管理Tab组件
function InventoryTab() {
  const [inv, setInv] = useState<any>(null);
  const [channels, setChannels] = useState<string[]>([]);
  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [quotas, setQuotas] = useState<Record<string, Record<string, number>>>({});
  const [editing, setEditing] = useState(true);
  const [toast, setToast] = useState('');

  useEffect(() => {
    apiGet('/api/inventory/overview').then((d: any) => setInv(d?.data)).catch(() => {});
    apiGet('/api/pricing?type=channel-pricing').then((d: any) => setChannels((d?.channels || []).map((c: any) => c.name))).catch(() => {});
    apiGet('/api/stores?type=roomTypes').then((d: any) => setRoomTypes(Array.isArray(d) ? d : [])).catch(() => {});
    apiGet('/api/inventory/quotas').then((d: any) => { if (d?.data) setQuotas(d.data); }).catch(() => {});
  }, []);

  const saveQuotas = async () => {
    try { await apiPost('/api/inventory/save-quotas', { quotas }); setToast('✅ 配额已保存'); setTimeout(() => setToast(''), 2000); } catch { setToast('❌ 保存失败'); setTimeout(() => setToast(''), 2000); }
  };

  const CH_ICONS: Record<string, string> = { '携程':'🏨','美团':'🍱','飞猪':'✈️','抖音':'🎵','途家':'🏡','直营':'🏪','直客':'🚶' };

  return (
    <div className="space-y-5">
      {toast && (
        <div className="fixed top-6 left-1/2 -translate-x-1/2 z-50 bg-emerald-600 text-white px-6 py-3 rounded-2xl shadow-xl text-sm font-medium">
          {toast}
        </div>
      )}
      {/* 库存概览 */}
      {inv && (
        <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
          <h3 className="font-bold text-slate-700 mb-4 flex items-center gap-2"><span className="text-lg">📊</span>库存概览</h3>
          <div className="grid grid-cols-5 gap-4 mb-4">
            {[{label:'总房间',value:inv.total,c:'text-slate-700'},{label:'可售',value:inv.available,c:'text-emerald-600'},{label:'已入住',value:inv.occupied,c:'text-blue-600'},{label:'脏房',value:inv.dirty,c:'text-amber-600'},{label:'入住率',value:`${inv.occupancyRate}%`,c:'text-purple-600'}].map((m,i) => (
              <div key={i} className="bg-slate-50 rounded-2xl p-4 text-center">
                <p className={`text-3xl font-bold ${m.c}`}>{m.value}</p>
                <p className="text-xs text-slate-400 mt-1">{m.label}</p>
              </div>
            ))}
          </div>
          {inv.alert !== 'normal' && (
            <div className={`rounded-xl px-4 py-2.5 text-sm ${inv.alert === 'urgent' ? 'bg-red-50 text-red-700' : 'bg-amber-50 text-amber-700'}`}>
              {inv.alertMsg}
            </div>
          )}
          <div className="flex items-center gap-3 text-xs text-slate-500 mt-3">
            <span>各渠道已售:</span>
            {Object.entries(inv.channelSold || {}).map(([ch, count]) => (
              <span key={ch} className="px-2 py-1 bg-slate-50 rounded-lg">{CH_ICONS[ch]||'📌'} {ch} <strong className="text-slate-700">{count as number}</strong>间</span>
            ))}
          </div>
        </div>
      )}

      {/* 渠道配额 */}
      <div className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <h3 className="font-bold text-slate-700 flex items-center gap-2"><span className="text-lg">📦</span>渠道库存配额</h3>
          <div className="flex items-center gap-2">
            {editing && (
              <button onClick={() => {
                const otaChannels = channels.filter(c => c !== '直营' && c !== '直客');
                const newQuotas: Record<string, Record<string, number>> = {};
                roomTypes.forEach((rt: any) => {
                  const total = rt.roomCount || 10;
                  const otaQuota = Math.max(1, Math.floor(total * 0.7 / Math.max(1, otaChannels.length)));
                  newQuotas[rt.name] = {};
                  otaChannels.forEach(ch => { newQuotas[rt.name][ch] = otaQuota; });
                });
                setQuotas(newQuotas);
              }} className="text-xs px-3 py-2 bg-emerald-50 text-emerald-600 rounded-xl hover:bg-emerald-100 font-medium">⚡ 自动分配</button>
            )}
            {editing && <button onClick={saveQuotas} className="text-xs px-3 py-2 bg-emerald-500 text-white rounded-xl hover:bg-emerald-600 font-medium">💾 保存</button>}
            <button onClick={() => setEditing(!editing)} className={`text-xs px-4 py-2 rounded-xl font-medium ${editing ? 'bg-slate-100 text-slate-600' : 'bg-blue-500 text-white'}`}>{editing ? '收起' : '管理配额'}</button>
          </div>
        </div>
        {editing && channels.length > 0 && roomTypes.length > 0 && (
          <div className="bg-gradient-to-br from-slate-50 to-blue-50/30 rounded-2xl p-5 border border-slate-100">
            <table className="w-full">
              <thead><tr className="border-b border-slate-200">
                <th className="text-left py-3 px-4 text-xs font-semibold text-slate-500">房型</th>
                {channels.map(ch => <th key={ch} className="text-center py-3 px-3 text-xs font-semibold text-slate-500">{ch}</th>)}
              </tr></thead>
              <tbody className="divide-y divide-slate-100">
                {roomTypes.map((rt: any) => (
                  <tr key={rt.name} className="hover:bg-white/50">
                    <td className="py-3 px-4 text-sm font-medium text-slate-700">{rt.name} <span className="text-xs text-slate-400">({rt.roomCount}间)</span></td>
                    {channels.map(ch => (
                      <td key={ch} className="py-2 px-3 text-center">
                        <input type="number" min={0} max={rt.roomCount} value={quotas[rt.name]?.[ch] ?? ''}
                          onChange={e => { const v = e.target.value === '' ? undefined : parseInt(e.target.value) || 0; setQuotas(prev => ({ ...prev, [rt.name]: { ...(prev[rt.name] || {}), [ch]: v as number } })); }}
                          className="w-16 px-3 py-2 border border-slate-200 rounded-xl text-sm font-bold text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                          placeholder="—" />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-[11px] text-slate-400 mt-3">💡 留空=不限，填0=不分配。建议配额之和 ≤ 该房型总房间数。</p>
          </div>
        )}
      </div>
    </div>
  );
}

export default function RoomsPage() {
  return (
    <Suspense>
      <RoomsContent />
    </Suspense>
  );
}
