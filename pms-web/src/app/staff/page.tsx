'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { PageHeader } from '@/components/page-header';
import { TabBar } from '@/components/tab-bar';
import { StatusBadge } from '@/components/status-badge';
import { useStore } from '@/lib/context/store-context';
import { useHasPermission } from '@/lib/auth/auth-context';
import { apiGet, apiPost, apiPut, apiDelete } from '@/lib/api-client';
import { toast } from 'sonner';
import {
  Users, Search, Edit3, Trash2,
  KeyRound, ChevronDown, ChevronRight,
  Check, X, Eye, Filter, Download,
  ToggleLeft, ToggleRight, Shield, Loader2,
  Building2, Building, BedDouble, Edit2,
  MapPin, Phone, Star, Clock, CreditCard,
  Wifi, Car, Dumbbell, UtensilsCrossed, Waves,
  TreePine, Briefcase, Upload, Lock, User, Plus,
} from 'lucide-react';

interface StaffMember {
  id: string; name: string; phone: string; roleId: string; roleName: string;
  scope: string; stores: string[]; joinDate: string; lastLoginAt: string; status: 'active' | 'disabled';
}

interface Role {
  id: string; name: string; description: string; isPreset: boolean;
  staffCount: number; color: string; permissions: string[]; scope: 'tenant' | 'brand' | 'store';
}

interface PermissionNode {
  key: string; label: string; children?: PermissionNode[];
}

interface LogEntry {
  id: string; staffId: string; staffName: string; action: string;
  module: string; moduleLabel: string; target: string; detail: string;
  ip: string; timestamp: string; level: 'info' | 'warning';
}

/* ===== 门店/品牌管理类型 ===== */
interface BrandStandards {
  checkInTime: string; checkOutTime: string; cancelPolicy: string;
  depositRule: string; identityRequired: boolean;
  welcomeMsg: string; reviewReply: string;
}
interface Brand {
  id: string; name: string; type: 'platform' | 'custom'; logo: string; color: string; storeCount: number;
  description: string; facilities: string[]; standards: BrandStandards;
  sops: string[]; createdAt: string;
}
interface StoreSettings {
  checkInTime: string; checkOutTime: string; cancelPolicy: string;
  depositRule: string; depositAmount: number; identityRequired: boolean;
  petAllowed: boolean; smokingAllowed: boolean;
  lateCheckOut: { enabled: boolean; fee: number; maxHours: number };
  earlyCheckIn: { enabled: boolean; fee: number; earliestTime: string };
}
interface Store {
  id: string; brandId: string; brandName: string; name: string;
  address: string; phone: string; roomCount: number; manager: string;
  status: string; facilities: string[]; images: number;
  rating: number; reviewCount: number; todayOccupancy: number;
  todayRevenue: number; monthRevenue: number;
  settings: StoreSettings; createdAt: string;
}
interface Device {
  id: string; type: string; typeName: string; name: string; sn: string;
  storeId: string; storeName: string; roomNumber: string;
  status: string; lastSync: string; battery: number | null;
}

const tabs = [
  { key: 'staff', label: '员工管理' },
  { key: 'roles', label: '角色管理' },
  { key: 'logs', label: '操作日志' },
  { key: 'stores', label: '门店管理' },
  { key: 'brands', label: '品牌管理' },
];

const roleColorMap: Record<string, string> = {
  '租户管理员': 'bg-red-50 text-red-700 border-red-200',
  '品牌经理': 'bg-orange-50 text-orange-700 border-orange-200',
  '店长': 'bg-emerald-50 text-emerald-700 border-emerald-200',
  '前台': 'bg-blue-50 text-blue-700 border-blue-200',
  '保洁': 'bg-violet-50 text-violet-700 border-violet-200',
  '财务': 'bg-pink-50 text-pink-700 border-pink-200',
  '渠道运营': 'bg-cyan-50 text-cyan-700 border-cyan-200',
};

const actionLabels: Record<string, string> = {
  create_order: '创建订单', edit_price: '修改价格', create_staff: '添加员工',
  refund_deposit: '退还押金', cancel_order: '取消订单', edit_mapping: '修改映射',
  edit_room_status: '修改房态', edit_role: '修改权限', export_report: '导出报表',
  update_room_status: '更新房态', disable_staff: '禁用员工', edit_store_settings: '修改设置',
  connect_channel: '连接渠道', reset_password: '重置密码', issue_invoice: '开具发票',
  edit_staff: '编辑员工', delete_role: '删除角色',
};

const moduleLabels: Record<string, string> = {
  orders: '订单管理', rooms: '房态管理', pricing: '价格管理',
  channels: '渠道管理', staff: '团队管理', finance: '财务管理', settings: '系统设置',
};

const FACILITY_OPTIONS = ['免费WiFi', '停车场', '健身房', '餐厅', '游泳池', '花园', '会议室'];

const facilityIcons: Record<string, React.ReactNode> = {
  '免费WiFi': <Wifi className="w-3.5 h-3.5" />, '停车场': <Car className="w-3.5 h-3.5" />,
  '健身房': <Dumbbell className="w-3.5 h-3.5" />, '餐厅': <UtensilsCrossed className="w-3.5 h-3.5" />,
  '游泳池': <Waves className="w-3.5 h-3.5" />, '花园': <TreePine className="w-3.5 h-3.5" />,
  '会议室': <Briefcase className="w-3.5 h-3.5" />,
};

function SectionTitle({ title, children }: { title: string; children?: React.ReactNode }) {
  return (
    <div className="flex items-center justify-between mb-4">
      <h3 className="text-base font-semibold text-slate-800">{title}</h3>
      {children}
    </div>
  );
}

