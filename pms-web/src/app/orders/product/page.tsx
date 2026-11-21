'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { apiGet, apiPost, apiPut } from '@/lib/api-client';
import {
  ClipboardList, Search, RefreshCw, Package, User, CalendarDays,
  Wallet, Settings2, CheckCircle2, XCircle, X, Phone, MessageSquare,
} from 'lucide-react';

// --- 平台套餐订单（转发 pms-platform） ---
interface PlatformOrder {
  id: string;
  orderNo: string;
  storeId: string;
  productId: string;
  productName: string | null;
  productType: string | null;
  guestName: string;
  guestPhone: string;
  roomNights: number | null;
  quantity: number | null;
  totalAmount: string;
  originalPrice: string | null;
  sellingPrice: string | null;
  status: string;
  paymentStatus: string;
  mode: string | null;            // A=订金 B=全款
  depositAmount: string | null;
  balanceAmount: string | null;
  balancePaidAt: string | null;
  cancelPolicy: string | null;
  reservationStatus: string | null;
  reservationDate: string | null;
  storeAcceptedAt: string | null;
  usedAt: string | null;
  verifyCode: string | null;    // 核销码（已核销订单）
  refundedAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  remark: string | null;
}

// 状态映射（民宿端可见的状态）
const statusMap: Record<string, { label: string; type: 'success' | 'warning' | 'danger' | 'info' | 'default' }> = {
  platform_approved: { label: '待接单', type: 'warning' },
  store_accepted: { label: '已接单', type: 'info' },
  used: { label: '已核销', type: 'success' },
  refunded: { label: '已退款', type: 'danger' },
  paid: { label: '待预约', type: 'default' },
  pending: { label: '待支付', type: 'default' },
  cancelled: { label: '已取消', type: 'danger' },
};

const paymentStatusMap: Record<string, { label: string; type: 'success' | 'warning' | 'danger' | 'info' }> = {
  paid: { label: '已支付', type: 'success' },
  unpaid: { label: '未支付', type: 'danger' },
};

const modeLabel: Record<string, string> = { A: '订金', B: '全款' };

