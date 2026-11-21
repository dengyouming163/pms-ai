import type { RoomStatus } from '@/types/room'

/** 房间状态配置 — 与 pms-web 对齐，统一使用 occupied/maintenance */
export interface RoomStatusConfig {
  label: string
  color: string      // 文字/边框色
  bg: string         // 背景色（浅色）
  icon: string       // emoji 图标
}

export const roomStatusConfig: Record<RoomStatus, RoomStatusConfig> = {
  available:   { label: '空闲', color: '#07C160', bg: '#E8F8EF', icon: '✨' },
  booked:      { label: '预订', color: '#576B95', bg: '#EBF0F7', icon: '📅' },
  occupied:    { label: '在住', color: '#FF9500', bg: '#FFF3E0', icon: '🧑' },
  dirty:       { label: '脏房', color: '#FA5151', bg: '#FFE8E8', icon: '🧹' },
  maintenance: { label: '维修', color: '#999999', bg: '#F5F5F5', icon: '🔧' },
  locked:      { label: '锁房', color: '#576B95', bg: '#EBF0F7', icon: '🔒' },
}

/** ActionSheet 操作按钮配置 */
export interface ActionButton {
  action: string
  label: string
  icon: string
  type: 'primary' | 'danger' | 'warning' | 'info' | 'neutral'
}

/** 按状态返回操作按钮列表 */
export function getActionsByStatus(status: RoomStatus): ActionButton[] {
  const detail: ActionButton = { action: 'detail', label: '详情', icon: '📋', type: 'neutral' }
  const map: Record<string, ActionButton[]> = {
    available: [
      { action: 'checkIn', label: '录单入住', icon: '🚪', type: 'primary' },
      { action: 'book', label: '预订', icon: '📅', type: 'info' },
      { action: 'lock', label: '关房', icon: '🔒', type: 'neutral' },
      { action: 'markDirty', label: '设为脏房', icon: '🧹', type: 'warning' },
      detail,
    ],
    occupied: [
      { action: 'checkOut', label: '退房', icon: '🚪', type: 'danger' },
      { action: 'extendStay', label: '续住', icon: '⏰', type: 'warning' },
      { action: 'changeRoom', label: '换房', icon: '🔄', type: 'info' },
      detail,
    ],
    booked: [
      { action: 'checkIn', label: '办理入住', icon: '✅', type: 'primary' },
      { action: 'cancelBook', label: '取消预订', icon: '❌', type: 'danger' },
      { action: 'modifyBook', label: '修改', icon: '✏️', type: 'info' },
      detail,
    ],
    dirty: [
      { action: 'markClean', label: '设为干净', icon: '✨', type: 'primary' },
      { action: 'lock', label: '关房', icon: '🔒', type: 'neutral' },
      { action: 'setMaintenance', label: '设为维修', icon: '🔧', type: 'danger' },
      detail,
    ],
    maintenance: [
      { action: 'restoreAvailable', label: '恢复可用', icon: '✅', type: 'primary' },
      { action: 'lock', label: '关房', icon: '🔒', type: 'neutral' },
      detail,
    ],
    locked: [
      { action: 'unlock', label: '解锁', icon: '🔓', type: 'primary' },
      { action: 'setMaintenance', label: '设为维修', icon: '🔧', type: 'danger' },
      detail,
    ],
  }
  return map[status] || map.available
}

/** 月房态入住率着色 */
export function getOccupancyColor(rate: number): { bg: string; color: string } {
  if (rate >= 90) return { bg: '#FFE0E0', color: '#FA5151' }
  if (rate >= 70) return { bg: '#FFF3D6', color: '#FF9500' }
  if (rate >= 50) return { bg: '#D6F5E5', color: '#07C160' }
  return { bg: '#E8EDF5', color: '#576B95' }
}
