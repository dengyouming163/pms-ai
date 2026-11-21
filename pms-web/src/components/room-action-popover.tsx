'use client';

interface DailyRoom {
  id: string; roomTypeId: string; roomTypeName: string; roomNumber: string;
  floor: number; status: string; price: number;
  guest?: string; checkIn?: string; checkOut?: string; orderNo?: string;
}

interface Props {
  room: DailyRoom;
  position: { x: number; y: number };
  onClose: () => void;
  onAction: (action: string) => void;
}

export function RoomActionPopover({ room, position, onClose, onAction }: Props) {
  const status = room.status || 'available';
  const x = Math.min(position.x, typeof window !== 'undefined' ? window.innerWidth - 300 : 700);

  const btn = (label: string, action: string, color: string) => (
    <button onClick={() => onAction(action)}
      className={`px-3 py-1.5 text-xs text-white rounded-lg hover:opacity-90 whitespace-nowrap transition-opacity ${color}`}>{label}</button>
  );

  const actions: Record<string, React.ReactNode> = {
    available: (<>
      {btn('录单入住', 'checkin', 'bg-emerald-500')}
      {btn('预订', 'book', 'bg-blue-500')}
      {btn('关房', 'lock', 'bg-slate-500')}
      {btn('设为脏房', 'dirty', 'bg-orange-500')}
      {btn('详情', 'detail', 'bg-slate-600 text-white hover:bg-slate-700')}
    </>),
    booked: (<>
      {btn('办理入住', 'checkin', 'bg-emerald-500')}
      {btn('取消预订', 'cancel', 'bg-red-500')}
      {btn('修改', 'modify', 'bg-blue-500')}
      {btn('详情', 'detail', 'bg-slate-600 text-white hover:bg-slate-700')}
    </>),
    occupied: (<>
      {btn('退房', 'checkout', 'bg-red-500')}
      {btn('续住', 'extend', 'bg-amber-500')}
      {btn('换房', 'change', 'bg-blue-500')}
      {btn('详情', 'detail', 'bg-slate-600 text-white hover:bg-slate-700')}
    </>),
    dirty: (<>
      {btn('设为干净', 'clean', 'bg-emerald-500')}
      {btn('关房', 'lock', 'bg-slate-500')}
      {btn('设为维修', 'maintenance', 'bg-red-500')}
      {btn('详情', 'detail', 'bg-slate-600 text-white hover:bg-slate-700')}
    </>),
    maintenance: (<>
      {btn('恢复可用', 'restore', 'bg-emerald-500')}
      {btn('关房', 'lock', 'bg-slate-500')}
      {btn('详情', 'detail', 'bg-slate-600 text-white hover:bg-slate-700')}
    </>),
    locked: (<>
      {btn('解锁', 'unlock', 'bg-emerald-500')}
      {btn('设为维修', 'maintenance', 'bg-red-500')}
      {btn('详情', 'detail', 'bg-slate-600 text-white hover:bg-slate-700')}
    </>),
  };

  return (
    <div className="fixed inset-0 z-50" onClick={onClose}>
      <div className="absolute bg-white rounded-xl shadow-xl border border-slate-200 p-2 flex gap-1.5"
        style={{ left: x, top: position.y - 30 }}>
        {/* Room info header */}
        <div className="flex items-center gap-2 pr-2 border-r border-slate-100 mr-1">
          <span className="text-xs font-bold text-slate-700">{room.roomNumber}</span>
          {room.guest && <span className="text-[10px] text-slate-400">{room.guest.slice(0,6)}</span>}
        </div>
        {actions[status] || actions.available}
      </div>
    </div>
  );
}
