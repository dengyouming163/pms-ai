// Common types shared across the application

export interface Brand {
  id: string;
  name: string;
  logo: string;
  storeCount: number;
  description: string;
  facilities: string[];
  createdAt: string;
}

export interface Store {
  id: string;
  brandId: string;
  brandName: string;
  name: string;
  address: string;
  phone: string;
  roomCount: number;
  manager: string;
  status: 'active' | 'inactive';
  facilities: string[];
  createdAt: string;
}

export interface RoomType {
  id: string;
  storeId: string;
  name: string;
  bedType: string;
  area: number;
  maxGuests: number;
  facilities: string[];
  images: string[];
  roomCount: number;
  basePrice: number;
}

export interface Room {
  id: string;
  storeId: string;
  roomTypeId: string;
  roomTypeName: string;
  roomNumber: string;
  floor: number;
  status: 'available' | 'booked' | 'occupied' | 'dirty' | 'maintenance' | 'locked';
  attributes: string[];
  price: number;
}

export interface Order {
  id: string;
  orderNo: string;
  channel: string;
  guestName: string;
  guestPhone: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  roomNumber: string;
  amount: number;
  paymentStatus: 'paid' | 'unpaid' | 'partial' | 'refunded';
  status: 'pending' | 'confirmed' | 'checked_in' | 'checked_out' | 'cancelled';
  createdAt: string;
}

export interface Channel {
  id: string;
  name: string;
  icon: string;
  status: 'connected' | 'disconnected' | 'error';
  autoSync: boolean;
  autoPrice: boolean;
  lastSyncAt: string;
}

export interface Member {
  id: string;
  name: string;
  phone: string;
  level: string;
  points: number;
  totalSpent: number;
  orderCount: number;
  lastVisit: string;
}

export interface Coupon {
  id: string;
  name: string;
  type: 'discount' | 'reduction' | 'exchange';
  value: number;
  minSpend: number;
  validFrom: string;
  validTo: string;
  usedCount: number;
  totalCount: number;
  status: 'active' | 'expired' | 'disabled';
}

export interface StaffMember {
  id: string;
  name: string;
  phone: string;
  role: string;
  store: string;
  status: 'active' | 'inactive';
  joinDate: string;
}

export interface Staff {
  id: string;
  name: string;
  phone: string;
  role: string;
  storeName: string;
  lastLoginAt: string;
  status: 'active' | 'disabled';
}

export interface DashboardStats {
  todayRevenue: number;
  revenueChange: number;
  soldRooms: number;
  totalRooms: number;
  occupancyRate: number;
  occupancyChange: number;
  adr: number;
  adrChange: number;
  revpar: number;
  revparChange: number;
  expectedArrivals: number;   // 预抵 - 今日预计到店
  inHouse: number;            // 在住 - 当前在住房间数
  expectedDepartures: number; // 预离 - 今日预计离店
  availableRooms: number;     // 可售 - 当前可售房间数
  todos: TodoItem[];
  weeklyTrend: TrendData[];
}

export interface TodoItem {
  id: string;
  type: 'order' | 'review' | 'task' | 'subscription';
  title: string;
  count: number;
}

export interface TrendData {
  date: string;
  occupancyRate: number;
  revpar: number;
  revenue: number;
}

export interface FinanceReport {
  date: string;
  roomRevenue: number;
  productRevenue: number;
  otherRevenue: number;
  totalRevenue: number;
  channelBreakdown: Record<string, number>;
  paymentBreakdown: Record<string, number>;
}

export interface OperationLog {
  id: string;
  staffName: string;
  action: string;
  module: string;
  detail: string;
  storeName: string;
  createdAt: string;
}

export interface Role {
  id: string;
  name: string;
  description: string;
  isPreset: boolean;
  permissions: string[];
  scope: 'tenant' | 'brand' | 'store';
  staffCount: number;
}

export interface Activity {
  id: string;
  name: string;
  type: 'flash_sale' | 'long_stay' | 'early_bird';
  storeName: string;
  roomTypes: string[];
  dateRange: string;
  discount: string;
  status: 'active' | 'ended' | 'scheduled';
}

export interface Reconciliation {
  id: string;
  channelName: string;
  orderNo: string;
  systemAmount: number;
  channelAmount: number;
  difference: number;
  status: 'matched' | 'unmatched' | 'missing_system' | 'missing_channel';
  orderDate: string;
}

export interface Invoice {
  id: string;
  applicant: string;
  amount: number;
  title: string;
  taxNumber: string;
  status: 'pending' | 'approved' | 'rejected' | 'issued';
  appliedAt: string;
}

export interface Deposit {
  id: string;
  orderNo: string;
  guestName: string;
  guestPhone: string;
  checkInDate: string;
  amount: number;
  paymentMethod: string;
  status: 'held' | 'refunded';
}

export interface PriceMapping {
  id: string;
  channelId: string;
  channelName: string;
  roomTypeName: string;
  basePlan: string;
  premium: number;
  premiumType: 'percentage' | 'fixed';
}

export interface PricePlan {
  id: string;
  name: string;
  roomTypeName: string;
  dateRange: string;
  weekdays: number[];
  basePrice: number;
  holidayAdjustment: number;
  adjustmentType: 'percentage' | 'fixed';
}

export interface Device {
  id: string;
  storeName: string;
  type: 'lock' | 'meter' | 'kiosk';
  name: string;
  serialNumber: string;
  status: 'online' | 'offline' | 'error';
  lastSyncAt: string;
}

/** 收支流水 */
export interface Transaction {
  id: string;
  type: 'income' | 'expense';
  category: string;
  amount: number;
  channel: string;
  channelName?: string;
  orderNo: string;
  orderId?: string;
  guestName: string;
  storeName: string;
  paymentMethod: string;
  status: string;
  remark: string;
  description?: string;
  transactionDate?: string;
  createdAt: string;
}
