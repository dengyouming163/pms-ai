'use client';

import { OpsTaskCard } from './ops-task-card';

interface OpsTimelineProps {
  briefing: any;
  onCheckIn: (roomId: string) => void;
  onCheckOut: (roomId: string) => void;
  onCreateCleaning: (roomId: string) => void;
  onAssignCleaning: (taskId: string) => void;
  onCompleteCleaning: (taskId: string) => void;
  onSetMaintenance: (roomId: string) => void;
  onConfirmOrder: (orderId: string) => void;
  onCancelOrder: (orderId: string) => void;
  actionLoading: string;
}

export function OpsTimeline({ briefing, onCheckIn, onCheckOut, onCreateCleaning, onAssignCleaning, onCompleteCleaning, onSetMaintenance, onConfirmOrder, onCancelOrder, actionLoading }: OpsTimelineProps) {
  if (!briefing) {
    return <div className="flex-1 flex items-center justify-center text-slate-400"><p>加载中...</p></div>;
  }

  const sections = [
    { label: '🛎️ 今日入住', items: (briefing.todayCheckins || []).map((r: any) => ({ id: r.roomId, type: 'checkin' as const, title: `${r.roomNumber} ${r.guestName}`, subtitle: `预计离店: ${r.checkOutDate || '未设定'}` })) },
    { label: '🚪 今日退房', items: (briefing.todayCheckouts || []).map((r: any) => ({ id: r.roomId, type: 'checkout' as const, title: `${r.roomNumber} ${r.guestName}`, subtitle: '退房后需安排清洁' })) },
    { label: '🧹 脏房待清洁', items: (briefing.dirtyRooms || []).map((r: any) => ({ id: r.roomId, type: 'cleaning' as const, title: `${r.roomNumber} ${r.roomTypeName || ''}`, subtitle: '需要创建清洁任务' })) },
    { label: '⚠️ 超时未确认订单', items: (briefing.overdueOrders || []).map((o: any) => ({ id: o.orderId, type: 'overdue_order' as const, title: `${o.orderNo} · ${o.channel}`, subtitle: `${o.guestName} · ${o.roomType}` })) },
    { label: '🔧 异常房间', items: (briefing.problemRooms || []).map((r: any) => ({ id: r.roomId, type: 'maintenance' as const, title: `${r.roomNumber} · ${r.status === 'maintenance' ? '维修中' : '已锁房'}`, subtitle: r.reason || '无备注' })) },
  ];

  const hasItems = sections.some(s => s.items.length > 0);

  return (
    <div className="flex-1 overflow-y-auto px-4 py-3 space-y-4 custom-scroll">
      {!hasItems && (
        <div className="text-center py-16">
          <p className="text-5xl mb-3">✅</p>
          <p className="text-sm text-slate-400">今日一切正常，暂无待办事项</p>
        </div>
      )}
      {sections.map(section => (
        section.items.length > 0 && (
          <div key={section.label}>
            <h3 className="text-sm font-semibold text-slate-600 mb-2">{section.label}</h3>
            <div className={section.label.includes('脏房') ? 'grid grid-cols-2 lg:grid-cols-4 gap-2' : 'space-y-2'}>
              {section.items.map((item: { id: string; type: 'checkin' | 'checkout' | 'cleaning' | 'maintenance' | 'overdue_order'; title: string; subtitle: string }) => {
                const loadingKey = `${item.type}_${item.id}`;
                return (
                  <OpsTaskCard
                    key={item.id}
                    type={item.type}
                    title={item.title}
                    subtitle={item.subtitle}
                    primaryAction={{
                      label: item.type === 'checkin' ? '办理入住' : item.type === 'checkout' ? '办理退房' : item.type === 'cleaning' ? '创建清洁任务' : item.type === 'overdue_order' ? '确认订单' : '标记维修',
                      loading: actionLoading === loadingKey,
                      onClick: () => {
                        if (item.type === 'checkin') onCheckIn(item.id);
                        else if (item.type === 'checkout') onCheckOut(item.id);
                        else if (item.type === 'cleaning') onCreateCleaning(item.id);
                        else if (item.type === 'overdue_order') onConfirmOrder(item.id);
                        else if (item.type === 'maintenance') onSetMaintenance(item.id);
                      },
                    }}
                    secondaryAction={item.type === 'overdue_order' ? { label: '取消订单', onClick: () => onCancelOrder(item.id) } : undefined}
                  />
                );
              })}
            </div>
          </div>
        )
      ))}
    </div>
  );
}
