'use client';

import { useState, useEffect, useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { toast } from 'sonner';
import { OpsStatsBar } from '@/components/ai-workspace/ops-stats-bar';
import { OpsTimeline } from '@/components/ai-workspace/ops-timeline';
import { AiChatSidebar } from '@/components/ai-workspace/ai-chat-sidebar';
import { AiInsightCard } from '@/components/ai-workspace/ai-insight-card';

export default function OpsPage() {
  const router = useRouter();
  const [briefing, setBriefing] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState('');
  const [cancelTarget, setCancelTarget] = useState<string | null>(null);
  const [assignTarget, setAssignTarget] = useState<string | null>(null);
  const [assigneeName, setAssigneeName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [insights, setInsights] = useState<Array<{ icon: string; title: string; desc: string; actionLabel: string; toolName: string; params: Record<string, any> }>>([]);

  const loadBriefing = useCallback(async () => {
    setLoading(true);
    try {
      // 从常规 API 端点聚合数据
      const [roomsRes, housekeepingRes, ordersRes] = await Promise.all([
        apiGet('/api/rooms?type=daily').catch(() => null),
        apiGet('/api/housekeeping').catch(() => null),
        apiGet('/api/orders?type=channel-pending').catch(() => null),
      ]);

      const roomsData = roomsRes || {};
      const allRooms = roomsData.rooms || [];
      const today = new Date().toISOString().split('T')[0];

      // 解析房间数据为简报各个板块
      const todayCheckins = allRooms.filter((r: any) => r.checkIn === today && r.status === 'booked')
        .map((r: any) => ({ roomId: r.id, roomNumber: r.roomNumber, guestName: r.guestName, guestPhone: r.guestPhone, checkOutDate: r.checkOut }));
      const todayCheckouts = allRooms.filter((r: any) => r.checkOut === today && r.status === 'occupied')
        .map((r: any) => ({ roomId: r.id, roomNumber: r.roomNumber, guestName: r.guestName }));
      const occupiedRooms = allRooms.filter((r: any) => r.status === 'occupied')
        .map((r: any) => ({ roomId: r.id, roomNumber: r.roomNumber, guestName: r.guestName, checkOutDate: r.checkOut }));
      const dirtyRooms = allRooms.filter((r: any) => r.status === 'dirty')
        .map((r: any) => ({ roomId: r.id, roomNumber: r.roomNumber, roomTypeName: r.roomTypeName }));
      const problemRooms = allRooms.filter((r: any) => r.status === 'maintenance' || r.status === 'locked')
        .map((r: any) => ({ roomId: r.id, roomNumber: r.roomNumber, status: r.status, reason: r.lockReason || r.dirtyType }));

      // 解析渠道待确认订单
      const channelData = ordersRes || {};
      const allChannels = channelData.channels || [];
      const overdueOrders: any[] = [];
      const now = new Date();
      const urgentTime = new Date(now.getTime() + 3600000);
      allChannels.forEach((ch: any) => {
        (ch.orders || []).forEach((o: any) => {
          if (o.otaTimeout) {
            const timeout = new Date(o.otaTimeout);
            if (timeout.getTime() < urgentTime.getTime()) {
              overdueOrders.push({
                orderId: o.id, orderNo: o.orderNo, channel: o.channel || ch.name,
                guestName: o.guestName, roomType: o.roomType, otaTimeout: o.otaTimeout,
              });
            }
          }
        });
      });

      const d = {
        todayCheckins, todayCheckouts, occupiedRooms, dirtyRooms, problemRooms, overdueOrders,
        summary: {
          checkinCount: todayCheckins.length, checkoutCount: todayCheckouts.length,
          occupiedCount: occupiedRooms.length, dirtyCount: dirtyRooms.length,
          problemCount: problemRooms.length, overdueOrderCount: overdueOrders.length,
        },
      };

      setBriefing(d);
      const newInsights: typeof insights = [];
      if (d.summary?.dirtyCount > 0) {
        newInsights.push({ icon: '🧹', title: `${d.summary.dirtyCount} 间脏房待清洁`, desc: '建议立即创建清洁任务并分配阿姨', actionLabel: '一键全部创建清洁任务', toolName: 'batch_create_cleaning', params: {} });
      }
      if (d.summary?.overdueOrderCount > 0) {
        newInsights.push({ icon: '⚠️', title: `${d.summary.overdueOrderCount} 个订单超时未确认`, desc: 'OTA订单即将超时，需立即处理', actionLabel: '一键确认全部', toolName: 'batch_confirm_orders', params: {} });
      }
      setInsights(newInsights);
    } catch (e) { setError('运营数据加载失败'); console.error('Failed to load briefing:', e); }
    setLoading(false);
  }, []);

  useEffect(() => { loadBriefing(); }, []);

  const handleCheckIn = async (roomId: string) => {
    setActionLoading(`checkin_${roomId}`);
    try {
      const room = briefing.todayCheckins.find((r: any) => r.roomId === roomId);
      await apiPost('/api/rooms', { action: 'checkIn', roomId, guestName: room?.guestName || '到店客人', guestPhone: room?.guestPhone || '' });
      toast.success('入住办理成功');
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading('');
  };

  const handleCheckOut = async (roomId: string) => {
    setActionLoading(`checkout_${roomId}`);
    try {
      await apiPost('/api/rooms', { action: 'checkOut', roomId });
      toast.success('退房办理成功，房间已标记为脏房');
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading('');
  };

  const handleCreateCleaning = async (roomId: string) => {
    setActionLoading(`cleaning_${roomId}`);
    try {
      const storeId = typeof window !== 'undefined' ? localStorage.getItem('currentStoreId') || 'default_store' : 'default_store';
      const roomInfo = briefing?.todayCheckouts?.find((r: any) => r.roomId === roomId) || briefing?.dirtyRooms?.find((r: any) => r.roomId === roomId) || {};
      await apiPost('/api/housekeeping', { action: 'create', storeId, roomId, roomNumber: roomInfo.roomNumber || '', roomTypeName: roomInfo.roomTypeName || '', taskType: '退房清洁', priority: 'normal' });
      toast.success('清洁任务已创建');
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading('');
  };

  const handleConfirmOrder = async (orderId: string) => {
    setActionLoading(`overdue_order_${orderId}`);
    try {
      await apiPost('/api/orders', { action: 'confirm', orderId });
      toast.success('订单已确认');
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading('');
  };

  const handleCancelOrder = async (orderId: string) => {
    setCancelTarget(orderId);
  };

  const doCancel = async () => {
    if (!cancelTarget) return;
    setActionLoading(`overdue_order_${cancelTarget}`);
    try {
      await apiPost('/api/orders', { action: 'cancel', orderId: cancelTarget, reason: '商家取消' });
      toast.success('订单已取消');
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading(''); setCancelTarget(null);
  };

  const handleAssignCleaning = (taskId: string) => {
    setAssignTarget(taskId);
    setAssigneeName('');
  };

  const doAssign = async () => {
    if (!assignTarget || !assigneeName.trim()) return;
    setActionLoading(`assign_${assignTarget}`);
    try {
      await apiPost('/api/housekeeping', { action: 'assign', taskId: assignTarget, assigneeId: assigneeName.trim(), assigneeName: assigneeName.trim() });
      toast.success(`已分配给 ${assigneeName.trim()}`);
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading(''); setAssignTarget(null); setAssigneeName('');
  };

  const handleCompleteCleaning = async (taskId: string) => {
    setActionLoading(`complete_${taskId}`);
    try {
      await apiPost('/api/housekeeping', { action: 'complete', taskId });
      toast.success('清洁任务已完成，房间已标记为可用');
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading('');
  };

  const handleSetMaintenance = async (roomId: string) => {
    setActionLoading(`maintenance_${roomId}`);
    try {
      await apiPost('/api/rooms', { action: 'setMaintenance', roomId, reason: '系统标记维修' });
      toast.success('已标记为维修');
      loadBriefing();
    } catch (e: any) { toast.error('操作失败: ' + (e?.message || '未知错误')); }
    setActionLoading('');
  };

  const handleActionExecute = async (toolName: string, _params: Record<string, any>) => {
    if (toolName === 'batch_create_cleaning') {
      const storeId = typeof window !== 'undefined' ? localStorage.getItem('currentStoreId') || 'default_store' : 'default_store';
      const dirtyRooms = briefing.dirtyRooms || [];
      await Promise.all(dirtyRooms.map((r: any) =>
        apiPost('/api/housekeeping', { action: 'create', storeId, roomId: r.roomId, roomNumber: r.roomNumber || '', roomTypeName: r.roomTypeName || '', taskType: '退房清洁', priority: 'normal' })
      ));
      toast.success(`已为 ${dirtyRooms.length} 间脏房创建清洁任务`);
      loadBriefing();
    } else if (toolName === 'batch_confirm_orders') {
      const orders = briefing.overdueOrders || [];
      await Promise.all(orders.map((o: any) =>
        apiPost('/api/orders', { action: 'confirm', orderId: o.orderId })
      ));
      toast.success(`已确认 ${orders.length} 个超时订单`);
      loadBriefing();
    }
  };

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-sky-50 flex flex-col">
      <div className="flex items-center justify-between px-5 py-2.5 bg-white/90 border-b border-slate-200 flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-gradient-to-br from-sky-500 to-blue-500 flex items-center justify-center text-lg shadow-md">🔧</div>
          <div>
            <h1 className="text-base font-bold text-slate-800">AI 运营驾驶舱</h1>
            <p className="text-xs text-slate-400">房态巡检 · 清洁调度 · 订单处理 · 异常预警</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={loadBriefing} disabled={loading} className="text-xs px-3 py-1.5 bg-slate-100 rounded-lg text-slate-500 hover:bg-slate-200">
            {loading ? '⏳' : '🔄'} 刷新
          </button>
          <button onClick={() => router.back()} className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-400 hover:text-slate-600 hover:bg-slate-50 transition-colors">← 返回</button>
        </div>
      </div>

      {error && (
        <div className="mx-4 mt-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-xl flex items-center justify-between">
          <span className="text-sm text-red-600">{error}</span>
          <button onClick={() => { setError(null); loadBriefing(); }}
            className="text-xs px-3 py-1 bg-red-100 text-red-700 rounded-lg hover:bg-red-200 font-medium">重试</button>
        </div>
      )}

      <OpsStatsBar summary={briefing?.summary || null} />

      {insights.length > 0 && (
        <div className="flex gap-2 px-4 py-2 flex-shrink-0 overflow-x-auto">
          {insights.map((ins, i) => (
            <AiInsightCard key={i} icon={ins.icon} title={ins.title} description={ins.desc} actionLabel={ins.actionLabel} onAction={() => handleActionExecute(ins.toolName, ins.params)} variant={ins.icon === '⚠️' ? 'danger' : 'warning'} />
          ))}
        </div>
      )}

      <div className="flex flex-1 min-h-0">
        <OpsTimeline
          briefing={briefing}
          actionLoading={actionLoading}
          onCheckIn={handleCheckIn}
          onCheckOut={handleCheckOut}
          onCreateCleaning={handleCreateCleaning}
          onAssignCleaning={handleAssignCleaning}
          onCompleteCleaning={handleCompleteCleaning}
          onSetMaintenance={handleSetMaintenance}
          onConfirmOrder={handleConfirmOrder}
          onCancelOrder={handleCancelOrder}
        />
        <AiChatSidebar
          defaultTab="ops"
          placeholder="输入运营指令，如'帮我把脏房分配给王阿姨'..."
        />
      </div>

      {cancelTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setCancelTarget(null)}>
          <div className="bg-white rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <p className="text-lg font-bold mb-2">确认取消订单</p>
            <p className="text-sm text-slate-500 mb-4">取消后无法恢复，确定要取消该订单吗？</p>
            <div className="flex gap-2">
              <button onClick={() => setCancelTarget(null)} className="flex-1 py-2.5 bg-slate-100 rounded-xl text-sm font-medium">返回</button>
              <button onClick={doCancel} className="flex-1 py-2.5 bg-red-500 text-white rounded-xl text-sm font-medium">确认取消</button>
            </div>
          </div>
        </div>
      )}

      {assignTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/20" onClick={() => setAssignTarget(null)}>
          <div className="bg-white rounded-2xl p-6 shadow-xl max-w-sm w-full mx-4" onClick={e => e.stopPropagation()}>
            <p className="text-lg font-bold mb-3">分配清洁任务</p>
            <input value={assigneeName} onChange={e => setAssigneeName(e.target.value)} placeholder="阿姨姓名" autoFocus
              className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm mb-4 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              onKeyDown={e => e.key === 'Enter' && doAssign()} />
            <div className="flex gap-2">
              <button onClick={() => setAssignTarget(null)} className="flex-1 py-2.5 bg-slate-100 rounded-xl text-sm font-medium">取消</button>
              <button onClick={doAssign} disabled={!assigneeName.trim()} className="flex-1 py-2.5 bg-emerald-500 text-white rounded-xl text-sm font-medium disabled:opacity-50">确定分配</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
