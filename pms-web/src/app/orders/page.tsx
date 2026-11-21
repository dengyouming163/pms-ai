'use client';

import { useEffect, useState, useCallback, useMemo } from 'react';
import { useRouter } from 'next/navigation';
import { TabBar } from '@/components/tab-bar';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { exportToCSV } from '@/lib/utils/export';
import { isValidPhone, isValidIdCard, isValidDateRange, validateRequired } from '@/lib/utils/validation';
import { apiGet, apiPost } from '@/lib/api-client';
import { OTAAlerts } from '@/components/ai/ota-alerts';
import {
  Pagination,
  PaginationContent,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from '@/components/ui/pagination';
import {
  ClipboardList, Search, Filter, CheckCircle2, XCircle, Clock, AlertTriangle,
  ChevronDown, Eye, RefreshCw, Plus, ArrowRight, Phone, MessageSquare,
  BedDouble, CalendarDays, User, DollarSign, Timer, X, Sparkles, Download,
  TrendingUp, Shield, CreditCard, FileText, Package
} from 'lucide-react';

// --- Types ---
interface Order {
  id: string; orderNo: string; channel: string; channelColor: string;
  guestName: string; guestPhone: string; guestId?: string;
  checkIn: string; checkOut: string; nights: number;
  roomType: string; roomTypeId: string; roomNumber: string; roomId: string;
  amount: number; originalAmount?: number; discount?: string;
  paymentStatus: 'paid' | 'unpaid' | 'partial' | 'refunded';
  paymentMethod?: string;
  status: 'pending' | 'pending_confirm' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled' | 'no_show';
  source: 'ota' | 'direct' | 'walk_in' | 'phone' | 'group' | 'corporate' | 'platform';
  createdAt: string; confirmedAt?: string; cancelledAt?: string; cancelReason?: string;
  remark?: string; extras?: { name: string; amount: number }[];
  otaTimeout?: string; otaOrderId?: string;
  platformOrderNo?: string;
  verifyCode?: string;
}

interface OrderStats {
  total: number; pending: number; otaPending: number; urgent: number;
  todayCheckin: number; todayCheckout: number;
  channelBreakdown: { name: string; count: number; color: string }[];
  statusBreakdown: { key: string; label: string; count: number }[];
}

interface ChannelGroup {
  name: string; color: string; icon: string; count: number;
  urgentCount: number; orders: Order[];
}

interface OrderDetail extends Order {
  channelInfo: { color: string; icon: string };
  statusInfo: { label: string; color: string };
  timeline: { time: string; label: string; desc: string }[];
}

const tabs = [
  { key: 'all', label: '全部订单' },
  { key: 'pending', label: '渠道订单' },
];

const statusMap: Record<string, { label: string; type: 'success' | 'info' | 'warning' | 'danger' | 'default' }> = {
  pending: { label: '待确认', type: 'warning' },
  pending_confirm: { label: '待确认', type: 'warning' },
  confirmed: { label: '已确认', type: 'info' },
  checked_in: { label: '已入住', type: 'success' },
  checked_out: { label: '已退房', type: 'default' },
  cancelled: { label: '已取消', type: 'danger' },
  no_show: { label: '未到店', type: 'danger' },
};

const paymentStatusMap: Record<string, { label: string; type: 'success' | 'warning' | 'danger' | 'info' }> = {
  paid: { label: '已支付', type: 'success' },
  unpaid: { label: '未支付', type: 'danger' },
  partial: { label: '部分支付', type: 'warning' },
  refunded: { label: '已退款', type: 'info' },
};

const sourceLabels: Record<string, string> = {
  ota: 'OTA', direct: '直营', walk_in: '到店', phone: '电话', group: '团队', corporate: '协议',
  platform: '平台',
};

const channelLabels: Record<string, string> = {
  'walk_in': '自来客', 'walk-in': '自来客', '到店': '自来客', 'direct': '自来客',
  '携程': '携程', '美团': '美团', '飞猪': '飞猪', '抖音': '抖音', '小红书': '小红书',
  'phone': '电话预订', 'group': '团队', 'corporate': '协议客户',
  '私域平台': '私域平台',
};

export default function OrdersPage() {
  const router = useRouter();
  const [activeTab, setActiveTab] = useState('all');
  const [orders, setOrders] = useState<Order[]>([]);
  const [stats, setStats] = useState<OrderStats | null>(null);
  const [channelGroups, setChannelGroups] = useState<ChannelGroup[]>([]);
  const [loading, setLoading] = useState(true);

  // Filters
  const [filterChannel, setFilterChannel] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [filterKeyword, setFilterKeyword] = useState('');

  // 分页状态
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  // Detail modal
  const [detailOrder, setDetailOrder] = useState<OrderDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);

  // Create form
  const [createForm, setCreateForm] = useState({
    guestName: '', guestPhone: '', checkIn: '', checkOut: '',
    roomType: '', roomTypeId: '', roomNumber: '', roomId: '', channel: '到店', amount: '',
    source: 'walk_in' as string, paymentMethod: '到店付', remark: '',
  });
  const [createLoading, setCreateLoading] = useState(false);
  const [createSuccess, setCreateSuccess] = useState(false);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});

  // 新建订单 - 动态房型/房号数据
  const [availableRoomTypes, setAvailableRoomTypes] = useState<string[]>([]);
  const [availableRooms, setAvailableRooms] = useState<{ id: string; roomNumber: string; roomType: string; roomTypeId: string }[]>([]);
  const [channelList, setChannelList] = useState<{ name: string }[]>([]);

  // Batch select
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [batchLoading, setBatchLoading] = useState(false);

  // Cancel modal
  const [cancelOrderId, setCancelOrderId] = useState<string | null>(null);
  const [cancelReason, setCancelReason] = useState('');

  const today = useMemo(() => new Date().toISOString().split('T')[0], []);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const listParams = new URLSearchParams();
      listParams.set('page', String(page));
      listParams.set('limit', String(limit));
      if (filterStatus) listParams.set('status', filterStatus);
      if (filterChannel) listParams.set('channel', filterChannel);
      if (filterKeyword) listParams.set('keyword', filterKeyword);

      // 渠道订单 Tab 单独拉取
      const [listRes, statsRes, channelRes] = await Promise.all([
        apiGet(`/api/orders?${listParams.toString()}`),
        apiGet(`/api/orders?type=stats&date=${today}`),
        apiGet('/api/orders?type=channel-pending'),
      ]);
      setOrders(listRes.orders || []);
      setTotal(listRes.pagination?.total || 0);
      if (listRes.channels) setChannelList(listRes.channels.map((c: any) => typeof c === 'string' ? { name: c } : { name: c.name || c }));
      setTotalPages(listRes.pagination?.totalPages || 0);
      setStats(statsRes);
      setChannelGroups(channelRes.channels || []);
    } catch { /* ignore */ }
    setLoading(false);
  }, [today, page, limit, filterStatus, filterChannel, filterKeyword]);

  // Tab 切换 + 筛选条件变化时重新拉取
  useEffect(() => { fetchData(); }, [fetchData, activeTab]);

  // 筛选条件变更时重置到第一页
  useEffect(() => { setPage(1); }, [filterChannel, filterStatus, filterKeyword]);

  const handleViewDetail = async (orderId: string) => {
    setDetailLoading(true);
    try {
      const res = await apiGet(`/api/orders?type=detail&id=${orderId}`);
      setDetailOrder(res);
    } catch { /* ignore */ }
    setDetailLoading(false);
  };

  const handleConfirm = async (orderId: string) => {
    await apiPost('/api/orders', { action: 'confirm', orderId });
    fetchData();
    if (detailOrder) setDetailOrder(null);
  };

  const handleCancel = async () => {
    if (!cancelOrderId) return;
    await apiPost('/api/orders', { action: 'cancel', orderId: cancelOrderId, reason: cancelReason });
    setCancelOrderId(null);
    setCancelReason('');
    fetchData();
    if (detailOrder) setDetailOrder(null);
  };

  const handleBatchConfirm = async () => {
    setBatchLoading(true);
    await apiPost('/api/orders', { action: 'batchConfirm', orderIds: selectedIds });
    setSelectedIds([]);
    setBatchLoading(false);
    fetchData();
  };

  // 打开新建订单弹窗并加载房型/房号数据
  const handleOpenCreateModal = async () => {
    setShowCreateModal(true);
    setFormErrors({});
    // 加载渠道列表
    // channel list populated from orders response (see fetchData)
    try {
      const data = await apiGet('/api/rooms?type=daily');
      const rooms: Array<{ id: string; roomNumber: string; roomType: string; roomTypeId: string; roomTypeName: string; status: string }> = data.rooms || [];
      // 提取唯一房型名称
      const types = [...new Set(rooms.map(r => r.roomTypeName || r.roomType).filter(Boolean))];
      setAvailableRoomTypes(types as string[]);
      // 仅可用状态的房间
      setAvailableRooms(rooms
        .filter((r: any) => r.status === 'available')
        .map(r => ({ id: r.id, roomNumber: r.roomNumber, roomType: r.roomTypeName || r.roomType, roomTypeId: r.roomTypeId }))
      );
    } catch { /* 加载失败时保持下拉为空 */ }
  };

  const handleCreate = async () => {
    // 表单校验
    const errors: Record<string, string> = {};
    const nameCheck = validateRequired(createForm.guestName, '客户姓名');
    if (!nameCheck.valid) errors.guestName = nameCheck.error;
    if (createForm.guestPhone && !isValidPhone(createForm.guestPhone)) {
      errors.guestPhone = '请输入正确的手机号';
    }
    const dateCheck = isValidDateRange(createForm.checkIn, createForm.checkOut);
    if (!dateCheck.valid) {
      errors.checkIn = dateCheck.error;
      errors.checkOut = dateCheck.error;
    }
    if (Object.keys(errors).length > 0) {
      setFormErrors(errors);
      return;
    }
    setFormErrors({});
    setCreateLoading(true);
    await apiPost('/api/orders', { action: 'create', ...createForm, amount: Number(createForm.amount) || 0 });
    setCreateLoading(false);
    setCreateSuccess(true);
    setCreateForm({ guestName: '', guestPhone: '', checkIn: '', checkOut: '', roomType: '', roomTypeId: '', roomNumber: '', roomId: '', channel: '到店', amount: '', source: 'walk_in', paymentMethod: '到店付', remark: '' });
    fetchData();
    setTimeout(() => { setCreateSuccess(false); setShowCreateModal(false); }, 1500);
  };

  const toggleSelect = (id: string) => {
    setSelectedIds(prev => prev.includes(id) ? prev.filter(x => x !== id) : [...prev, id]);
  };

  const toggleSelectAll = (ids: string[]) => {
    if (ids.every(id => selectedIds.includes(id))) {
      setSelectedIds(prev => prev.filter(x => !ids.includes(x)));
    } else {
      setSelectedIds(prev => [...new Set([...prev, ...ids])]);
    }
  };

  const isOtaUrgent = (order: Order) => order.otaTimeout && parseInt(order.otaTimeout) < 30;

  return (
    <div className="space-y-5">
      <PageHeader
        title="订单管理"
        subtitle="全渠道订单统一处理，高效管理预订与入住"
        icon={<ClipboardList className="w-5 h-5" />}
        actions={[
          {
            label: '新建订单',
            icon: <Plus className="w-4 h-4" />,
            variant: 'primary',
            onClick: handleOpenCreateModal,
          },
          {
            label: '导出CSV',
            icon: <Download className="w-4 h-4" />,
            onClick: () => {
              const data = orders.map(o => ({
                订单号: o.id, 客人姓名: o.guestName, 房型: o.roomType,
                渠道: o.channel, 状态: o.status, 金额: o.amount,
                入住日期: o.checkIn, 离店日期: o.checkOut,
                下单时间: o.createdAt
              }));
              exportToCSV(data, `订单列表_${new Date().toISOString().slice(0,10)}`);
            },
          },
          {
            label: '平台套餐订单',
            icon: <Package className="w-4 h-4" />,
            onClick: () => router.push('/orders/product'),
          },
        ]}
      />

      {/* Stats Cards */}
      {stats && (
        <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-3">
          <div className="bg-white rounded-xl border border-slate-200 p-3.5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-slate-400" />
            <div className="pl-2">
              <p className="text-xs text-slate-500">总订单</p>
              <p className="text-2xl font-bold text-slate-800 mt-0.5">{stats.total}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-amber-200 p-3.5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-amber-500" />
            <div className="pl-2">
              <p className="text-xs text-amber-600">待确认</p>
              <p className="text-2xl font-bold text-amber-700 mt-0.5">{stats.pending}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-red-200 p-3.5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-red-500" />
            <div className="pl-2">
              <p className="text-xs text-red-600">OTA待处理</p>
              <p className="text-2xl font-bold text-red-700 mt-0.5">{stats.otaPending}</p>
              {stats.urgent > 0 && <p className="text-xs text-red-500 mt-0.5">{stats.urgent}单即将超时</p>}
            </div>
          </div>
          <div className="bg-white rounded-xl border border-blue-200 p-3.5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-blue-500" />
            <div className="pl-2">
              <p className="text-xs text-blue-600">今日入住</p>
              <p className="text-2xl font-bold text-blue-700 mt-0.5">{stats.todayCheckin}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-emerald-200 p-3.5 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-1 h-full bg-emerald-500" />
            <div className="pl-2">
              <p className="text-xs text-emerald-600">今日退房</p>
              <p className="text-2xl font-bold text-emerald-700 mt-0.5">{stats.todayCheckout}</p>
            </div>
          </div>
          <div className="bg-white rounded-xl border border-slate-200 p-3.5">
            <p className="text-xs text-slate-500 mb-1.5">渠道分布</p>
            <div className="flex flex-wrap gap-1">
              {stats.channelBreakdown.slice(0, 4).map(ch => (
                <span key={ch.name} className={`text-white text-[10px] px-1.5 py-0.5 rounded ${ch.color}`}>
                  {ch.name.slice(0, 2)} {ch.count}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      <TabBar tabs={tabs} activeKey={activeTab} onChange={(t: string) => setActiveTab(t)} />

      {/* ============ ALL ORDERS TAB ============ */}
      {activeTab === 'all' && (
        <div className="space-y-4">
          {/* Filters */}
          <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3 flex-wrap">
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
              <input
                className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                placeholder="搜索订单号/客人姓名/手机号"
                value={filterKeyword}
                onChange={e => setFilterKeyword(e.target.value)}
              />
            </div>
            <select
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              value={filterChannel}
              onChange={e => setFilterChannel(e.target.value)}
            >
              <option value="">全部渠道</option>
              {channelList.map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
            </select>
            <select
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              value={filterStatus}
              onChange={e => setFilterStatus(e.target.value)}
            >
              <option value="">全部状态</option>
              <option value="pending_confirm">待确认</option><option value="confirmed">已确认</option>
              <option value="checked_in">已入住</option><option value="checked_out">已退房</option>
              <option value="cancelled">已取消</option><option value="no_show">未到店</option>
            </select>
            <span className="text-sm text-slate-500">共 {total} 条</span>
          </div>

          {/* Orders Table */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">订单号</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">渠道</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">客人</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">入住/离店</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">房型/房号</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">金额</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">支付</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">状态</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {orders.map(order => {
                  const os = statusMap[order.status] || { label: order.status, type: 'default' as const };
                  const ps = paymentStatusMap[order.paymentStatus] || { label: order.paymentStatus, type: 'default' as const };
                  return (
                    <tr key={order.id} className={`hover:bg-slate-50/50 ${isOtaUrgent(order) ? 'bg-red-50/30' : ''}`}>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-mono text-slate-700">{order.orderNo}</span>
                          {isOtaUrgent(order) && <Timer className="w-3.5 h-3.5 text-red-500" />}
                        </div>
                        {order.otaTimeout && (
                          <span className="text-[10px] text-red-500">剩余{order.otaTimeout}分钟</span>
                        )}
                      </td>
                      <td className="px-4 py-3">
                        <span className={`inline-flex items-center gap-1 text-slate-700 text-xs px-2 py-0.5 rounded bg-slate-100`}>
                          {channelLabels[order.channel] || order.channel}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-slate-700">{order.guestName}</div>
                        <div className="text-xs text-slate-400">{order.guestPhone}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-slate-600">{order.checkIn}</div>
                        <div className="text-xs text-slate-400">{order.checkOut} ({order.nights}晚)</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-slate-600">{order.roomType}</div>
                        <div className="text-xs text-slate-400">{order.roomNumber}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-slate-800">¥{order.amount}</div>
                        {order.discount && <div className="text-[10px] text-emerald-600">{order.discount}</div>}
                      </td>
                      <td className="px-4 py-3"><StatusBadge label={ps.label} type={ps.type} /></td>
                      <td className="px-4 py-3"><StatusBadge label={os.label} type={os.type} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <button onClick={() => handleViewDetail(order.id)} className="text-sm text-emerald-600 hover:underline">详情</button>
                          {(order.status === 'pending' || order.status === 'pending_confirm') && (
                            <>
                              <button onClick={() => handleConfirm(order.id)} className="text-sm text-blue-600 hover:underline">确认</button>
                              <button onClick={() => setCancelOrderId(order.id)} className="text-sm text-red-500 hover:underline">拒绝</button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            {/* 分页组件 */}
            {totalPages > 1 && (
              <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-center">
                <Pagination>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        onClick={() => setPage(p => Math.max(1, p - 1))}
                        className={page <= 1 ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                      />
                    </PaginationItem>
                    {Array.from({ length: Math.min(totalPages, 7) }, (_, i) => {
                      let pageNum: number;
                      if (totalPages <= 7) {
                        pageNum = i + 1;
                      } else if (page <= 4) {
                        pageNum = i + 1;
                      } else if (page >= totalPages - 3) {
                        pageNum = totalPages - 6 + i;
                      } else {
                        pageNum = page - 3 + i;
                      }
                      return (
                        <PaginationItem key={pageNum}>
                          <PaginationLink
                            isActive={pageNum === page}
                            onClick={() => setPage(pageNum)}
                            className="cursor-pointer"
                          >
                            {pageNum}
                          </PaginationLink>
                        </PaginationItem>
                      );
                    })}
                    <PaginationItem>
                      <PaginationNext
                        onClick={() => setPage(p => Math.min(totalPages, p + 1))}
                        className={page >= totalPages ? 'pointer-events-none opacity-50' : 'cursor-pointer'}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </div>
        </div>
      )}

      {/* ============ CHANNEL PENDING TAB ============ */}
      {activeTab === 'pending' && (
        <div className="space-y-4">
          {/* Batch actions bar */}
          {selectedIds.length > 0 && (
            <div className="bg-blue-50 border border-blue-200 rounded-xl px-4 py-3 flex items-center justify-between">
              <span className="text-sm text-blue-700">已选择 {selectedIds.length} 个订单</span>
              <div className="flex items-center gap-2">
                <button
                  onClick={handleBatchConfirm}
                  disabled={batchLoading}
                  className="px-4 py-1.5 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:bg-emerald-600 disabled:opacity-50"
                >
                  {batchLoading ? '处理中...' : '批量确认'}
                </button>
                <button onClick={() => setSelectedIds([])} className="px-4 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm">
                  取消选择
                </button>
              </div>
            </div>
          )}

          {/* Channel groups */}
          {channelGroups.length === 0 ? (
            <div className="bg-white rounded-xl border border-slate-200 p-12 text-center">
              <CheckCircle2 className="w-12 h-12 text-emerald-400 mx-auto mb-3" />
              <p className="text-slate-600 font-medium">所有渠道订单已处理</p>
              <p className="text-sm text-slate-400 mt-1">暂无待确认的OTA订单</p>
            </div>
          ) : (
            channelGroups.map(group => {
              const groupIds = group.orders.map(o => o.id);
              const allSelected = groupIds.every(id => selectedIds.includes(id));
              return (
                <div key={group.name} className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  {/* Channel header */}
                  <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <span className={`inline-flex items-center gap-1.5 text-white text-sm px-3 py-1 rounded-lg ${group.color}`}>
                        <span className="text-base">{group.icon}</span> {group.name}
                      </span>
                      <span className="text-sm text-slate-500">{group.count}单待确认</span>
                      {group.urgentCount > 0 && (
                        <span className="flex items-center gap-1 text-xs text-red-600 bg-red-50 px-2 py-0.5 rounded-full">
                          <AlertTriangle className="w-3 h-3" /> {group.urgentCount}单即将超时
                        </span>
                      )}
                    </div>
                    <div className="flex items-center gap-2">
                      <label className="flex items-center gap-1.5 text-sm text-slate-500 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={allSelected}
                          onChange={() => toggleSelectAll(groupIds)}
                          className="rounded border-slate-300 text-emerald-500 focus:ring-emerald-500/20"
                        />
                        全选
                      </label>
                      <button
                        onClick={() => { toggleSelectAll(groupIds); if (!allSelected && selectedIds.length === 0) handleBatchConfirm(); }}
                        className="text-sm text-emerald-600 hover:underline font-medium"
                      >
                        一键确认
                      </button>
                    </div>
                  </div>

                  {/* Orders in this channel */}
                  <div className="divide-y divide-slate-50">
                    {group.orders.map(order => (
                      <div key={order.id} className={`px-5 py-3.5 flex items-center gap-4 hover:bg-slate-50/50 ${isOtaUrgent(order) ? 'bg-red-50/40' : ''}`}>
                        <input
                          type="checkbox"
                          checked={selectedIds.includes(order.id)}
                          onChange={() => toggleSelect(order.id)}
                          className="rounded border-slate-300 text-emerald-500 focus:ring-emerald-500/20"
                        />
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-2">
                            <span className="text-sm font-medium text-slate-700">{order.guestName}</span>
                            <span className="text-xs text-slate-400">{order.guestPhone}</span>
                            {isOtaUrgent(order) && (
                              <span className="flex items-center gap-0.5 text-[10px] text-red-600 bg-red-50 px-1.5 py-0.5 rounded-full font-medium">
                                <Timer className="w-3 h-3" /> {order.otaTimeout}min
                              </span>
                            )}
                          </div>
                          <div className="flex items-center gap-3 mt-1 text-xs text-slate-500">
                            <span className="flex items-center gap-1"><CalendarDays className="w-3 h-3" /> {order.checkIn} → {order.checkOut} ({order.nights}晚)</span>
                            <span className="flex items-center gap-1"><BedDouble className="w-3 h-3" /> {order.roomType} {order.roomNumber}</span>
                            {order.remark && <span className="text-amber-600">备注: {order.remark}</span>}
                          </div>
                        </div>
                        <div className="text-right shrink-0">
                          <div className="text-sm font-semibold text-slate-800">¥{order.amount}</div>
                          {order.discount && <div className="text-[10px] text-emerald-600">{order.discount}</div>}
                        </div>
                        <div className="shrink-0">
                          {order.paymentStatus === 'paid' ? (
                            <StatusBadge label="已付" type="success" />
                          ) : (
                            <StatusBadge label="未付" type="danger" />
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            onClick={() => handleConfirm(order.id)}
                            className="px-3 py-1.5 bg-emerald-500 text-white rounded-lg text-xs font-medium hover:bg-emerald-600"
                          >
                            确认
                          </button>
                          <button
                            onClick={() => setCancelOrderId(order.id)}
                            className="px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-xs hover:bg-slate-50"
                          >
                            拒绝
                          </button>
                          <button
                            onClick={() => handleViewDetail(order.id)}
                            className="px-3 py-1.5 bg-white border border-slate-200 text-slate-500 rounded-lg text-xs hover:bg-slate-50"
                          >
                            详情
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              );
            })
          )}
        </div>
      )}

      {/* ============ CREATE ORDER MODAL ============ */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setShowCreateModal(false); setCreateSuccess(false); setFormErrors({}); }}>
          <div className="bg-white rounded-2xl w-[680px] h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
              <h3 className="text-lg font-semibold text-slate-800">新建订单</h3>
              <button onClick={() => { setShowCreateModal(false); setCreateSuccess(false); setFormErrors({}); }} className="text-slate-400 hover:text-slate-600 transition-colors">
                <X className="w-5 h-5" />
              </button>
            </div>
            {/* Content */}
            <div className="flex-1 overflow-y-auto min-h-0 px-6 py-5">
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">客户姓名 <span className="text-red-500">*</span></label>
                    <input
                      className={`w-full px-4 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${formErrors.guestName ? 'border-red-300' : 'border-slate-200'}`}
                      placeholder="请输入客户姓名"
                      value={createForm.guestName}
                      onChange={e => { setCreateForm(f => ({ ...f, guestName: e.target.value })); if (formErrors.guestName) setFormErrors(prev => { const next = { ...prev }; delete next.guestName; return next; }); }}
                    />
                    {formErrors.guestName && <p className="text-red-500 text-xs mt-1">{formErrors.guestName}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">手机号</label>
                    <input
                      className={`w-full px-4 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${formErrors.guestPhone ? 'border-red-300' : 'border-slate-200'}`}
                      placeholder="请输入手机号"
                      value={createForm.guestPhone}
                      onChange={e => { setCreateForm(f => ({ ...f, guestPhone: e.target.value })); if (formErrors.guestPhone) setFormErrors(prev => { const next = { ...prev }; delete next.guestPhone; return next; }); }}
                    />
                    {formErrors.guestPhone && <p className="text-red-500 text-xs mt-1">{formErrors.guestPhone}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">入住日期 <span className="text-red-500">*</span></label>
                    <input
                      type="date"
                      className={`w-full px-4 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${formErrors.checkIn ? 'border-red-300' : 'border-slate-200'}`}
                      value={createForm.checkIn}
                      onChange={e => { setCreateForm(f => ({ ...f, checkIn: e.target.value })); if (formErrors.checkIn) setFormErrors(prev => { const next = { ...prev }; delete next.checkIn; return next; }); }}
                    />
                    {formErrors.checkIn && <p className="text-red-500 text-xs mt-1">{formErrors.checkIn}</p>}
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">离店日期 <span className="text-red-500">*</span></label>
                    <input
                      type="date"
                      className={`w-full px-4 py-2.5 border rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 ${formErrors.checkOut ? 'border-red-300' : 'border-slate-200'}`}
                      value={createForm.checkOut}
                      onChange={e => { setCreateForm(f => ({ ...f, checkOut: e.target.value })); if (formErrors.checkOut) setFormErrors(prev => { const next = { ...prev }; delete next.checkOut; return next; }); }}
                    />
                    {formErrors.checkOut && <p className="text-red-500 text-xs mt-1">{formErrors.checkOut}</p>}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">房型</label>
                    <select
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      value={createForm.roomType}
                      onChange={e => setCreateForm(f => ({ ...f, roomType: e.target.value, roomNumber: '', roomId: '' }))}
                    >
                      <option value="">请选择房型</option>
                      {availableRoomTypes.map(rt => (
                        <option key={rt} value={rt}>{rt}</option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">房间号</label>
                    <select
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      value={createForm.roomId}
                      onChange={e => {
                        const selected = availableRooms.find(r => r.id === e.target.value);
                        setCreateForm(f => ({ ...f, roomId: e.target.value, roomNumber: selected?.roomNumber || '', roomTypeId: selected?.roomTypeId || '' }));
                      }}
                    >
                      <option value="">请选择房间</option>
                      {availableRooms
                        .filter(r => !createForm.roomType || r.roomType === createForm.roomType)
                        .map(r => (
                          <option key={r.id} value={r.id}>{r.roomNumber}</option>
                        ))
                      }
                    </select>
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">预订渠道</label>
                    <select
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      value={createForm.channel}
                      onChange={e => setCreateForm(f => ({ ...f, channel: e.target.value }))}
                    >
                      <option value="到店">到店</option>
                      {channelList.filter(c => c.name !== '到店').map(c => <option key={c.name} value={c.name}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">房价（元）</label>
                    <input
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      placeholder="¥298"
                      value={createForm.amount}
                      onChange={e => setCreateForm(f => ({ ...f, amount: e.target.value }))}
                    />
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="block text-sm font-medium text-slate-700 mb-1.5">支付方式</label>
                    <select
                      className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                      value={createForm.paymentMethod}
                      onChange={e => setCreateForm(f => ({ ...f, paymentMethod: e.target.value }))}
                    >
                      <option>到店付</option><option>现金</option><option>微信</option>
                      <option>支付宝</option><option>银行卡</option><option>对公转账</option>
                    </select>
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">备注</label>
                  <textarea
                    rows={3}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none"
                    placeholder="备注信息"
                    value={createForm.remark}
                    onChange={e => setCreateForm(f => ({ ...f, remark: e.target.value }))}
                  />
                </div>
              </div>
            </div>
            {/* Footer */}
            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between shrink-0">
              {createSuccess ? (
                <div className="flex items-center gap-2 text-sm text-emerald-600">
                  <CheckCircle2 className="w-4 h-4" /> 订单创建成功！
                </div>
              ) : (
                <span className="text-xs text-slate-400">* 为必填项</span>
              )}
              <div className="flex gap-3">
                <button
                  onClick={() => { setCreateForm({ guestName: '', guestPhone: '', checkIn: '', checkOut: '', roomType: '', roomTypeId: '', roomNumber: '', roomId: '', channel: '到店', amount: '', source: 'walk_in', paymentMethod: '到店付', remark: '' }); setFormErrors({}); }}
                  className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50"
                >
                  重置
                </button>
                <button
                  onClick={handleCreate}
                  disabled={createLoading || !createForm.guestName || !createForm.checkIn || !createForm.checkOut}
                  className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50"
                >
                  {createLoading ? '创建中...' : '创建订单'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ ORDER DETAIL MODAL ============ */}
      {detailOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDetailOrder(null)}>
          <div className="bg-white rounded-2xl w-[720px] max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold text-slate-800">订单详情</h3>
                <span className={`text-white text-xs px-2.5 py-0.5 rounded ${detailOrder.channelInfo?.color}`}>
                  {detailOrder.channel}
                </span>
                <span className={`text-xs px-2.5 py-0.5 rounded ${detailOrder.statusInfo?.color}`}>
                  {detailOrder.statusInfo?.label}
                </span>
              </div>
              {detailOrder.source === 'platform' && (
                <button
                  type="button"
                  onClick={() => { setDetailOrder(null); router.push('/orders/product'); }}
                  className="ml-auto text-xs text-blue-600 hover:text-blue-700 whitespace-nowrap"
                >
                  查看平台套餐订单 →
                </button>
              )}
              <button onClick={() => setDetailOrder(null)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            {/* Content */}
            <div className="flex-1 overflow-y-auto p-6 space-y-5">
              {/* Order basic info */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 rounded-xl p-4 space-y-2.5">
                  <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><FileText className="w-4 h-4" /> 订单信息</h4>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">订单号</span><span className="font-mono text-slate-700">{detailOrder.orderNo}</span></div>
                    {detailOrder.source !== 'platform' && <div className="flex justify-between"><span className="text-slate-500">渠道订单号</span><span className="text-slate-700">{detailOrder.otaOrderId || '-'}</span></div>}
                    {detailOrder.platformOrderNo && <div className="flex justify-between"><span className="text-slate-500">平台订单号</span><span className="text-slate-700">{detailOrder.platformOrderNo}</span></div>}
                    {detailOrder.verifyCode && <div className="flex justify-between"><span className="text-slate-500">核销码</span><span className="font-mono text-slate-700">{detailOrder.verifyCode}</span></div>}
                    <div className="flex justify-between"><span className="text-slate-500">来源</span><span className="text-slate-700">{sourceLabels[detailOrder.source] || detailOrder.source}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">创建时间</span><span className="text-slate-700">{detailOrder.createdAt}</span></div>
                    {detailOrder.confirmedAt && <div className="flex justify-between"><span className="text-slate-500">确认时间</span><span className="text-slate-700">{detailOrder.confirmedAt}</span></div>}
                  </div>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 space-y-2.5">
                  <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><User className="w-4 h-4" /> 客人信息</h4>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">姓名</span><span className="text-slate-700">{detailOrder.guestName}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">手机</span><span className="text-slate-700">{detailOrder.guestPhone}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">入住</span><span className="text-slate-700">{detailOrder.checkIn}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">离店</span><span className="text-slate-700">{detailOrder.checkOut} ({detailOrder.nights}晚)</span></div>
                  </div>
                </div>
              </div>

              {/* Room & Price */}
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 rounded-xl p-4 space-y-2.5">
                  <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><BedDouble className="w-4 h-4" /> 房间信息</h4>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">房型</span><span className="text-slate-700">{detailOrder.roomType}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">房号</span><span className="text-slate-700">{detailOrder.roomNumber}</span></div>
                  </div>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 space-y-2.5">
                  <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><DollarSign className="w-4 h-4" /> 费用信息</h4>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">订单金额</span><span className="font-semibold text-slate-800">¥{detailOrder.amount}</span></div>
                    {detailOrder.originalAmount && <div className="flex justify-between"><span className="text-slate-500">原价</span><span className="text-slate-400 line-through">¥{detailOrder.originalAmount}</span></div>}
                    {detailOrder.discount && <div className="flex justify-between"><span className="text-slate-500">优惠</span><span className="text-emerald-600">{detailOrder.discount}</span></div>}
                    <div className="flex justify-between"><span className="text-slate-500">支付状态</span>
                      <StatusBadge label={paymentStatusMap[detailOrder.paymentStatus]?.label || ''} type={paymentStatusMap[detailOrder.paymentStatus]?.type || 'default'} />
                    </div>
                    <div className="flex justify-between"><span className="text-slate-500">支付方式</span><span className="text-slate-700">{detailOrder.paymentMethod || '-'}</span></div>
                  </div>
                </div>
              </div>

              {/* Extras */}
              {detailOrder.extras && detailOrder.extras.length > 0 && (
                <div className="bg-amber-50 rounded-xl p-4 space-y-2">
                  <h4 className="text-sm font-medium text-amber-700">附加项目</h4>
                  {detailOrder.extras.map((extra, i) => (
                    <div key={i} className="flex justify-between text-sm">
                      <span className="text-amber-600">{extra.name}</span>
                      <span className="text-amber-700 font-medium">¥{extra.amount}</span>
                    </div>
                  ))}
                </div>
              )}

              {/* Remark */}
              {detailOrder.remark && (
                <div className="bg-blue-50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-blue-700 mb-1">备注</h4>
                  <p className="text-sm text-blue-600">{detailOrder.remark}</p>
                </div>
              )}

              {/* Cancel info */}
              {detailOrder.cancelReason && (
                <div className="bg-red-50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-red-700 mb-1">取消原因</h4>
                  <p className="text-sm text-red-600">{detailOrder.cancelReason}</p>
                </div>
              )}

              {/* Timeline */}
              {detailOrder.timeline && detailOrder.timeline.length > 0 && (
                <div>
                  <h4 className="text-sm font-medium text-slate-700 mb-3">订单进度</h4>
                  <div className="space-y-3">
                    {detailOrder.timeline.map((item, i) => (
                      <div key={i} className="flex items-start gap-3">
                        <div className="flex flex-col items-center">
                          <div className={`w-2.5 h-2.5 rounded-full ${i === detailOrder.timeline.length - 1 ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                          {i < detailOrder.timeline.length - 1 && <div className="w-px h-6 bg-slate-200" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center justify-between">
                            <span className="text-sm font-medium text-slate-700">{item.label}</span>
                            <span className="text-xs text-slate-400">{item.time}</span>
                          </div>
                          <p className="text-xs text-slate-500 mt-0.5">{item.desc}</p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>

            {/* Footer actions */}
            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                {detailOrder.guestPhone && (
                  <>
                    <a href={`tel:${detailOrder.guestPhone}`} className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm hover:bg-slate-50">
                      <Phone className="w-3.5 h-3.5" /> 拨打电话
                    </a>
                    <a href={`sms:${detailOrder.guestPhone}`} className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm hover:bg-slate-50">
                      <MessageSquare className="w-3.5 h-3.5" /> 发短信
                    </a>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {(detailOrder.status === 'pending' || detailOrder.status === 'pending_confirm') && (
                  <>
                    <button
                      onClick={() => { handleConfirm(detailOrder.id); setDetailOrder(null); }}
                      className="px-4 py-1.5 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:bg-emerald-600"
                    >
                      确认订单
                    </button>
                    <button
                      onClick={() => { setCancelOrderId(detailOrder.id); setDetailOrder(null); }}
                      className="px-4 py-1.5 bg-white border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50"
                    >
                      拒绝订单
                    </button>
                  </>
                )}
                {detailOrder.status === 'confirmed' && (
                  <button
                    onClick={() => { handleConfirm(detailOrder.id); setDetailOrder(null); }}
                    className="px-4 py-1.5 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600"
                  >
                    办理入住
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ CANCEL MODAL ============ */}
      {cancelOrderId && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setCancelOrderId(null)}>
          <div className="bg-white rounded-2xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-2">拒绝订单</h3>
            <p className="text-sm text-slate-500 mb-4">拒绝后订单将被取消并自动释放房间，请填写拒绝原因</p>
            <textarea
              rows={3}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 resize-none mb-4"
              placeholder="请输入拒绝原因"
              value={cancelReason}
              onChange={e => setCancelReason(e.target.value)}
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => { setCancelOrderId(null); setCancelReason(''); }} className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm hover:bg-slate-50">
                取消
              </button>
              <button onClick={handleCancel} className="px-4 py-2 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600">
                确认拒绝
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