// 格式化时间（ISO 转本地 YYYY-MM-DD HH:mm）
const formatTime = (v?: string | null) => {
  if (!v) return '-';
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return v;
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

const filterOptions = [
  { value: '', label: '全部状态' },
  { value: 'platform_approved', label: '待接单' },
  { value: 'store_accepted', label: '已接单' },
  { value: 'used', label: '已核销' },
  { value: 'refunded', label: '已退款' },
];

export default function ProductOrdersPage() {
  const router = useRouter();
  const [orders, setOrders] = useState<PlatformOrder[]>([]);
  const [loading, setLoading] = useState(true);
  const [filterKeyword, setFilterKeyword] = useState('');
  const [filterStatus, setFilterStatus] = useState('');
  const [page, setPage] = useState(1);
  const [limit] = useState(20);
  const [total, setTotal] = useState(0);
  const [totalPages, setTotalPages] = useState(0);

  // 视图模式：orders=订单管理，records=核销记录（聚焦已核销订单，纯查看）
  const [viewMode, setViewMode] = useState<'orders' | 'records'>('orders');
  const isRecordsView = viewMode === 'records';

  // 详情 / 操作
  const [detailOrder, setDetailOrder] = useState<PlatformOrder | null>(null);
  const [actionLoading, setActionLoading] = useState(false);
  const [rejectOrder, setRejectOrder] = useState<PlatformOrder | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [useOrder, setUseOrder] = useState<PlatformOrder | null>(null);
  const [useVerifyCode, setUseVerifyCode] = useState('');
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const qs = new URLSearchParams();
      qs.set('page', String(page));
      qs.set('limit', String(limit));
      if (filterKeyword) qs.set('keyword', filterKeyword);
      // 核销记录视图固定筛选已核销（used）状态
      const statusParam = viewMode === 'records' ? 'used' : filterStatus;
      if (statusParam) qs.set('status', statusParam);
      const res = await apiGet(`/api/store/product-orders?${qs.toString()}`);
      const list: PlatformOrder[] = res.list || res.data || [];
      setOrders(list);
      setTotal(res.total ?? list.length);
      setTotalPages(Math.ceil((res.total ?? list.length) / limit));
    } catch (e: any) {
      setOrders([]);
      showToast(e?.message || '加载失败');
    }
    setLoading(false);
  }, [page, limit, filterKeyword, filterStatus, viewMode]);

  useEffect(() => { fetchData(); }, [fetchData]);
  useEffect(() => { setPage(1); }, [filterStatus, filterKeyword, viewMode]);

  const refresh = () => {
    fetchData();
    setDetailOrder(null);
  };

  const handleViewDetail = async (orderId: string) => {
    try {
      const res = await apiGet(`/api/store/product-orders/${orderId}`);
      setDetailOrder(res.data || res);
    } catch (e: any) {
      showToast(e?.message || '加载详情失败');
    }
  };

  const handleAccept = async (order: PlatformOrder) => {
    setActionLoading(true);
    try {
      await apiPost(`/api/store/product-orders/${order.id}/accept`);
      showToast('已接单');
      refresh();
    } catch (e: any) { showToast(e?.message || '接单失败'); }
    setActionLoading(false);
  };

  const handleReject = async () => {
    if (!rejectOrder) return;
    setActionLoading(true);
    try {
      await apiPost(`/api/store/product-orders/${rejectOrder.id}/reject`, { reason: rejectReason || '民宿拒单' });
      showToast('已拒单');
      setRejectOrder(null);
      setRejectReason('');
      refresh();
    } catch (e: any) { showToast(e?.message || '拒单失败'); }
    setActionLoading(false);
  };

  const handlePayBalance = async (order: PlatformOrder) => {
    setActionLoading(true);
    try {
      await apiPut(`/api/store/product-orders/${order.id}/pay-balance`);
      showToast('尾款已登记');
      refresh();
    } catch (e: any) { showToast(e?.message || '补尾款失败'); }
    setActionLoading(false);
  };

  // 核销：先弹窗提示输入客人核销码（可选填），随 body 透传平台校验；不传则平台跳过校验（存量订单无码兜底）
  const handleUse = async (verifyCode?: string) => {
    if (!useOrder) return;
    setActionLoading(true);
    try {
      await apiPut(`/api/store/product-orders/${useOrder.id}/use`, { verifyCode: verifyCode || undefined });
      showToast('核销成功');
      setUseOrder(null);
      setUseVerifyCode('');
      refresh();
    } catch (e: any) { showToast(e?.message || '核销失败'); }
    setActionLoading(false);
  };

  const isModeAUnpaid = (order: PlatformOrder) => order.mode === 'A' && !order.balancePaidAt;

  // 民宿可否直接拒单：预约已确认(reservationStatus=confirmed)或已接单(status=store_accepted)的订单
  // 在平台端不可退（需平台客服人工处理）→ 隐藏拒单按钮，避免死按钮。
  const isRejectable = (order: PlatformOrder) => order.reservationStatus !== 'confirmed' && order.status !== 'store_accepted';

  return (
    <div className="space-y-5">
      <PageHeader
        title="平台套餐订单"
        subtitle={isRecordsView ? '已核销订单历史记录（核销时间 / 核销码）' : '私域套餐订单接单 / 补尾款 / 核销（仅显示已预约或已接单订单）'}
        icon={<Package className="w-5 h-5" />}
        actions={[
          {
            label: '套餐配置',
            icon: <Settings2 className="w-4 h-4" />,
            onClick: () => router.push('/orders/product-config'),
          },
        ]}
      />

      {/* 视图切换：订单管理 / 核销记录 */}
      <div className="bg-white rounded-xl border border-slate-200 p-1.5 inline-flex items-center gap-1">
        <button
          onClick={() => { setViewMode('orders'); setPage(1); }}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${!isRecordsView ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}
        >
          订单管理
        </button>
        <button
          onClick={() => { setViewMode('records'); setPage(1); }}
          className={`px-4 py-1.5 rounded-lg text-sm font-medium transition-colors ${isRecordsView ? 'bg-emerald-50 text-emerald-700' : 'text-slate-500 hover:bg-slate-50'}`}
        >
          核销记录
        </button>
      </div>

      {/* 筛选栏 */}
      <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3 flex-wrap">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            placeholder="搜索订单号/客人姓名/手机号"
            value={filterKeyword}
            onChange={e => setFilterKeyword(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') setPage(1); }}
          />
        </div>
        {!isRecordsView ? (
          <select
            className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            value={filterStatus}
            onChange={e => setFilterStatus(e.target.value)}
          >
            {filterOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <span className="px-3 py-2 rounded-lg text-sm bg-emerald-50 text-emerald-700 inline-flex items-center gap-1.5">
            <CheckCircle2 className="w-3.5 h-3.5" /> 已核销记录
          </span>
        )}
        <button
          onClick={() => { setPage(1); fetchData(); }}
          className="px-3 py-2 border border-slate-200 rounded-lg text-sm text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1.5"
        >
          <RefreshCw className="w-3.5 h-3.5" /> 刷新
        </button>
        <span className="text-sm text-slate-500">共 {total} 条</span>
      </div>

      {/* 订单表格 */}
      <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
        <table className="w-full">
          <thead className="bg-slate-50">
            <tr>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">订单号</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">套餐</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">客人</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">预约入住</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">金额</th>
              {!isRecordsView && <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">模式</th>}
              {!isRecordsView && <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">支付</th>}
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">核销时间</th>
              <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">状态</th>
              {!isRecordsView && <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">操作</th>}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {orders.map(order => {
              const os = statusMap[order.status] || { label: order.status, type: 'default' as const };
              const ps = paymentStatusMap[order.paymentStatus] || { label: order.paymentStatus, type: 'default' as const };
              return (
                <tr key={order.id} className="hover:bg-slate-50/50">
                  <td className="px-4 py-3">
                    <span className="text-sm font-mono text-slate-700">{order.orderNo}</span>
                    <div className="text-[10px] text-slate-400">{order.id}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-slate-700">{order.productName || '-'}</div>
                    {order.quantity ? <div className="text-xs text-slate-400">x{order.quantity} 份 · {order.roomNights || 1}晚</div> : null}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-slate-700">{order.guestName}</div>
                    <div className="text-xs text-slate-400">{order.guestPhone}</div>
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm text-slate-600">{order.reservationDate || '-'}</div>
                    {order.reservationStatus && <div className="text-[10px] text-slate-400">已预约</div>}
                  </td>
                  <td className="px-4 py-3">
                    <div className="text-sm font-medium text-slate-800">¥{Number(order.totalAmount) || 0}</div>
                    {isModeAUnpaid(order) && (
                      <div className="text-[10px] text-amber-600">尾款 ¥{Number(order.balanceAmount) || 0} 未补</div>
                    )}
                  </td>
                  {!isRecordsView && (
                    <td className="px-4 py-3">
                      <span className="text-xs px-2 py-0.5 rounded bg-violet-50 text-violet-700">
                        {modeLabel[order.mode || 'B'] || order.mode || '-'}
                      </span>
                    </td>
                  )}
                  {!isRecordsView && (
                    <td className="px-4 py-3"><StatusBadge label={ps.label} type={ps.type} /></td>
                  )}
                  <td className="px-4 py-3">
                    <div className="text-sm text-slate-600">{formatTime(order.usedAt)}</div>
                    {order.status === 'used' && order.verifyCode && (
                      <div className="text-xs text-slate-400">核销码 {order.verifyCode}</div>
                    )}
                  </td>
                  <td className="px-4 py-3"><StatusBadge label={os.label} type={os.type} /></td>
                  {!isRecordsView && (
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2">
                        <button onClick={() => handleViewDetail(order.id)} className="text-sm text-emerald-600 hover:underline">详情</button>
                        {order.status === 'platform_approved' && (
                          <>
                            <button
                              onClick={() => handleAccept(order)}
                              disabled={actionLoading}
                              className="text-sm text-blue-600 hover:underline disabled:opacity-50"
                            >
                              接单
                            </button>
                            {isRejectable(order) ? (
                              <button
                                onClick={() => setRejectOrder(order)}
                                className="text-sm text-red-500 hover:underline"
                              >
                                拒单
                              </button>
                            ) : (
                              <span
                                className="text-xs text-slate-400 cursor-help"
                                title="预约已确认/已锁房，拒单需联系平台客服"
                              >
                                拒单需联系平台
                              </span>
                            )}
                          </>
                        )}
                        {order.status === 'store_accepted' && (
                          <>
                            {isModeAUnpaid(order) && (
                              <button
                                onClick={() => handlePayBalance(order)}
                                disabled={actionLoading}
                                className="text-sm text-amber-600 hover:underline disabled:opacity-50"
                              >
                                补尾款
                              </button>
                            )}
                            <button
                              onClick={() => setUseOrder(order)}
                              disabled={actionLoading || isModeAUnpaid(order)}
                              className="text-sm text-emerald-600 hover:underline disabled:opacity-40"
                              title={isModeAUnpaid(order) ? '订金模式需先补尾款' : '核销订单'}
                            >
                              核销
                            </button>
                          </>
                        )}
                      </div>
                    </td>
                  )}
                </tr>
              );
            })}
            {orders.length === 0 && !loading && (
              <tr>
                <td colSpan={isRecordsView ? 7 : 10} className="px-4 py-16 text-center">
                  <CheckCircle2 className="w-12 h-12 text-slate-300 mx-auto mb-3" />
                  <p className="text-slate-500 font-medium">暂无平台套餐订单</p>
                  <p className="text-sm text-slate-400 mt-1">{isRecordsView ? '已核销的订单会显示在这里' : '已预约或已接单的订单会显示在这里'}</p>
                </td>
              </tr>
            )}
            {loading && (
              <tr>
                <td colSpan={9} className="px-4 py-16 text-center text-slate-400 text-sm">加载中...</td>
              </tr>
            )}
          </tbody>
        </table>
        {/* 分页 */}
        {totalPages > 1 && (
          <div className="px-4 py-3 border-t border-slate-100 flex items-center justify-center gap-3">
            <button
              onClick={() => setPage(p => Math.max(1, p - 1))}
              disabled={page <= 1}
              className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-600 disabled:opacity-40"
            >
              上一页
            </button>
            <span className="text-sm text-slate-500">{page} / {totalPages}</span>
            <button
              onClick={() => setPage(p => Math.min(totalPages, p + 1))}
              disabled={page >= totalPages}
              className="px-3 py-1.5 border border-slate-200 rounded-lg text-sm text-slate-600 disabled:opacity-40"
            >
              下一页
            </button>
          </div>
        )}
      </div>

      {/* ============ 订单详情 ============ */}
      {detailOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setDetailOrder(null)}>
          <div className="bg-white rounded-2xl w-[720px] max-h-[85vh] overflow-hidden flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="px-6 py-4 border-b border-slate-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-3">
                <h3 className="text-lg font-semibold text-slate-800">套餐订单详情</h3>
                <StatusBadge label={statusMap[detailOrder.status]?.label || detailOrder.status} type={statusMap[detailOrder.status]?.type || 'default'} />
              </div>
              <button onClick={() => setDetailOrder(null)} className="p-1 hover:bg-slate-100 rounded-lg">
                <X className="w-5 h-5 text-slate-400" />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div className="bg-slate-50 rounded-xl p-4 space-y-2">
                  <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><ClipboardList className="w-4 h-4" /> 订单信息</h4>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">订单号</span><span className="font-mono text-slate-700">{detailOrder.orderNo}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">套餐</span><span className="text-slate-700">{detailOrder.productName || '-'}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">数量/间夜</span><span className="text-slate-700">x{detailOrder.quantity || 1} · {detailOrder.roomNights || 1}晚</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">下单时间</span><span className="text-slate-700">{detailOrder.createdAt}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">订单状态</span><span className="text-slate-700">{statusMap[detailOrder.status]?.label || detailOrder.status}</span></div>
                  </div>
                </div>
                <div className="bg-slate-50 rounded-xl p-4 space-y-2">
                  <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><User className="w-4 h-4" /> 客人信息</h4>
                  <div className="space-y-1.5 text-sm">
                    <div className="flex justify-between"><span className="text-slate-500">姓名</span><span className="text-slate-700">{detailOrder.guestName}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">手机</span><span className="text-slate-700">{detailOrder.guestPhone}</span></div>
                    <div className="flex justify-between"><span className="text-slate-500">预约入住</span><span className="text-slate-700">{detailOrder.reservationDate || '-'}</span></div>
                    {detailOrder.storeAcceptedAt && <div className="flex justify-between"><span className="text-slate-500">接单时间</span><span className="text-slate-700">{detailOrder.storeAcceptedAt}</span></div>}
                    {detailOrder.usedAt && <div className="flex justify-between"><span className="text-slate-500">核销时间</span><span className="text-slate-700">{detailOrder.usedAt}</span></div>}
                  </div>
                </div>
              </div>

              <div className="bg-slate-50 rounded-xl p-4 space-y-2">
                <h4 className="text-sm font-medium text-slate-700 flex items-center gap-1.5"><Wallet className="w-4 h-4" /> 费用信息</h4>
                <div className="space-y-1.5 text-sm">
                  <div className="flex justify-between"><span className="text-slate-500">订单金额</span><span className="font-semibold text-slate-800">¥{Number(detailOrder.totalAmount) || 0}</span></div>
                  {detailOrder.mode === 'A' && (
                    <>
                      <div className="flex justify-between"><span className="text-slate-500">已付订金</span><span className="text-slate-700">¥{Number(detailOrder.depositAmount) || 0}</span></div>
                      <div className="flex justify-between">
                        <span className="text-slate-500">尾款</span>
                        <span className={detailOrder.balancePaidAt ? 'text-emerald-600' : 'text-amber-600'}>
                          ¥{Number(detailOrder.balanceAmount) || 0}{detailOrder.balancePaidAt ? '（已补）' : '（未补）'}
                        </span>
                      </div>
                    </>
                  )}
                  <div className="flex justify-between"><span className="text-slate-500">预订模式</span><span className="text-slate-700">{modeLabel[detailOrder.mode || 'B'] || '-'}（{detailOrder.mode || 'B'}）</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">取消政策</span><span className="text-slate-700">{detailOrder.cancelPolicy || '-'}</span></div>
                  <div className="flex justify-between"><span className="text-slate-500">支付状态</span>
                    <StatusBadge label={paymentStatusMap[detailOrder.paymentStatus]?.label || detailOrder.paymentStatus} type={paymentStatusMap[detailOrder.paymentStatus]?.type || 'default'} />
                  </div>
                </div>
              </div>

              {detailOrder.cancelReason && (
                <div className="bg-red-50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-red-700 mb-1">拒单原因</h4>
                  <p className="text-sm text-red-600">{detailOrder.cancelReason}</p>
                </div>
              )}
              {detailOrder.remark && (
                <div className="bg-blue-50 rounded-xl p-4">
                  <h4 className="text-sm font-medium text-blue-700 mb-1">备注</h4>
                  <p className="text-sm text-blue-600">{detailOrder.remark}</p>
                </div>
              )}
            </div>

            <div className="px-6 py-4 border-t border-slate-100 flex items-center justify-between shrink-0">
              <div className="flex items-center gap-2">
                {detailOrder.guestPhone && (
                  <>
                    <a href={`tel:${detailOrder.guestPhone}`} className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm hover:bg-slate-50">
                      <Phone className="w-3.5 h-3.5" /> 打电话
                    </a>
                    <a href={`sms:${detailOrder.guestPhone}`} className="flex items-center gap-1.5 px-3 py-1.5 bg-white border border-slate-200 text-slate-600 rounded-lg text-sm hover:bg-slate-50">
                      <MessageSquare className="w-3.5 h-3.5" /> 发短信
                    </a>
                  </>
                )}
              </div>
              <div className="flex items-center gap-2">
                {detailOrder.status === 'platform_approved' && (
                  <>
                    <button onClick={() => { handleAccept(detailOrder); }} disabled={actionLoading} className="px-4 py-1.5 bg-blue-500 text-white rounded-lg text-sm font-medium hover:bg-blue-600 disabled:opacity-50">
                      接单
                    </button>
                    {isRejectable(detailOrder) ? (
                      <button onClick={() => { setRejectOrder(detailOrder); setDetailOrder(null); }} className="px-4 py-1.5 bg-white border border-red-200 text-red-600 rounded-lg text-sm hover:bg-red-50">
                        拒单
                      </button>
                    ) : (
                      <span className="text-xs text-slate-400 px-1">预约已确认/已锁房，拒单请联系平台客服</span>
                    )}
                  </>
                )}
                {detailOrder.status === 'store_accepted' && (
                  <>
                    {isModeAUnpaid(detailOrder) && (
                      <button onClick={() => handlePayBalance(detailOrder)} disabled={actionLoading} className="px-4 py-1.5 bg-amber-500 text-white rounded-lg text-sm font-medium hover:bg-amber-600 disabled:opacity-50">
                        补尾款
                      </button>
                    )}
                    <button onClick={() => { setUseOrder(detailOrder); setDetailOrder(null); }} disabled={actionLoading || isModeAUnpaid(detailOrder)} className="px-4 py-1.5 bg-emerald-500 text-white rounded-lg text-sm font-medium hover:bg-emerald-600 disabled:opacity-50">
                      核销
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ============ 拒单弹窗 ============ */}
      {rejectOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => setRejectOrder(null)}>
          <div className="bg-white rounded-2xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-2">拒单</h3>
            <p className="text-sm text-slate-500 mb-4">
              拒单后将按取消政策退款。已确认预约/已接单的订单不可由民宿直接退款，请联系平台客服。
            </p>
            <textarea
              rows={3}
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-red-500/20 focus:border-red-500 resize-none mb-4"
              placeholder="请输入拒单原因（可选）"
              value={rejectReason}
              onChange={e => setRejectReason(e.target.value)}
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => { setRejectOrder(null); setRejectReason(''); }} className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm hover:bg-slate-50">
                取消
              </button>
              <button onClick={handleReject} disabled={actionLoading} className="px-4 py-2 bg-red-500 text-white rounded-xl text-sm font-medium hover:bg-red-600 disabled:opacity-50">
                确认拒单
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ============ 核销弹窗（提示输入客人核销码，可选填） ============ */}
      {useOrder && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40" onClick={() => { setUseOrder(null); setUseVerifyCode(''); }}>
          <div className="bg-white rounded-2xl w-[420px] p-6" onClick={e => e.stopPropagation()}>
            <h3 className="text-lg font-semibold text-slate-800 mb-2">核销订单</h3>
            <p className="text-sm text-slate-500 mb-4">
              确认核销套餐「{useOrder.productName || ''}」？核销后不可撤销。请输入客人出示的核销码（可选填）。
            </p>
            <input
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 mb-4"
              placeholder="6位核销码（可选）"
              maxLength={6}
              value={useVerifyCode}
              onChange={e => setUseVerifyCode(e.target.value)}
            />
            <div className="flex justify-end gap-3">
              <button onClick={() => { setUseOrder(null); setUseVerifyCode(''); }} className="px-4 py-2 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm hover:bg-slate-50">
                取消
              </button>
              <button onClick={() => handleUse(useVerifyCode)} disabled={actionLoading} className="px-4 py-2 bg-emerald-500 text-white rounded-xl text-sm font-medium hover:bg-emerald-600 disabled:opacity-50">
                确认核销
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Toast */}
      {toast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[60] bg-slate-800 text-white px-4 py-2 rounded-lg text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}