export default function StaffPage() {
  const [activeTab, setActiveTab] = useState('staff');
  const [staff, setStaff] = useState<StaffMember[]>([]);
  const [stats, setStats] = useState({ total: 0, active: 0, disabled: 0, onlineToday: 0 });
  const [search, setSearch] = useState('');
  const [roles, setRoles] = useState<Role[]>([]);
  const [permissionTree, setPermissionTree] = useState<PermissionNode[]>([]);
  const [expandedRoles, setExpandedRoles] = useState<Set<string>>(new Set());
  const [expandedPermNodes, setExpandedPermNodes] = useState<Set<string>>(new Set());
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logModules, setLogModules] = useState<{key: string; label: string}[]>([]);
  const [logOperators, setLogOperators] = useState<string[]>([]);
  const [logModuleFilter, setLogModuleFilter] = useState('');
  const [logOperatorFilter, setLogOperatorFilter] = useState('');
  const [logsLoading, setLogsLoading] = useState(false);

  // Modal states
  const [showAddStaff, setShowAddStaff] = useState(false);
  const [showEditStaff, setShowEditStaff] = useState(false);
  const [showResetPwd, setShowResetPwd] = useState(false);
  const [showAddRole, setShowAddRole] = useState(false);
  const [showEditRole, setShowEditRole] = useState(false);
  const [showDeleteRole, setShowDeleteRole] = useState(false);
  const [saving, setSaving] = useState(false);

  // Staff form
  const [staffForm, setStaffForm] = useState({ name: '', phone: '', roleId: '', stores: [] as string[] });
  const [editingStaffId, setEditingStaffId] = useState('');
  const [resetPwdStaff, setResetPwdStaff] = useState<StaffMember | null>(null);

  // Role form
  const [roleForm, setRoleForm] = useState({ name: '', description: '', scope: 'store' as 'tenant' | 'brand' | 'store', permissions: [] as string[] });
  const [editingRoleId, setEditingRoleId] = useState('');
  const [deletingRole, setDeletingRole] = useState<Role | null>(null);

  // Store/brand management states
  const { currentStore } = useStore();
  const canEditStores = useHasPermission('stores:edit');
  const [brands, setBrands] = useState<Brand[]>([]);
  const [stores, setStores] = useState<Store[]>([]);
  // 管辖门店下拉选项 — 从 stores 列表提取
  const storeOptions = stores.map(s => ({ id: s.id, name: s.name }));
  const [devices, setDevices] = useState<Device[]>([]);
  const [showBrandModal, setShowBrandModal] = useState(false);
  const [editBrand, setEditBrand] = useState<Brand | null>(null);
  const [brandForm, setBrandForm] = useState({ name: '', description: '', logo: '', facilities: [] as string[] });
  const [logoUploading, setLogoUploading] = useState(false);
  const logoInputRef = useRef<HTMLInputElement>(null);

  const handleLogoUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setLogoUploading(true);
    try {
      const formData = new FormData();
      formData.append('file', file);
      const data = await apiPost('/api/upload', formData);
      if (data.success) {
        setBrandForm(prev => ({ ...prev, logo: data.url }));
        toast.success('Logo上传成功');
      }
    } catch { toast.error('上传失败'); }
    finally { setLogoUploading(false); }
  };
  const [showStoreDetail, setShowStoreDetail] = useState<Store | null>(null);
  const [showStoreModal, setShowStoreModal] = useState(false);
  const [showEditStoreModal, setShowEditStoreModal] = useState(false);
  const [editStoreForm, setEditStoreForm] = useState({ brandId: '', name: '', address: '', phone: '', manager: '', facilities: [] as string[], status: 'active' as string, checkInTime: '', checkOutTime: '', cancelPolicy: '', depositRule: '', depositAmount: 0, identityRequired: false, petAllowed: false, smokingAllowed: false, lateCheckOutEnabled: false, lateCheckOutFee: 0, lateCheckOutMaxHours: 2, earlyCheckInEnabled: false, earlyCheckInFee: 0, earlyCheckInEarliestTime: '' });
  const [storeForm, setStoreForm] = useState({ brandId: '', name: '', address: '', phone: '', manager: '', facilities: [] as string[] });
  const [selectedStoreId, setSelectedStoreId] = useState<string>('all');

  const fetchData = useCallback(async () => {
    try {
      const staffData = await apiGet('/api/staff');
      setStaff(staffData.staff);
      setStats(staffData.stats);

      const roleData = await apiGet('/api/staff?type=roles');
      setRoles(roleData.roles);
      setPermissionTree(roleData.permissionTree);

      setLogsLoading(true);
      const logData = await apiGet('/api/staff?type=logs');
      setLogs(logData.logs || []);
      setLogModules(logData.modules || []);
      setLogOperators((logData.operators || []).map((o: any) => o.staffName));
      setLogsLoading(false);

      // Fetch store/brand data
      apiGet('/api/brands').then(setBrands);
      apiGet('/api/stores').then(setStores);
      apiGet('/api/stores?type=devices').then(setDevices);
    } catch { setLogsLoading(false); }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  // Sync store filter with global store context
  useEffect(() => {
    if (currentStore) {
      setSelectedStoreId(currentStore.id);
    }
  }, [currentStore]);

  // Store/brand computed values
  const totalRooms = stores.reduce((s, st) => s + st.roomCount, 0);
  const activeStores = stores.filter(s => s.status === 'active').length;
  const avgOccupancy = stores.length > 0 ? Math.round(stores.reduce((s, st) => s + st.todayOccupancy, 0) / stores.length) : 0;
  const totalMonthRevenue = stores.reduce((s, st) => s + st.monthRevenue, 0);
  const editingStoreIsPlatform = editStoreForm.brandId ? brands.find(b => b.id === editStoreForm.brandId)?.type === 'platform' : false;
  const creatingStoreIsPlatform = storeForm.brandId ? brands.find(b => b.id === storeForm.brandId)?.type === 'platform' : false;

  const filteredStaff = staff.filter(s =>
    s.name.includes(search) || s.phone.includes(search) || s.roleName.includes(search)
  );

  const filteredLogs = logs.filter(l => {
    if (logModuleFilter && l.module !== logModuleFilter) return false;
    if (logOperatorFilter && l.staffName !== logOperatorFilter) return false;
    return true;
  });

  const toggleRoleExpand = (id: string) => {
    setExpandedRoles(prev => { const n = new Set(prev); n.has(id) ? n.delete(id) : n.add(id); return n; });
  };

  const togglePermNode = (key: string) => {
    setExpandedPermNodes(prev => { const n = new Set(prev); n.has(key) ? n.delete(key) : n.add(key); return n; });
  };

  // Staff handlers
  const openAddStaff = () => {
    setStaffForm({ name: '', phone: '', roleId: '', stores: [] });
    setShowAddStaff(true);
  };

  const openEditStaff = (s: StaffMember) => {
    setEditingStaffId(s.id);
    setStaffForm({ name: s.name, phone: s.phone, roleId: s.roleId, stores: [...s.stores] });
    setShowEditStaff(true);
  };

  const openResetPwd = (s: StaffMember) => {
    setResetPwdStaff(s);
    setShowResetPwd(true);
  };

  const handleSaveStaff = async (isEdit: boolean) => {
    if (!staffForm.name || !staffForm.phone || !staffForm.roleId) return;
    setSaving(true);
    const role = roles.find(r => r.id === staffForm.roleId);
    try {
      await apiPost('/api/staff', {
        action: isEdit ? 'edit_staff' : 'create_staff',
        staffId: isEdit ? editingStaffId : undefined,
        data: {
          name: staffForm.name,
          phone: staffForm.phone,
          roleId: staffForm.roleId,
          roleName: role?.name || '',
          scope: staffForm.stores.length === storeOptions.length ? '全部门店' : storeOptions.filter(s => staffForm.stores.includes(s.id)).map(s => s.name).join('、') || '未分配',
          stores: staffForm.stores,
        },
      });
    } catch { toast.error('保存失败'); }
    fetchData();
    setSaving(false);
    if (isEdit) setShowEditStaff(false); else setShowAddStaff(false);
  };

  const handleToggleStaff = async (s: StaffMember) => {
    const newStatus = s.status === 'active' ? 'disabled' as const : 'active' as const;
    setStaff(prev => prev.map(x => x.id === s.id ? { ...x, status: newStatus } : x));
    setStats(prev => ({
      ...prev,
      active: newStatus === 'active' ? prev.active + 1 : prev.active - 1,
      disabled: newStatus === 'disabled' ? prev.disabled + 1 : prev.disabled - 1,
    }));
    try {
      await apiPost('/api/staff', { action: 'toggle_staff', staffId: s.id });
      toast.success(newStatus === 'active' ? '已启用' : '已禁用');
      fetchData();
    } catch { toast.error('操作失败'); }
  };

  const handleResetPassword = async () => {
    if (!resetPwdStaff) return;
    setSaving(true);
    try {
      await apiPost('/api/staff', { action: 'reset_password', staffId: resetPwdStaff.id });
    } catch { /* ignore */ }
    setSaving(false);
    setShowResetPwd(false);
    setResetPwdStaff(null);
  };

  // Role handlers
  const openAddRole = () => {
    setRoleForm({ name: '', description: '', scope: 'store', permissions: [] });
    setExpandedPermNodes(new Set());
    setShowAddRole(true);
  };

  const openEditRole = (role: Role) => {
    setEditingRoleId(role.id);
    setRoleForm({ name: role.name, description: role.description, scope: role.scope, permissions: [...role.permissions] });
    setExpandedPermNodes(new Set());
    setShowEditRole(true);
  };

  const openDeleteRole = (role: Role) => {
    setDeletingRole(role);
    setShowDeleteRole(true);
  };

  const handleSaveRole = async (isEdit: boolean) => {
    if (!roleForm.name) return;
    setSaving(true);
    try {
      await apiPost('/api/staff', {
        action: isEdit ? 'edit_role' : 'create_role',
        roleId: isEdit ? editingRoleId : undefined,
        data: { name: roleForm.name, description: roleForm.description, scope: roleForm.scope, permissions: roleForm.permissions, color: '#' + ((roleForm.name.length * 2654435761) % 16777215).toString(16).padStart(6, '0') },
      });
    } catch { toast.error('保存失败'); }
    fetchData();
    setSaving(false);
    if (isEdit) setShowEditRole(false); else setShowAddRole(false);
  };

  const handleDeleteRole = async () => {
    if (!deletingRole) return;
    setSaving(true);
    try {
      await apiPost('/api/staff', { action: 'delete_role', roleId: deletingRole.id });
    } catch { /* ignore */ }
    setRoles(prev => prev.filter(r => r.id !== deletingRole.id));
    setSaving(false);
    setShowDeleteRole(false);
    setDeletingRole(null);
  };

  const togglePermission = (key: string) => {
    setRoleForm(prev => {
      const perms = [...prev.permissions];
      const idx = perms.indexOf(key);
      if (idx >= 0) perms.splice(idx, 1); else perms.push(key);
      return { ...prev, permissions: perms };
    });
  };

  const togglePermGroup = (node: PermissionNode) => {
    const childKeys = node.children?.map(c => c.key) || [node.key];
    const allChecked = childKeys.every(k => roleForm.permissions.includes(k));
    setRoleForm(prev => {
      let perms = [...prev.permissions];
      if (allChecked) {
        perms = perms.filter(k => !childKeys.includes(k));
      } else {
        childKeys.forEach(k => { if (!perms.includes(k)) perms.push(k); });
      }
      return { ...prev, permissions: perms };
    });
  };

  const handleExportLogs = () => {
    const csvHeader = '时间,员工,操作,模块,详情,IP,级别\n';
    const csvRows = filteredLogs.map(l =>
      `${l.timestamp},${l.staffName},${actionLabels[l.action] || l.action},${l.module},"${l.detail}",${l.ip},${l.level === 'warning' ? '敏感' : '普通'}`
    ).join('\n');
    const blob = new Blob(['\uFEFF' + csvHeader + csvRows], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `操作日志_${new Date().toISOString().split('T')[0]}.csv`;
    link.click();
    URL.revokeObjectURL(url);
  };

  // === Store/brand handlers ===
  const handleSaveBrand = async () => {
    if (editBrand) {
      const body = { ...editBrand, ...brandForm };
      Object.keys(body).forEach(k => (body as any)[k] == null && delete (body as any)[k]);
      await apiPut('/api/brands', body);
    } else {
      await apiPost('/api/brands', brandForm);
    }
    setShowBrandModal(false); setEditBrand(null);
    apiGet('/api/brands').then(setBrands);
  };

  const handleSaveStore = async () => {
    if (!storeForm.name || !storeForm.brandId) return;
    const selectedBrand = brands.find(b => b.id === storeForm.brandId);
    const newStore: Store = {
      id: `s_new_${storeForm.name.length}`, brandId: storeForm.brandId, brandName: selectedBrand?.name || '',
      name: storeForm.name, address: storeForm.address, phone: storeForm.phone,
      roomCount: 0, manager: storeForm.manager, status: 'active',
      facilities: storeForm.facilities, images: 0, rating: 0, reviewCount: 0,
      todayOccupancy: 0, todayRevenue: 0, monthRevenue: 0,
      settings: {
        checkInTime: '14:00', checkOutTime: '12:00', cancelPolicy: 'flexible',
        depositRule: 'none', depositAmount: 0, identityRequired: true,
        petAllowed: false, smokingAllowed: false,
        lateCheckOut: { enabled: false, fee: 0, maxHours: 2 },
        earlyCheckIn: { enabled: false, fee: 0, earliestTime: '12:00' },
      },
      createdAt: new Date().toISOString().split('T')[0],
    };
    await apiPost('/api/stores', { action: 'addStore', ...newStore });
    setShowStoreModal(false);
    setStoreForm({ brandId: '', name: '', address: '', phone: '', manager: '', facilities: [] });
    apiGet('/api/stores').then(setStores);
  };

  const handleEditStore = (store: Store) => {
    setEditStoreForm({
      brandId: store.brandId, name: store.name, address: store.address, phone: store.phone,
      manager: store.manager, facilities: [...store.facilities], status: store.status,
      checkInTime: store.settings.checkInTime, checkOutTime: store.settings.checkOutTime,
      cancelPolicy: store.settings.cancelPolicy, depositRule: store.settings.depositRule,
      depositAmount: store.settings.depositAmount, identityRequired: store.settings.identityRequired,
      petAllowed: store.settings.petAllowed, smokingAllowed: store.settings.smokingAllowed,
      lateCheckOutEnabled: store.settings.lateCheckOut.enabled, lateCheckOutFee: store.settings.lateCheckOut.fee,
      lateCheckOutMaxHours: store.settings.lateCheckOut.maxHours, earlyCheckInEnabled: store.settings.earlyCheckIn.enabled,
      earlyCheckInFee: store.settings.earlyCheckIn.fee, earlyCheckInEarliestTime: store.settings.earlyCheckIn.earliestTime,
    });
    setShowEditStoreModal(true);
  };

  const handleSaveEditStore = async () => {
    if (!showStoreDetail || !editStoreForm.name) return;
    const selectedBrand = brands.find(b => b.id === editStoreForm.brandId);
    const updatedStore: Store = {
      ...showStoreDetail,
      brandId: editStoreForm.brandId, brandName: selectedBrand?.name || showStoreDetail.brandName,
      name: editStoreForm.name, address: editStoreForm.address, phone: editStoreForm.phone,
      manager: editStoreForm.manager, facilities: editStoreForm.facilities,
      status: editStoreForm.status as 'active' | 'inactive',
      settings: {
        checkInTime: editStoreForm.checkInTime, checkOutTime: editStoreForm.checkOutTime,
        cancelPolicy: editStoreForm.cancelPolicy, depositRule: editStoreForm.depositRule,
        depositAmount: editStoreForm.depositAmount, identityRequired: editStoreForm.identityRequired,
        petAllowed: editStoreForm.petAllowed, smokingAllowed: editStoreForm.smokingAllowed,
        lateCheckOut: { enabled: editStoreForm.lateCheckOutEnabled, fee: editStoreForm.lateCheckOutFee, maxHours: editStoreForm.lateCheckOutMaxHours },
        earlyCheckIn: { enabled: editStoreForm.earlyCheckInEnabled, fee: editStoreForm.earlyCheckInFee, earliestTime: editStoreForm.earlyCheckInEarliestTime },
      },
    };
    try {
      await apiPost('/api/stores', { action: 'editStore', storeId: showStoreDetail.id, ...editStoreForm });
      toast.success('门店信息已更新');
      setShowEditStoreModal(false);
      apiGet('/api/stores').then(setStores);
    } catch { toast.error('保存失败'); }
  };

  // Permission editor component
  const renderPermissionEditor = () => (
    <div className="space-y-2">
      {permissionTree.map(node => {
        const childKeys = node.children?.map(c => c.key) || [node.key];
        const allChecked = roleForm.permissions.includes('all') || childKeys.every(k => roleForm.permissions.includes(k));
        const someChecked = !allChecked && childKeys.some(k => roleForm.permissions.includes(k));
        const expanded = expandedPermNodes.has(node.key);
        return (
          <div key={node.key} className="border border-slate-100 rounded-xl overflow-hidden">
            <div className="flex items-center gap-2 p-3 bg-slate-50 cursor-pointer" onClick={() => togglePermNode(node.key)}>
              {expanded ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
              <input type="checkbox" checked={allChecked} ref={el => { if (el) el.indeterminate = someChecked; }} onChange={() => togglePermGroup(node)} className="rounded text-emerald-500" onClick={e => e.stopPropagation()} />
              <span className="font-medium text-sm text-slate-700">{node.label}</span>
              {allChecked && <span className="text-xs text-emerald-600 ml-auto">全选</span>}
              {someChecked && <span className="text-xs text-amber-600 ml-auto">部分</span>}
            </div>
            {expanded && node.children && (
              <div className="px-3 pb-3 space-y-1.5">
                {node.children.map(child => (
                  <label key={child.key} className="flex items-center gap-2 p-2 rounded-lg hover:bg-slate-50 cursor-pointer">
                    <input type="checkbox" checked={roleForm.permissions.includes('all') || roleForm.permissions.includes(child.key)} onChange={() => togglePermission(child.key)} className="rounded text-emerald-500" />
                    <span className="text-sm text-slate-600">{child.label}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );

  // Store selector component
  const renderStoreSelector = () => (
    <div>
      <label className="block text-sm font-medium text-slate-700 mb-1.5">管辖门店</label>
      <p className="text-xs text-slate-400 mb-2">根据角色自动分配，也可手动调整</p>
      <div className="flex items-center gap-2 mb-2">
        <button type="button" onClick={() => setStaffForm(prev => ({ ...prev, stores: storeOptions.map(s => s.id) }))} className="text-xs text-emerald-600 hover:text-emerald-700">全选</button>
        <span className="text-slate-300">|</span>
        <button type="button" onClick={() => setStaffForm(prev => ({ ...prev, stores: [] }))} className="text-xs text-slate-500 hover:text-slate-700">清空</button>
      </div>
      <div className="grid grid-cols-2 gap-2">
        {storeOptions.map(s => (
          <label key={s.id} className={`flex items-center gap-2 p-2 border rounded-lg cursor-pointer hover:bg-emerald-50/50 transition-colors ${staffForm.stores.includes(s.id) ? 'border-emerald-300 bg-emerald-50/50' : 'border-slate-200'}`}>
            <input type="checkbox" checked={staffForm.stores.includes(s.id)} onChange={e => {
              setStaffForm(prev => ({
                ...prev,
                stores: e.target.checked ? [...prev.stores, s.id] : prev.stores.filter(id => id !== s.id),
              }));
            }} className="rounded text-emerald-500" />
            <span className="text-sm text-slate-700">{s.name}</span>
          </label>
        ))}
      </div>
    </div>
  );

  return (
    <div className="space-y-5">
      <PageHeader title="团队管理" subtitle="管理员工账号、角色权限与操作日志" icon={<Users className="w-5 h-5" />} />
      <div className="flex items-center gap-4">
        <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />
        {activeTab === 'staff' && (
          <button onClick={openAddStaff} className="ml-auto px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors flex items-center gap-1.5 flex-shrink-0">
            <Users className="w-4 h-4" />新增员工
          </button>
        )}
        {activeTab === 'roles' && (
          <button onClick={openAddRole} className="ml-auto px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors flex items-center gap-1.5 flex-shrink-0">
            <Shield className="w-4 h-4" />新增角色
          </button>
        )}
        {activeTab === 'stores' && (
          <button onClick={() => { setStoreForm({ brandId: brands[0]?.id || '', name: '', address: '', phone: '', manager: '', facilities: [] }); setShowStoreModal(true); }} className="ml-auto px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors flex items-center gap-1.5 flex-shrink-0">
            <Building2 className="w-4 h-4" />新建门店
          </button>
        )}
        {activeTab === 'brands' && (
          <button onClick={() => { setEditBrand(null); setBrandForm({ name: '', description: '', logo: '', facilities: [] }); setShowBrandModal(true); }} className="ml-auto px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors flex items-center gap-1.5 flex-shrink-0">
            <Building2 className="w-4 h-4" />新建品牌
          </button>
        )}
      </div>

      {/* 员工管理 */}
      {activeTab === 'staff' && (
        <div className="space-y-4">
          <div className="grid grid-cols-4 gap-4">
            {[
              { label: '员工总数', value: stats.total, icon: <Users className="w-5 h-5" />, color: 'bg-blue-50 text-blue-600' },
              { label: '在职员工', value: stats.active, icon: <Check className="w-5 h-5" />, color: 'bg-emerald-50 text-emerald-600' },
              { label: '已禁用', value: stats.disabled, icon: <X className="w-5 h-5" />, color: 'bg-red-50 text-red-600' },
              { label: '今日在线', value: stats.onlineToday, icon: <Eye className="w-5 h-5" />, color: 'bg-violet-50 text-violet-600' },
            ].map(s => (
              <div key={s.label} className="bg-white rounded-2xl p-4 border border-slate-100">
                <div className="flex items-center justify-between">
                  <div><p className="text-xs text-slate-500">{s.label}</p><p className="text-2xl font-bold text-slate-800 mt-1">{s.value}</p></div>
                  <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.color}`}>{s.icon}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
            <div className="p-4 border-b border-slate-100 flex items-center gap-3">
              <div className="relative flex-1 max-w-xs">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                <input value={search} onChange={e => setSearch(e.target.value)} placeholder="搜索姓名/手机号/角色" className="w-full pl-9 pr-4 py-2 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" />
              </div>
            </div>
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead><tr className="bg-slate-50 text-slate-600">
                  <th className="text-left px-4 py-3 font-medium">员工</th>
                  <th className="text-left px-4 py-3 font-medium">角色</th>
                  <th className="text-left px-4 py-3 font-medium">管辖范围</th>
                  <th className="text-left px-4 py-3 font-medium">入职日期</th>
                  <th className="text-left px-4 py-3 font-medium">最后登录</th>
                  <th className="text-left px-4 py-3 font-medium">状态</th>
                  <th className="text-left px-4 py-3 font-medium">操作</th>
                </tr></thead>
                <tbody className="divide-y divide-slate-50">
                  {filteredStaff.map(s => (
                    <tr key={s.id} className="hover:bg-slate-50/50 transition-colors">
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-3">
                          <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-medium">{s.name[0]}</div>
                          <div><p className="font-medium text-slate-800">{s.name}</p><p className="text-xs text-slate-500">{s.phone}</p></div>
                        </div>
                      </td>
                      <td className="px-4 py-3"><span className={`inline-flex px-2.5 py-0.5 rounded-lg text-xs font-medium border ${roleColorMap[s.roleName] || 'bg-slate-50 text-slate-700 border-slate-200'}`}>{s.roleName}</span></td>
                      <td className="px-4 py-3 text-slate-600">{s.scope}</td>
                      <td className="px-4 py-3 text-slate-500">{s.joinDate}</td>
                      <td className="px-4 py-3 text-slate-500 text-xs">{s.lastLoginAt}</td>
                      <td className="px-4 py-3"><StatusBadge label={s.status === 'active' ? '正常' : '已禁用'} type={s.status === 'active' ? 'success' : 'danger'} /></td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-1">
                          <button onClick={() => openEditStaff(s)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-emerald-600 transition-colors" title="编辑"><Edit3 className="w-3.5 h-3.5" /></button>
                          <button onClick={() => handleToggleStaff(s)} className={`p-1.5 rounded-lg hover:bg-slate-100 transition-colors ${s.status === 'active' ? 'text-slate-500 hover:text-red-600' : 'text-red-500 hover:text-emerald-600'}`} title={s.status === 'active' ? '禁用' : '启用'}>
                            {s.status === 'active' ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                          </button>
                          <button onClick={() => openResetPwd(s)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-500 hover:text-amber-600 transition-colors" title="重置密码"><KeyRound className="w-3.5 h-3.5" /></button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* 角色管理 */}
      {activeTab === 'roles' && (
        <div className="space-y-4">
          {roles.map(role => (
            <div key={role.id} className="bg-white rounded-2xl border border-slate-100 overflow-hidden">
              <div className="p-5 cursor-pointer hover:bg-slate-50/50 transition-colors" onClick={() => toggleRoleExpand(role.id)}>
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-xl flex items-center justify-center text-white font-medium text-sm" style={{ backgroundColor: role.color }}>{role.name[0]}</div>
                    <div>
                      <div className="flex items-center gap-2">
                        <h3 className="font-semibold text-slate-800">{role.name}</h3>
                        {role.isPreset && <span className="px-2 py-0.5 bg-slate-100 text-slate-500 rounded-md text-xs">系统预设</span>}
                        {!role.isPreset && <span className="px-2 py-0.5 bg-emerald-50 text-emerald-600 rounded-md text-xs">自定义</span>}
                        <span className="px-2 py-0.5 bg-slate-50 text-slate-500 rounded-md text-xs">{role.scope === 'tenant' ? '租户级' : role.scope === 'brand' ? '品牌级' : '门店级'}</span>
                      </div>
                      <p className="text-sm text-slate-500 mt-0.5">{role.description}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="text-sm text-slate-500">{role.staffCount} 名员工</span>
                    {expandedRoles.has(role.id) ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
                  </div>
                </div>
              </div>
              {expandedRoles.has(role.id) && (
                <div className="px-5 pb-5 border-t border-slate-100 pt-4">
                  <h4 className="text-sm font-medium text-slate-700 mb-3">权限详情</h4>
                  <div className="space-y-3">
                    {permissionTree.map(node => {
                      const nodePermKeys = node.children ? node.children.map(c => c.key) : [node.key];
                      const hasAll = role.permissions.includes('all') || nodePermKeys.every(k => role.permissions.includes(k));
                      const hasSome = !hasAll && nodePermKeys.some(k => role.permissions.includes(k));
                      if (!hasAll && !hasSome && !role.permissions.includes('all')) return null;
                      return (
                        <div key={node.key} className="border border-slate-100 rounded-xl p-3">
                          <div className="flex items-center gap-2 mb-2">
                            {hasAll || role.permissions.includes('all') ? <Check className="w-4 h-4 text-emerald-500" /> : <div className="w-4 h-4 rounded border-2 border-amber-400 flex items-center justify-center"><div className="w-1.5 h-1.5 rounded-full bg-amber-400" /></div>}
                            <span className="font-medium text-sm text-slate-700">{node.label}</span>
                            {hasAll || role.permissions.includes('all') ? <span className="text-xs text-emerald-600">全部权限</span> : <span className="text-xs text-amber-600">部分权限</span>}
                          </div>
                          <div className="flex flex-wrap gap-1.5 ml-6">
                            {node.children?.filter(c => role.permissions.includes('all') || role.permissions.includes(c.key)).map(c => (
                              <span key={c.key} className="px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-md text-xs">{c.label}</span>
                            ))}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  {!role.isPreset && (
                    <div className="flex items-center gap-2 mt-4 pt-3 border-t border-slate-100">
                      <button onClick={() => openEditRole(role)} className="px-3 py-1.5 text-sm text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors flex items-center gap-1"><Edit3 className="w-3.5 h-3.5" />编辑角色</button>
                      <button onClick={() => openDeleteRole(role)} className="px-3 py-1.5 text-sm text-red-600 hover:bg-red-50 rounded-lg transition-colors flex items-center gap-1"><Trash2 className="w-3.5 h-3.5" />删除角色</button>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* 操作日志 */}
      {activeTab === 'logs' && (
        <div className="space-y-4">
          {/* 筛选栏 */}
          <div className="bg-white rounded-xl border border-slate-200 p-3 flex items-center gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <Filter className="w-4 h-4 text-slate-400" />
              <select
                className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                value={logModuleFilter}
                onChange={e => setLogModuleFilter(e.target.value)}
              >
                <option value="">全部模块</option>
                {logModules.map(m => (
                  <option key={m.key} value={m.key}>{m.label}</option>
                ))}
              </select>
            </div>
            <select
              className="px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
              value={logOperatorFilter}
              onChange={e => setLogOperatorFilter(e.target.value)}
            >
              <option value="">全部操作人</option>
              {logOperators.map(name => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
            <span className="text-sm text-slate-500">共 {filteredLogs.length} 条记录</span>
            <button onClick={handleExportLogs} className="ml-auto px-3 py-1.5 text-sm text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors flex items-center gap-1"><Download className="w-3.5 h-3.5" />导出日志</button>
          </div>

          {/* 日志表格 */}
          <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 whitespace-nowrap">时间</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 whitespace-nowrap">操作人</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 whitespace-nowrap">模块</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 whitespace-nowrap">操作</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 whitespace-nowrap">目标</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 whitespace-nowrap">详情</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500 whitespace-nowrap">IP</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {logsLoading ? (
                    <tr><td colSpan={7} className="text-center py-12 text-slate-400">加载中...</td></tr>
                  ) : filteredLogs.length === 0 ? (
                    <tr><td colSpan={7} className="text-center py-12 text-slate-400">暂无操作日志</td></tr>
                  ) : (
                    filteredLogs.map((log) => (
                      <tr key={log.id} className="hover:bg-slate-50/50">
                        <td className="px-4 py-3 text-sm text-slate-500 whitespace-nowrap">
                          {new Date(log.timestamp).toLocaleString('zh-CN')}
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-700 whitespace-nowrap">{log.staffName}</td>
                        <td className="px-4 py-3">
                          <span className="text-xs px-2 py-0.5 bg-slate-100 text-slate-600 rounded whitespace-nowrap">
                            {log.moduleLabel || moduleLabels[log.module] || log.module}
                          </span>
                        </td>
                        <td className="px-4 py-3 text-sm text-slate-600 whitespace-nowrap">{actionLabels[log.action] || log.action}</td>
                        <td className="px-4 py-3 text-sm text-slate-500 whitespace-nowrap">{log.target || '-'}</td>
                        <td className="px-4 py-3 text-sm text-slate-500 max-w-[200px] truncate">{log.detail || '-'}</td>
                        <td className="px-4 py-3 text-xs text-slate-400 font-mono whitespace-nowrap">{log.ip || '-'}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* ===== 门店管理 Tab ===== */}
      {activeTab === 'stores' && (
        <div className="space-y-4">
          {/* 统计卡片 */}
          <div className="grid grid-cols-4 gap-4">
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-emerald-50 rounded-xl flex items-center justify-center"><Building2 className="w-5 h-5 text-emerald-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{brands.length}</p><p className="text-xs text-slate-500">品牌数量</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-blue-50 rounded-xl flex items-center justify-center"><Building className="w-5 h-5 text-blue-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{activeStores}<span className="text-sm font-normal text-slate-400">/{stores.length}</span></p><p className="text-xs text-slate-500">运营中门店</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center"><BedDouble className="w-5 h-5 text-amber-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">{totalRooms}</p><p className="text-xs text-slate-500">总房量 · 均出租{avgOccupancy}%</p></div>
            </div>
            <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm p-4 flex items-center gap-3">
              <div className="w-10 h-10 bg-green-50 rounded-xl flex items-center justify-center"><CreditCard className="w-5 h-5 text-green-600" /></div>
              <div><p className="text-2xl font-bold text-slate-800">¥{(totalMonthRevenue / 10000).toFixed(1)}<span className="text-sm font-normal text-slate-400">万</span></p><p className="text-xs text-slate-500">本月总营收</p></div>
            </div>
          </div>

          <SectionTitle title="门店列表" />

          <div className="grid grid-cols-2 gap-4">
            {(selectedStoreId === 'all' ? stores : stores.filter(s => s.id === selectedStoreId)).map(store => (
              <div key={store.id} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                <div className="p-5">
                  {/* 门店头部 */}
                  <div className="flex items-start justify-between">
                    <div className="flex items-center gap-3">
                      <div className="w-12 h-12 bg-gradient-to-br from-emerald-500 to-emerald-600 rounded-xl flex items-center justify-center shadow-sm shadow-emerald-200">
                        <Building className="w-6 h-6 text-white" />
                      </div>
                      <div>
                        <h3 className="text-base font-semibold text-slate-800">{store.name}</h3>
                        <p className="text-xs text-slate-500 flex items-center gap-1">
                          {store.brandName}
                          {brands.find(b => b.id === store.brandId)?.type === 'platform' && (
                            <span className="inline-flex items-center gap-0.5 px-1 py-0.5 rounded text-[9px] font-medium bg-amber-50 text-amber-600 border border-amber-200">
                              <Lock className="w-2 h-2" />平台
                            </span>
                          )}
                        </p>
                      </div>
                    </div>
                    <StatusBadge label={store.status === 'active' ? '运营中' : '已停用'} type={store.status === 'active' ? 'success' : 'default'} />
                  </div>

                  {/* 运营指标 */}
                  <div className="grid grid-cols-4 gap-2.5 mt-4">
                    <div className="bg-slate-50/80 rounded-xl p-2.5 text-center">
                      <p className="text-lg font-bold text-slate-800">{store.todayOccupancy}%</p>
                      <p className="text-[10px] text-slate-500">今日出租率</p>
                    </div>
                    <div className="bg-slate-50/80 rounded-xl p-2.5 text-center">
                      <p className="text-lg font-bold text-emerald-600">¥{(store.todayRevenue / 1000).toFixed(1)}k</p>
                      <p className="text-[10px] text-slate-500">今日营收</p>
                    </div>
                    <div className="bg-slate-50/80 rounded-xl p-2.5 text-center">
                      <p className="text-lg font-bold text-slate-800">¥{(store.monthRevenue / 10000).toFixed(1)}万</p>
                      <p className="text-[10px] text-slate-500">月营收</p>
                    </div>
                    <div className="bg-slate-50/80 rounded-xl p-2.5 text-center">
                      <p className="text-lg font-bold text-amber-600 flex items-center justify-center gap-0.5"><Star className="w-3.5 h-3.5 fill-amber-400 text-amber-400" />{store.rating}</p>
                      <p className="text-[10px] text-slate-500">{store.reviewCount}条评价</p>
                    </div>
                  </div>

                  {/* 基本信息 */}
                  <div className="mt-3.5 space-y-1.5 text-xs text-slate-600">
                    <p className="flex items-center gap-1.5"><MapPin className="w-3.5 h-3.5 text-slate-400" />{store.address}</p>
                    <p className="flex items-center gap-1.5"><Phone className="w-3.5 h-3.5 text-slate-400" />{store.phone}</p>
                    <p className="flex items-center gap-1.5"><BedDouble className="w-3.5 h-3.5 text-slate-400" />{store.roomCount}间房 · 店长: {store.manager}</p>
                  </div>

                  {/* 设施 */}
                  <div className="mt-3 flex flex-wrap gap-1.5">
                    {store.facilities.slice(0, 5).map(f => (
                      <span key={f} className="flex items-center gap-1 px-2 py-0.5 bg-slate-50 rounded-md text-[11px] text-slate-600">{facilityIcons[f] || null}{f}</span>
                    ))}
                    {store.facilities.length > 5 && <span className="px-2 py-0.5 bg-slate-50 rounded-md text-[11px] text-slate-500">+{store.facilities.length - 5}</span>}
                  </div>

                  {/* 门店政策 */}
                  <div className="mt-3 pt-3 border-t border-slate-100 grid grid-cols-3 gap-2 text-[11px] text-slate-500">
                    <span className="flex items-center gap-1"><Clock className="w-3 h-3" />{store.settings.checkInTime}-{store.settings.checkOutTime}</span>
                    <span className="flex items-center gap-1"><Shield className="w-3 h-3" />{store.settings.cancelPolicy.slice(0, 10)}...</span>
                    <span className="flex items-center gap-1"><CreditCard className="w-3 h-3" />{store.settings.depositRule}</span>
                  </div>

                  {/* 操作按钮 */}
                  <div className="mt-3 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <div className="flex gap-2 text-[11px]">
                      {store.settings.petAllowed && <span className="px-2 py-0.5 bg-green-50 text-green-700 rounded-md">🐾 可携宠</span>}
                      {store.settings.smokingAllowed && <span className="px-2 py-0.5 bg-orange-50 text-orange-700 rounded-md">🚬 可吸烟</span>}
                      {store.settings.lateCheckOut.enabled && <span className="px-2 py-0.5 bg-blue-50 text-blue-700 rounded-md">延退 ¥{store.settings.lateCheckOut.fee}/h</span>}
                      {store.settings.earlyCheckIn.enabled && <span className="px-2 py-0.5 bg-purple-50 text-purple-700 rounded-md">早入 ¥{store.settings.earlyCheckIn.fee}</span>}
                    </div>
                    <button onClick={() => setShowStoreDetail(store)}
                      className="flex items-center gap-1 px-3 py-1.5 text-xs text-emerald-600 bg-emerald-50 hover:bg-emerald-100 rounded-lg transition-colors">
                      <Eye className="w-3.5 h-3.5" />查看详情
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* ===== 品牌管理 Tab ===== */}
      {activeTab === 'brands' && (
        <div className="space-y-6">
          {/* 平台品牌区 */}
          <div>
            <div className="flex items-center gap-2 mb-3">
              <Shield className="w-4 h-4 text-orange-500" />
              <h3 className="text-sm font-semibold text-slate-800">平台品牌</h3>
              <span className="text-xs text-slate-400">由平台统一配置标准与SOP，入驻门店自动继承</span>
            </div>
            <div className="space-y-4">
              {brands.filter(b => b.type === 'platform').map((brand) => {
                const brandStores = stores.filter(s => s.brandId === brand.id);
                const brandRooms = brandStores.reduce((sum, s) => sum + s.roomCount, 0);
                const brandOccupancy = brandStores.length > 0 ? Math.round(brandStores.reduce((s, st) => s + st.todayOccupancy, 0) / brandStores.length) : 0;
                const brandRevenue = brandStores.reduce((s, st) => s + st.monthRevenue, 0);
                return (
                  <div key={brand.id} className="bg-white rounded-2xl border border-orange-200/60 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                    <div className="flex items-stretch">
                      <div className="w-52 flex-shrink-0 p-5 flex flex-col items-center justify-center" style={{ background: `linear-gradient(135deg, ${brand.color}, ${brand.color}dd)` }}>
                        <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mb-3 overflow-hidden shadow-inner">
                        {brand.logo ? (
                          <img src={brand.logo} alt={brand.name} className="w-full h-full object-cover" />
                        ) : (
                          <svg className="w-8 h-8 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a2 2 0 012-2h2a2 2 0 012 2v5"/></svg>
                        )}
                      </div>
                        <h3 className="text-base font-bold text-white text-center">{brand.name}</h3>
                        <span className="px-2 py-0.5 bg-white/20 rounded text-[10px] text-white/90 flex items-center gap-1 mt-1.5"><Shield className="w-3 h-3" />平台品牌</span>
                        <p className="text-xs text-white/60 mt-1.5">{brand.createdAt ? new Date(brand.createdAt).toLocaleDateString('zh-CN') : '-'}</p>
                      </div>
                      <div className="flex-1 p-6">
                        <div className="flex items-start justify-between mb-4">
                          <div>
                            <p className="text-sm text-slate-500">{brand.description || '暂无描述'}</p>
                          </div>
                          <span className="px-3 py-1.5 bg-orange-50 border border-orange-200 rounded-lg text-xs text-orange-600 flex items-center gap-1.5 flex-shrink-0 ml-4"><Lock className="w-3.5 h-3.5" />平台配置不可修改</span>
                        </div>
                        <div className="flex items-center gap-6 mb-4">
                          <span className="text-sm text-slate-600 flex items-center gap-1"><Building className="w-4 h-4 text-slate-400" />{brandStores.length}家门店</span>
                          <span className="text-sm text-slate-600 flex items-center gap-1"><BedDouble className="w-4 h-4 text-slate-400" />{brandRooms}间房</span>
                          <span className="text-sm text-emerald-600 flex items-center gap-1">出租率 {brandOccupancy}%</span>
                          <span className="text-sm text-slate-600">月营收 ¥{(brandRevenue / 10000).toFixed(1)}万</span>
                        </div>
                        <div className="mt-3.5 pt-3.5 border-t border-slate-100">
                          <p className="text-xs font-medium text-slate-500 mb-2">品牌标准 <span className="text-orange-400 ml-1">（门店自动继承）</span></p>
                          <div className="grid grid-cols-4 gap-3">
                            <div className="flex items-center gap-2 text-xs text-slate-600"><Clock className="w-3.5 h-3.5 text-slate-400" />入住 {brand.standards.checkInTime} / 退房 {brand.standards.checkOutTime}</div>
                            <div className="flex items-center gap-2 text-xs text-slate-600"><Shield className="w-3.5 h-3.5 text-slate-400" />{brand.standards.cancelPolicy}</div>
                            <div className="flex items-center gap-2 text-xs text-slate-600"><CreditCard className="w-3.5 h-3.5 text-slate-400" />{brand.standards.depositRule}</div>
                            <div className="flex items-center gap-2 text-xs text-slate-600">{brand.standards.identityRequired ? '🪪 需实名' : '🪪 非必实'}</div>
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-slate-100">
                          <p className="text-xs font-medium text-slate-500 mb-2">SOP标准流程 <span className="text-orange-400 ml-1">（门店自动继承）</span></p>
                          <div className="flex flex-wrap gap-2">
                            {brand.sops.map(sop => (
                              <span key={sop} className="px-2.5 py-1 bg-orange-50 border border-orange-200/60 rounded-lg text-xs text-orange-700">{sop}</span>
                            ))}
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2 flex-wrap">
                          {brand.facilities.map(f => (
                            <span key={f} className="flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-md text-xs">{facilityIcons[f] || null}{f}</span>
                          ))}
                        </div>
                        {brandStores.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-slate-100">
                            <p className="text-xs font-medium text-slate-500 mb-2">入驻门店</p>
                            <div className="flex gap-2.5 flex-wrap">
                              {brandStores.map(store => (
                                <button key={store.id} onClick={() => { setActiveTab('stores'); setShowStoreDetail(store); }}
                                  className="flex items-center gap-2 px-3 py-1.5 bg-orange-50 hover:bg-emerald-50 border border-orange-200/60 hover:border-emerald-300 rounded-xl text-xs transition-colors group">
                                  <Building className="w-3.5 h-3.5 text-orange-400 group-hover:text-emerald-500" />
                                  <span className="text-slate-700 group-hover:text-emerald-700">{store.name}</span>
                                  <span className="text-slate-400">出租{store.todayOccupancy}%</span>
                                  <ChevronRight className="w-3 h-3 text-slate-300 group-hover:text-emerald-500" />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {brands.filter(b => b.type === 'platform').length === 0 && (
                <div className="text-center py-8 text-sm text-slate-400">暂无平台品牌</div>
              )}
            </div>
          </div>

          {/* 自营品牌区 */}
          <div>
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <User className="w-4 h-4 text-emerald-600" />
                <h3 className="text-sm font-semibold text-slate-800">自营品牌</h3>
                <span className="text-xs text-slate-400">可自由配置品牌标准、SOP与设施</span>
              </div>
              <button onClick={() => { setEditBrand(null); setBrandForm({ name: '', description: '', logo: '', facilities: [] }); setShowBrandModal(true); }}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors">
                <Plus className="w-3.5 h-3.5" />创建自营品牌
              </button>
            </div>
            <div className="space-y-4">
              {brands.filter(b => b.type !== 'platform').map((brand) => {
                const brandStores = stores.filter(s => s.brandId === brand.id);
                const brandRooms = brandStores.reduce((sum, s) => sum + s.roomCount, 0);
                const brandOccupancy = brandStores.length > 0 ? Math.round(brandStores.reduce((s, st) => s + st.todayOccupancy, 0) / brandStores.length) : 0;
                const brandRevenue = brandStores.reduce((s, st) => s + st.monthRevenue, 0);
                return (
                  <div key={brand.id} className="bg-white rounded-2xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow overflow-hidden">
                    <div className="flex items-stretch">
                      <div className="w-52 flex-shrink-0 p-5 flex flex-col items-center justify-center" style={{ background: `linear-gradient(135deg, ${brand.color}, ${brand.color}dd)` }}>
                        <div className="w-16 h-16 bg-white/20 rounded-2xl flex items-center justify-center mb-3 overflow-hidden shadow-inner">
                        {brand.logo ? (
                          <img src={brand.logo} alt={brand.name} className="w-full h-full object-cover" />
                        ) : (
                          <svg className="w-8 h-8 text-white/70" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M19 21V5a2 2 0 00-2-2H7a2 2 0 00-2 2v16m14 0h2m-2 0h-5m-9 0H3m2 0h5M9 7h1m-1 4h1m4-4h1m-1 4h1m-5 10v-5a2 2 0 012-2h2a2 2 0 012 2v5"/></svg>
                        )}
                      </div>
                        <h3 className="text-base font-bold text-white text-center">{brand.name}</h3>
                        <span className="px-2 py-0.5 bg-white/20 rounded text-[10px] text-white/90 flex items-center gap-1 mt-1.5"><User className="w-3 h-3" />自营品牌</span>
                        <p className="text-xs text-white/60 mt-1.5">{brand.createdAt ? new Date(brand.createdAt).toLocaleDateString('zh-CN') : '-'}</p>
                      </div>
                      <div className="flex-1 p-6">
                        <div className="flex items-start justify-between mb-4">
                          <div>
                            <p className="text-sm text-slate-500">{brand.description || '暂无描述'}</p>
                          </div>
                          {canEditStores && <div className="flex gap-1 flex-shrink-0 ml-4">
                            <button onClick={() => { setEditBrand(brand); setBrandForm({ name: brand.name, description: brand.description || '', logo: brand.logo || '', facilities: brand.facilities || [] }); setShowBrandModal(true); }}
                              className="p-2 hover:bg-slate-100 rounded-lg transition-colors"><Edit2 className="w-4 h-4 text-slate-500" /></button>
                            <button onClick={() => apiDelete(`/api/brands?id=${brand.id}`).then(() => apiGet('/api/brands').then(setBrands))}
                              className="p-2 hover:bg-red-50 rounded-lg transition-colors"><Trash2 className="w-4 h-4 text-red-400" /></button>
                          </div>}
                        </div>
                        <div className="mt-3.5 pt-3.5 border-t border-slate-100">
                          <p className="text-xs font-medium text-slate-500 mb-2">品牌标准</p>
                          <div className="grid grid-cols-4 gap-3">
                            <div className="flex items-center gap-2 text-xs text-slate-600"><Clock className="w-3.5 h-3.5 text-slate-400" />入住 {brand.standards.checkInTime} / 退房 {brand.standards.checkOutTime}</div>
                            <div className="flex items-center gap-2 text-xs text-slate-600"><Shield className="w-3.5 h-3.5 text-slate-400" />{brand.standards.cancelPolicy}</div>
                            <div className="flex items-center gap-2 text-xs text-slate-600"><CreditCard className="w-3.5 h-3.5 text-slate-400" />{brand.standards.depositRule}</div>
                            <div className="flex items-center gap-2 text-xs text-slate-600">{brand.standards.identityRequired ? '🪪 需实名' : '🪪 非必实'}</div>
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-slate-100">
                          <p className="text-xs font-medium text-slate-500 mb-2">SOP标准流程</p>
                          <div className="flex flex-wrap gap-2">
                            {brand.sops.map(sop => (
                              <span key={sop} className="px-2.5 py-1 bg-slate-50 border border-slate-200/80 rounded-lg text-xs text-slate-600">{sop}</span>
                            ))}
                          </div>
                        </div>
                        <div className="mt-3 pt-3 border-t border-slate-100 flex items-center gap-2 flex-wrap">
                          {brand.facilities.map(f => (
                            <span key={f} className="flex items-center gap-1 px-2 py-0.5 bg-emerald-50 text-emerald-700 rounded-md text-xs">{facilityIcons[f] || null}{f}</span>
                          ))}
                        </div>
                        {brandStores.length > 0 && (
                          <div className="mt-3 pt-3 border-t border-slate-100">
                            <p className="text-xs font-medium text-slate-500 mb-2">旗下门店</p>
                            <div className="flex gap-2.5 flex-wrap">
                              {brandStores.map(store => (
                                <button key={store.id} onClick={() => { setActiveTab('stores'); setShowStoreDetail(store); }}
                                  className="flex items-center gap-2 px-3 py-1.5 bg-slate-50 hover:bg-emerald-50 border border-slate-200/80 hover:border-emerald-300 rounded-xl text-xs transition-colors group">
                                  <Building className="w-3.5 h-3.5 text-slate-400 group-hover:text-emerald-500" />
                                  <span className="text-slate-700 group-hover:text-emerald-700">{store.name}</span>
                                  <span className="text-slate-400">出租{store.todayOccupancy}%</span>
                                  <ChevronRight className="w-3 h-3 text-slate-300 group-hover:text-emerald-500" />
                                </button>
                              ))}
                            </div>
                          </div>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })}
              {brands.filter(b => b.type !== 'platform').length === 0 && (
                <div className="text-center py-12 bg-white rounded-2xl border border-dashed border-slate-300">
                  <User className="w-10 h-10 text-slate-300 mx-auto mb-2" />
                  <p className="text-sm text-slate-400 mb-3">暂无自营品牌</p>
                  <button onClick={() => { setEditBrand(null); setBrandForm({ name: '', description: '', logo: '', facilities: [] }); setShowBrandModal(true); }}
                    className="inline-flex items-center gap-1.5 px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-lg text-xs font-medium transition-colors">
                    <Plus className="w-3.5 h-3.5" />创建自营品牌
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* ===== 添加员工弹窗 ===== */}
      {showAddStaff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowAddStaff(false)}>
          <div className="bg-white rounded-2xl w-[560px] h-[85vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex-shrink-0 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">添加员工</h3>
              <button onClick={() => setShowAddStaff(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">姓名 <span className="text-red-500">*</span></label><input value={staffForm.name} onChange={e => setStaffForm(prev => ({ ...prev, name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="请输入员工姓名" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">手机号 <span className="text-red-500">*</span></label><input value={staffForm.phone} onChange={e => setStaffForm(prev => ({ ...prev, phone: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="请输入手机号" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">角色 <span className="text-red-500">*</span></label>
                <select value={staffForm.roleId} onChange={e => setStaffForm(prev => ({ ...prev, roleId: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                  <option value="" disabled>请选择角色</option>
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name} - {r.description}</option>)}
                </select>
              </div>
              {renderStoreSelector()}
            </div>
            <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setShowAddStaff(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">取消</button>
              <button onClick={() => handleSaveStaff(false)} disabled={!staffForm.name || !staffForm.phone || !staffForm.roleId || saving} className="px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5">{saving && <Loader2 className="w-4 h-4 animate-spin" />}确认添加</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 编辑员工弹窗 ===== */}
      {showEditStaff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditStaff(false)}>
          <div className="bg-white rounded-2xl w-[560px] h-[85vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex-shrink-0 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">编辑员工</h3>
              <button onClick={() => setShowEditStaff(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-4">
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">姓名 <span className="text-red-500">*</span></label><input value={staffForm.name} onChange={e => setStaffForm(prev => ({ ...prev, name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">手机号 <span className="text-red-500">*</span></label><input value={staffForm.phone} onChange={e => setStaffForm(prev => ({ ...prev, phone: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">角色 <span className="text-red-500">*</span></label>
                <select value={staffForm.roleId} onChange={e => setStaffForm(prev => ({ ...prev, roleId: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                  <option value="" disabled>请选择角色</option>
                  {roles.map(r => <option key={r.id} value={r.id}>{r.name} - {r.description}</option>)}
                </select>
              </div>
              {renderStoreSelector()}
            </div>
            <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setShowEditStaff(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">取消</button>
              <button onClick={() => handleSaveStaff(true)} disabled={!staffForm.name || !staffForm.phone || !staffForm.roleId || saving} className="px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5">{saving && <Loader2 className="w-4 h-4 animate-spin" />}保存修改</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 重置密码确认弹窗 ===== */}
      {showResetPwd && resetPwdStaff && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowResetPwd(false)}>
          <div className="bg-white rounded-2xl w-[440px] shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full bg-amber-50 flex items-center justify-center"><KeyRound className="w-6 h-6 text-amber-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">重置密码</h3>
                  <p className="text-sm text-slate-500 mt-0.5">确认重置该员工的登录密码</p>
                </div>
              </div>
              <div className="bg-slate-50 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-full bg-emerald-100 text-emerald-700 flex items-center justify-center text-xs font-medium">{resetPwdStaff.name[0]}</div>
                  <div>
                    <p className="font-medium text-slate-800">{resetPwdStaff.name}</p>
                    <p className="text-xs text-slate-500">{resetPwdStaff.roleName} · {resetPwdStaff.phone}</p>
                  </div>
                </div>
              </div>
              <p className="text-sm text-slate-600">密码将被重置为默认密码 <span className="font-mono bg-slate-100 px-2 py-0.5 rounded text-xs">888888</span>，员工首次登录后需修改密码。系统将通过短信通知员工。</p>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => { setShowResetPwd(false); setResetPwdStaff(null); }} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">取消</button>
              <button onClick={handleResetPassword} disabled={saving} className="px-4 py-2 text-sm text-white bg-amber-600 hover:bg-amber-700 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5">{saving && <Loader2 className="w-4 h-4 animate-spin" />}确认重置</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 新建角色弹窗 ===== */}
      {showAddRole && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowAddRole(false)}>
          <div className="bg-white rounded-2xl w-[720px] h-[85vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex-shrink-0 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">新建角色</h3>
              <button onClick={() => setShowAddRole(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">角色名称 <span className="text-red-500">*</span></label><input value={roleForm.name} onChange={e => setRoleForm(prev => ({ ...prev, name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="例如：前台主管" /></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">数据范围</label>
                  <select value={roleForm.scope} onChange={e => setRoleForm(prev => ({ ...prev, scope: e.target.value as 'tenant' | 'brand' | 'store' }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                    <option value="tenant">租户级（全部门店）</option>
                    <option value="brand">品牌级（品牌下门店）</option>
                    <option value="store">门店级（所属门店）</option>
                  </select>
                </div>
              </div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">角色描述</label><input value={roleForm.description} onChange={e => setRoleForm(prev => ({ ...prev, description: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="描述该角色的职责" /></div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-3">权限配置</label>
                {renderPermissionEditor()}
              </div>
            </div>
            <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setShowAddRole(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">取消</button>
              <button onClick={() => handleSaveRole(false)} disabled={!roleForm.name || saving} className="px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5">{saving && <Loader2 className="w-4 h-4 animate-spin" />}确认创建</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 编辑角色弹窗 ===== */}
      {showEditRole && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowEditRole(false)}>
          <div className="bg-white rounded-2xl w-[720px] h-[85vh] flex flex-col shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex-shrink-0 px-6 py-4 border-b border-slate-100 flex items-center justify-between">
              <h3 className="text-lg font-semibold text-slate-800">编辑角色</h3>
              <button onClick={() => setShowEditRole(false)} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400"><X className="w-5 h-5" /></button>
            </div>
            <div className="flex-1 overflow-y-auto min-h-0 p-6 space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">角色名称 <span className="text-red-500">*</span></label><input value={roleForm.name} onChange={e => setRoleForm(prev => ({ ...prev, name: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
                <div><label className="block text-sm font-medium text-slate-700 mb-1.5">数据范围</label>
                  <select value={roleForm.scope} onChange={e => setRoleForm(prev => ({ ...prev, scope: e.target.value as 'tenant' | 'brand' | 'store' }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500">
                    <option value="tenant">租户级（全部门店）</option>
                    <option value="brand">品牌级（品牌下门店）</option>
                    <option value="store">门店级（所属门店）</option>
                  </select>
                </div>
              </div>
              <div><label className="block text-sm font-medium text-slate-700 mb-1.5">角色描述</label><input value={roleForm.description} onChange={e => setRoleForm(prev => ({ ...prev, description: e.target.value }))} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" /></div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-3">权限配置</label>
                {renderPermissionEditor()}
              </div>
            </div>
            <div className="flex-shrink-0 px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => setShowEditRole(false)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">取消</button>
              <button onClick={() => handleSaveRole(true)} disabled={!roleForm.name || saving} className="px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5">{saving && <Loader2 className="w-4 h-4 animate-spin" />}保存修改</button>
            </div>
          </div>
        </div>
      )}

      {/* ===== 删除角色确认弹窗 ===== */}
      {showDeleteRole && deletingRole && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center z-50" onClick={() => setShowDeleteRole(false)}>
          <div className="bg-white rounded-2xl w-[440px] shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="p-6">
              <div className="flex items-center gap-3 mb-4">
                <div className="w-12 h-12 rounded-full bg-red-50 flex items-center justify-center"><Trash2 className="w-6 h-6 text-red-600" /></div>
                <div>
                  <h3 className="text-lg font-semibold text-slate-800">删除角色</h3>
                  <p className="text-sm text-slate-500 mt-0.5">此操作不可撤销</p>
                </div>
              </div>
              <div className="bg-slate-50 rounded-xl p-4 mb-4">
                <div className="flex items-center gap-3">
                  <div className="w-8 h-8 rounded-lg flex items-center justify-center text-white font-medium text-xs" style={{ backgroundColor: deletingRole.color }}>{deletingRole.name[0]}</div>
                  <div>
                    <p className="font-medium text-slate-800">{deletingRole.name}</p>
                    <p className="text-xs text-slate-500">{deletingRole.description} · {deletingRole.staffCount} 名员工</p>
                  </div>
                </div>
              </div>
              {deletingRole.staffCount > 0 && (
                <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 mb-4">
                  <p className="text-sm text-amber-700">该角色下有 {deletingRole.staffCount} 名员工，删除后这些员工将失去对应权限，请先调整其角色。</p>
                </div>
              )}
              <p className="text-sm text-slate-600">确认删除角色 <span className="font-medium text-slate-800">「{deletingRole.name}」</span>？</p>
            </div>
            <div className="px-6 py-4 border-t border-slate-100 flex justify-end gap-3">
              <button onClick={() => { setShowDeleteRole(false); setDeletingRole(null); }} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-xl transition-colors">取消</button>
              <button onClick={handleDeleteRole} disabled={saving} className="px-4 py-2 text-sm text-white bg-red-600 hover:bg-red-700 rounded-xl transition-colors disabled:opacity-50 flex items-center gap-1.5">{saving && <Loader2 className="w-4 h-4 animate-spin" />}确认删除</button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 品牌编辑弹窗 ===================== */}
      {showBrandModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowBrandModal(false)}>
          <div className="bg-white rounded-2xl w-[560px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <h3 className="text-lg font-semibold text-slate-800">{editBrand ? '编辑品牌' : '新建品牌'}</h3>
              <button onClick={() => setShowBrandModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">品牌名称</label>
                <input value={brandForm.name} onChange={e => setBrandForm({ ...brandForm, name: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="请输入品牌名称" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">品牌Logo</label>
                <input ref={logoInputRef} type="file" accept="image/*" className="hidden" onChange={handleLogoUpload} />
                {brandForm.logo ? (
                  <div className="relative w-full h-24 rounded-xl overflow-hidden bg-slate-100">
                    <img src={brandForm.logo} alt="品牌Logo" className="w-full h-full object-contain" />
                    <button onClick={() => setBrandForm({ ...brandForm, logo: '' })}
                      className="absolute top-1 right-1 w-6 h-6 bg-red-500 text-white rounded-full text-xs flex items-center justify-center hover:bg-red-600">✕</button>
                  </div>
                ) : (
                  <div onClick={() => logoInputRef.current?.click()}
                    className="w-full h-24 border-2 border-dashed border-slate-200 rounded-xl flex flex-col items-center justify-center gap-1 text-slate-400 hover:border-emerald-500 hover:text-emerald-500 transition-colors cursor-pointer">
                    {logoUploading ? (
                      <span className="text-sm">上传中...</span>
                    ) : (<><Upload className="w-5 h-5" /><span className="text-sm">点击上传Logo（建议200x200px）</span></>)}
                  </div>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">品牌介绍</label>
                <textarea value={brandForm.description} onChange={e => setBrandForm({ ...brandForm, description: e.target.value })}
                  rows={3} className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 resize-none" placeholder="请输入品牌介绍" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">品牌设施</label>
                <div className="flex flex-wrap gap-2">
                  {FACILITY_OPTIONS.map(f => (
                    <button key={f} onClick={() => setBrandForm({ ...brandForm, facilities: brandForm.facilities.includes(f) ? brandForm.facilities.filter(x => x !== f) : [...brandForm.facilities, f] })}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${brandForm.facilities.includes(f) ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                      {facilityIcons[f]}{f}
                    </button>
                  ))}
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowBrandModal(false)} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleSaveBrand} className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25">保存</button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 新建门店弹窗 ===================== */}
      {showStoreModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowStoreModal(false)}>
          <div className="bg-white rounded-2xl w-[620px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between p-5 border-b border-slate-100 flex-shrink-0">
              <h3 className="text-lg font-semibold text-slate-800">新建门店</h3>
              <button onClick={() => setShowStoreModal(false)} className="p-1 hover:bg-slate-100 rounded-lg"><X className="w-5 h-5 text-slate-400" /></button>
            </div>
            <div className="p-5 space-y-4 flex-1 overflow-y-auto min-h-0">
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">所属品牌 <span className="text-red-500">*</span></label>
                <select value={storeForm.brandId} onChange={e => setStoreForm({ ...storeForm, brandId: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 bg-white">
                  <option value="">请选择品牌</option>
                  <optgroup label="🏷️ 平台品牌（标准配置不可修改）">
                    {brands.filter(b => b.type === 'platform').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </optgroup>
                  <optgroup label="✏️ 自主品牌（可自定义配置）">
                    {brands.filter(b => b.type !== 'platform').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                  </optgroup>
                </select>
                {storeForm.brandId && brands.find(b => b.id === storeForm.brandId)?.type === 'platform' && (
                  <p className="mt-1.5 text-xs text-amber-600 flex items-center gap-1">
                    <Lock className="w-3 h-3" /> 入驻平台品牌将继承品牌标准和SOP，不可修改
                  </p>
                )}
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">门店名称 <span className="text-red-500">*</span></label>
                <input value={storeForm.name} onChange={e => setStoreForm({ ...storeForm, name: e.target.value })}
                  className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="如：久栖·精品 杭州西湖店" />
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">门店地址</label>
                <div className="relative">
                  <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input value={storeForm.address} onChange={e => setStoreForm({ ...storeForm, address: e.target.value })}
                    className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="详细地址" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">联系电话</label>
                  <div className="relative">
                    <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                    <input value={storeForm.phone} onChange={e => setStoreForm({ ...storeForm, phone: e.target.value })}
                      className="w-full pl-10 pr-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="门店电话" />
                  </div>
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">店长</label>
                  <input value={storeForm.manager} onChange={e => setStoreForm({ ...storeForm, manager: e.target.value })}
                    className="w-full px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500" placeholder="店长姓名" />
                </div>
              </div>
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">门店设施</label>
                <div className="flex flex-wrap gap-2">
                  {FACILITY_OPTIONS.map(f => (
                    <button key={f} onClick={() => setStoreForm({ ...storeForm, facilities: storeForm.facilities.includes(f) ? storeForm.facilities.filter(x => x !== f) : [...storeForm.facilities, f] })}
                      className={`flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs border transition-colors ${storeForm.facilities.includes(f) ? 'bg-emerald-50 border-emerald-300 text-emerald-700' : 'bg-white border-slate-200 text-slate-600 hover:border-slate-300'}`}>
                      {facilityIcons[f]}{f}
                    </button>
                  ))}
                </div>
              </div>
              <div className="bg-amber-50 border border-amber-200 rounded-xl p-3 flex items-start gap-2">
                <Shield className="w-4 h-4 text-amber-500 mt-0.5 flex-shrink-0" />
                <p className="text-xs text-amber-700">创建门店后，可在门店详情中配置入住/退房时间、取消政策、押金规则等业务参数。</p>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowStoreModal(false)} className="px-5 py-2.5 bg-white border border-slate-200 text-slate-600 rounded-xl text-sm font-medium hover:bg-slate-50">取消</button>
              <button onClick={handleSaveStore} disabled={!storeForm.name || !storeForm.brandId}
                className="px-5 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed">确认创建</button>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 门店详情弹窗 ===================== */}
      {showStoreDetail && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowStoreDetail(null)}>
          <div className="bg-white rounded-2xl w-[700px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 relative flex-shrink-0">
              <button onClick={() => setShowStoreDetail(null)} className="absolute top-4 right-4 p-1 hover:bg-white/20 rounded-lg"><X className="w-5 h-5 text-white" /></button>
              {canEditStores && <button onClick={() => showStoreDetail && handleEditStore(showStoreDetail)} className="absolute top-4 right-12 p-1.5 hover:bg-white/20 rounded-lg flex items-center gap-1"><Edit2 className="w-4 h-4 text-white" /><span className="text-xs text-white/90">编辑</span></button>}
              <div className="flex items-center gap-3">
                <div className="w-14 h-14 bg-white/20 rounded-2xl flex items-center justify-center"><Building className="w-7 h-7 text-white" /></div>
                <div>
                  <h3 className="text-xl font-bold text-white">{showStoreDetail.name}</h3>
                  <p className="text-sm text-white/80 flex items-center gap-2">
                    {showStoreDetail.brandName}
                    {brands.find(b => b.id === showStoreDetail.brandId)?.type === 'platform' && (
                      <span className="inline-flex items-center gap-1 px-1.5 py-0.5 rounded text-[10px] font-medium bg-amber-400/20 text-amber-200 border border-amber-400/30">
                        <Lock className="w-2.5 h-2.5" />平台品牌
                      </span>
                    )}
                    · {showStoreDetail.status === 'active' ? '运营中' : '已停用'}
                  </p>
                </div>
              </div>
            </div>
            <div className="p-5 space-y-5 flex-1 overflow-y-auto min-h-0">
              <div className="grid grid-cols-4 gap-3">
                <div className="bg-emerald-50 rounded-xl p-3 text-center">
                  <p className="text-xl font-bold text-emerald-700">{showStoreDetail.todayOccupancy}%</p><p className="text-xs text-emerald-600">今日出租率</p>
                </div>
                <div className="bg-blue-50 rounded-xl p-3 text-center">
                  <p className="text-xl font-bold text-blue-700">¥{(showStoreDetail.todayRevenue / 1000).toFixed(1)}k</p><p className="text-xs text-blue-600">今日营收</p>
                </div>
                <div className="bg-purple-50 rounded-xl p-3 text-center">
                  <p className="text-xl font-bold text-purple-700">¥{(showStoreDetail.monthRevenue / 10000).toFixed(1)}万</p><p className="text-xs text-purple-600">月营收</p>
                </div>
                <div className="bg-amber-50 rounded-xl p-3 text-center">
                  <p className="text-xl font-bold text-amber-700 flex items-center justify-center gap-1"><Star className="w-4 h-4 fill-amber-400 text-amber-400" />{showStoreDetail.rating}</p>
                  <p className="text-xs text-amber-600">{showStoreDetail.reviewCount}条评价</p>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-2">基本信息</h4>
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <p className="flex items-center gap-2 text-slate-600"><MapPin className="w-4 h-4 text-slate-400" />{showStoreDetail.address}</p>
                  <p className="flex items-center gap-2 text-slate-600"><Phone className="w-4 h-4 text-slate-400" />{showStoreDetail.phone}</p>
                  <p className="flex items-center gap-2 text-slate-600"><BedDouble className="w-4 h-4 text-slate-400" />{showStoreDetail.roomCount}间房</p>
                  <p className="flex items-center gap-2 text-slate-600">👤 店长: {showStoreDetail.manager}</p>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-2">门店政策</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <span className="text-sm text-slate-600 flex items-center gap-1.5"><Clock className="w-4 h-4 text-slate-400" />入住/退房</span>
                    <span className="text-sm font-medium text-slate-800">{showStoreDetail.settings.checkInTime}-{showStoreDetail.settings.checkOutTime}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <span className="text-sm text-slate-600 flex items-center gap-1.5"><Shield className="w-4 h-4 text-slate-400" />取消政策</span>
                    <span className="text-sm font-medium text-slate-800">{showStoreDetail.settings.cancelPolicy}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <span className="text-sm text-slate-600 flex items-center gap-1.5"><CreditCard className="w-4 h-4 text-slate-400" />押金规则</span>
                    <span className="text-sm font-medium text-slate-800">{showStoreDetail.settings.depositRule}{showStoreDetail.settings.depositAmount > 0 ? ` ¥${showStoreDetail.settings.depositAmount}` : ''}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <span className="text-sm text-slate-600 flex items-center gap-1.5">🪪 实名认证</span>
                    <span className="text-sm font-medium text-slate-800">{showStoreDetail.settings.identityRequired ? '必须' : '可选'}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <span className="text-sm text-slate-600">🐾 携带宠物</span>
                    <span className={`text-sm font-medium ${showStoreDetail.settings.petAllowed ? 'text-emerald-600' : 'text-red-500'}`}>{showStoreDetail.settings.petAllowed ? '允许' : '不允许'}</span>
                  </div>
                  <div className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                    <span className="text-sm text-slate-600">🚬 吸烟</span>
                    <span className={`text-sm font-medium ${showStoreDetail.settings.smokingAllowed ? 'text-amber-600' : 'text-red-500'}`}>{showStoreDetail.settings.smokingAllowed ? '允许' : '禁止'}</span>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-2">增值服务</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div className={`p-3 rounded-xl border ${showStoreDetail.settings.lateCheckOut.enabled ? 'border-blue-200 bg-blue-50' : 'border-slate-200 bg-slate-50'}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-700">延迟退房</span>
                      <StatusBadge label={showStoreDetail.settings.lateCheckOut.enabled ? '已开启' : '未开启'} type={showStoreDetail.settings.lateCheckOut.enabled ? 'success' : 'default'} />
                    </div>
                    {showStoreDetail.settings.lateCheckOut.enabled && (
                      <p className="text-xs text-slate-500 mt-1">最多延{showStoreDetail.settings.lateCheckOut.maxHours}小时 · ¥{showStoreDetail.settings.lateCheckOut.fee}/小时</p>
                    )}
                  </div>
                  <div className={`p-3 rounded-xl border ${showStoreDetail.settings.earlyCheckIn.enabled ? 'border-purple-200 bg-purple-50' : 'border-slate-200 bg-slate-50'}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium text-slate-700">提前入住</span>
                      <StatusBadge label={showStoreDetail.settings.earlyCheckIn.enabled ? '已开启' : '未开启'} type={showStoreDetail.settings.earlyCheckIn.enabled ? 'success' : 'default'} />
                    </div>
                    {showStoreDetail.settings.earlyCheckIn.enabled && (
                      <p className="text-xs text-slate-500 mt-1">最早{showStoreDetail.settings.earlyCheckIn.earliestTime} · ¥{showStoreDetail.settings.earlyCheckIn.fee}/次</p>
                    )}
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-2">智能设备</h4>
                <div className="grid grid-cols-4 gap-2">
                  {['smart_lock', 'meter', 'kiosk', 'thermostat'].map(type => {
                    const typeNames: Record<string, string> = { smart_lock: '智能门锁', meter: '水电表', kiosk: '入住机', thermostat: '温控' };
                    const typeDevices = devices.filter(d => d.storeId === showStoreDetail.id && d.type === type);
                    const onlineCount = typeDevices.filter(d => d.status === 'online').length;
                    return (
                      <div key={type} className={`p-2.5 rounded-xl text-center border ${onlineCount === typeDevices.length && typeDevices.length > 0 ? 'border-emerald-200 bg-emerald-50' : 'border-slate-200 bg-slate-50'}`}>
                        <p className="text-sm font-medium text-slate-700">{typeNames[type]}</p>
                        <p className="text-xs text-slate-500 mt-0.5">{typeDevices.length === 0 ? '无' : `${onlineCount}/${typeDevices.length} 在线`}</p>
                      </div>
                    );
                  })}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ===================== 编辑门店弹窗 ===================== */}
      {showEditStoreModal && (
        <div className="fixed inset-0 bg-black/40 z-50 flex items-center justify-center" onClick={() => setShowEditStoreModal(false)}>
          <div className="bg-white rounded-2xl w-[640px] h-[85vh] shadow-xl flex flex-col" onClick={e => e.stopPropagation()}>
            <div className="bg-gradient-to-r from-emerald-500 to-emerald-600 p-5 relative flex-shrink-0">
              <button onClick={() => setShowEditStoreModal(false)} className="absolute top-4 right-4 p-1 hover:bg-white/20 rounded-lg"><X className="w-5 h-5 text-white" /></button>
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-white/20 rounded-xl flex items-center justify-center"><Edit2 className="w-5 h-5 text-white" /></div>
                <h3 className="text-lg font-bold text-white">编辑门店信息</h3>
              </div>
            </div>
            <div className="p-5 space-y-5 flex-1 overflow-y-auto min-h-0">
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-3">基本信息</h4>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">所属品牌</label>
                    <select value={editStoreForm.brandId} onChange={e => setEditStoreForm(f => ({ ...f, brandId: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500">
                      <optgroup label="🏷️ 平台品牌">
                        {brands.filter(b => b.type === 'platform').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </optgroup>
                      <optgroup label="✏️ 自主品牌">
                        {brands.filter(b => b.type !== 'platform').map(b => <option key={b.id} value={b.id}>{b.name}</option>)}
                      </optgroup>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">门店名称 <span className="text-red-400">*</span></label>
                    <input value={editStoreForm.name} onChange={e => setEditStoreForm(f => ({ ...f, name: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" placeholder="请输入门店名称" />
                  </div>
                  <div className="col-span-2">
                    <label className="block text-xs text-slate-500 mb-1">门店地址</label>
                    <div className="relative">
                      <MapPin className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input value={editStoreForm.address} onChange={e => setEditStoreForm(f => ({ ...f, address: e.target.value }))} className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" placeholder="请输入门店地址" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">联系电话</label>
                    <div className="relative">
                      <Phone className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                      <input value={editStoreForm.phone} onChange={e => setEditStoreForm(f => ({ ...f, phone: e.target.value }))} className="w-full pl-9 pr-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" placeholder="请输入联系电话" />
                    </div>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">店长姓名</label>
                    <input value={editStoreForm.manager} onChange={e => setEditStoreForm(f => ({ ...f, manager: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" placeholder="请输入店长姓名" />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">门店状态</label>
                    <select value={editStoreForm.status} onChange={e => setEditStoreForm(f => ({ ...f, status: e.target.value }))} className="w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500">
                      <option value="active">运营中</option>
                      <option value="inactive">已停用</option>
                    </select>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-3">门店设施</h4>
                <div className="flex flex-wrap gap-2">
                  {FACILITY_OPTIONS.map(f => (
                    <button key={f} onClick={() => setEditStoreForm(form => ({ ...form, facilities: form.facilities.includes(f) ? form.facilities.filter(x => x !== f) : [...form.facilities, f] }))} className={`px-3 py-1.5 rounded-lg text-xs font-medium flex items-center gap-1 border transition-colors ${editStoreForm.facilities.includes(f) ? 'border-emerald-300 bg-emerald-50 text-emerald-700' : 'border-slate-200 bg-white text-slate-500 hover:border-slate-300'}`}>
                      {facilityIcons[f]}{f}
                    </button>
                  ))}
                </div>
              </div>
              <div>
                <div className="flex items-center gap-2 mb-3">
                  <h4 className="text-sm font-medium text-slate-700">门店政策</h4>
                  {editingStoreIsPlatform && (
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-amber-50 text-amber-700 border border-amber-200">
                      <Lock className="w-3 h-3" /> 继承品牌标准，不可修改
                    </span>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-3">
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">入住时间</label>
                    <input type="time" value={editStoreForm.checkInTime} onChange={e => setEditStoreForm(f => ({ ...f, checkInTime: e.target.value }))} disabled={editingStoreIsPlatform}
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${editingStoreIsPlatform ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">退房时间</label>
                    <input type="time" value={editStoreForm.checkOutTime} onChange={e => setEditStoreForm(f => ({ ...f, checkOutTime: e.target.value }))} disabled={editingStoreIsPlatform}
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${editingStoreIsPlatform ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`} />
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">取消政策</label>
                    <select value={editStoreForm.cancelPolicy} onChange={e => setEditStoreForm(f => ({ ...f, cancelPolicy: e.target.value }))} disabled={editingStoreIsPlatform}
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${editingStoreIsPlatform ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`}>
                      <option value="flexible">灵活取消</option>
                      <option value="moderate">适度取消</option>
                      <option value="strict">严格取消</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-xs text-slate-500 mb-1">押金规则</label>
                    <select value={editStoreForm.depositRule} onChange={e => setEditStoreForm(f => ({ ...f, depositRule: e.target.value }))} disabled={editingStoreIsPlatform}
                      className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${editingStoreIsPlatform ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`}>
                      <option value="none">无押金</option>
                      <option value="fixed">固定金额</option>
                      <option value="first_night">首晚房费</option>
                    </select>
                  </div>
                  {editStoreForm.depositRule === 'fixed' && (
                    <div>
                      <label className="block text-xs text-slate-500 mb-1">押金金额(元)</label>
                      <input type="number" value={editStoreForm.depositAmount} onChange={e => setEditStoreForm(f => ({ ...f, depositAmount: Number(e.target.value) }))} disabled={editingStoreIsPlatform}
                        className={`w-full px-3 py-2 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500 ${editingStoreIsPlatform ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`} />
                    </div>
                  )}
                  <div className="flex items-center gap-3">
                    <label className={`flex items-center gap-2 ${editingStoreIsPlatform ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={editStoreForm.identityRequired} onChange={e => setEditStoreForm(f => ({ ...f, identityRequired: e.target.checked }))} disabled={editingStoreIsPlatform} className="w-4 h-4 text-emerald-600 rounded border-slate-300" />
                      <span className="text-sm text-slate-700">实名认证</span>
                    </label>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className={`flex items-center gap-2 ${editingStoreIsPlatform ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={editStoreForm.petAllowed} onChange={e => setEditStoreForm(f => ({ ...f, petAllowed: e.target.checked }))} disabled={editingStoreIsPlatform} className="w-4 h-4 text-emerald-600 rounded border-slate-300" />
                      <span className="text-sm text-slate-700">允许宠物</span>
                    </label>
                  </div>
                  <div className="flex items-center gap-3">
                    <label className={`flex items-center gap-2 ${editingStoreIsPlatform ? 'cursor-not-allowed opacity-50' : 'cursor-pointer'}`}>
                      <input type="checkbox" checked={editStoreForm.smokingAllowed} onChange={e => setEditStoreForm(f => ({ ...f, smokingAllowed: e.target.checked }))} disabled={editingStoreIsPlatform} className="w-4 h-4 text-emerald-600 rounded border-slate-300" />
                      <span className="text-sm text-slate-700">允许吸烟</span>
                    </label>
                  </div>
                </div>
              </div>
              <div>
                <h4 className="text-sm font-medium text-slate-700 mb-3">增值服务</h4>
                <div className="space-y-3">
                  <div className="p-3 border border-slate-200 rounded-xl">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-slate-700">延迟退房</span>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={editStoreForm.lateCheckOutEnabled} onChange={e => setEditStoreForm(f => ({ ...f, lateCheckOutEnabled: e.target.checked }))} className="w-4 h-4 text-emerald-600 rounded border-slate-300" />
                        <span className="text-xs text-slate-500">{editStoreForm.lateCheckOutEnabled ? '已开启' : '未开启'}</span>
                      </label>
                    </div>
                    {editStoreForm.lateCheckOutEnabled && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">最多延(小时)</label>
                          <input type="number" value={editStoreForm.lateCheckOutMaxHours} onChange={e => setEditStoreForm(f => ({ ...f, lateCheckOutMaxHours: Number(e.target.value) }))} className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">费用(元/小时)</label>
                          <input type="number" value={editStoreForm.lateCheckOutFee} onChange={e => setEditStoreForm(f => ({ ...f, lateCheckOutFee: Number(e.target.value) }))} className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                        </div>
                      </div>
                    )}
                  </div>
                  <div className="p-3 border border-slate-200 rounded-xl">
                    <div className="flex items-center justify-between mb-2">
                      <span className="text-sm font-medium text-slate-700">提前入住</span>
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={editStoreForm.earlyCheckInEnabled} onChange={e => setEditStoreForm(f => ({ ...f, earlyCheckInEnabled: e.target.checked }))} className="w-4 h-4 text-emerald-600 rounded border-slate-300" />
                        <span className="text-xs text-slate-500">{editStoreForm.earlyCheckInEnabled ? '已开启' : '未开启'}</span>
                      </label>
                    </div>
                    {editStoreForm.earlyCheckInEnabled && (
                      <div className="grid grid-cols-2 gap-2">
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">最早入住时间</label>
                          <input type="time" value={editStoreForm.earlyCheckInEarliestTime} onChange={e => setEditStoreForm(f => ({ ...f, earlyCheckInEarliestTime: e.target.value }))} className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                        </div>
                        <div>
                          <label className="block text-xs text-slate-500 mb-1">费用(元/次)</label>
                          <input type="number" value={editStoreForm.earlyCheckInFee} onChange={e => setEditStoreForm(f => ({ ...f, earlyCheckInFee: Number(e.target.value) }))} className="w-full px-3 py-1.5 border border-slate-200 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500" />
                        </div>
                      </div>
                    )}
                  </div>
                </div>
              </div>
            </div>
            <div className="flex justify-end gap-3 p-5 border-t border-slate-100 flex-shrink-0">
              <button onClick={() => setShowEditStoreModal(false)} className="px-5 py-2.5 text-sm text-slate-600 hover:bg-slate-100 rounded-lg">取消</button>
              <button onClick={handleSaveEditStore} disabled={!editStoreForm.name} className="px-5 py-2.5 text-sm text-white bg-emerald-500 hover:bg-emerald-600 disabled:bg-slate-300 rounded-lg font-medium">保存修改</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
