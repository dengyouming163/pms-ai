'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useState, useRef, useEffect } from 'react';
import {
  LayoutDashboard,
  Building2,
  BedDouble,
  DollarSign,
  Share2,
  Wallet,
  BarChart3,
  Users,
  UserCircle,
  Settings,
  Check,
  Loader2,
  ClipboardList,
  LogOut,
  X,
  Megaphone,
  TrendingUp,
  Sparkles,
  MapPin,
  Image,
} from 'lucide-react';
import { useStore } from '@/lib/context/store-context';
import { useAuth } from '@/lib/auth/auth-context';
import { useSidebar } from '@/lib/context/sidebar-context';

const menuItems = [
  { href: '/rooms', icon: BedDouble, label: '房态管理', permission: 'rooms:view' },
  { href: '/orders', icon: ClipboardList, label: '订单管理', permission: 'orders:view' },
  { href: '/pricing-center', icon: DollarSign, label: '定价中心', permission: 'pricing:view' },
  { href: '/channels', icon: Share2, label: '渠道管理', permission: 'channels:view' },
  { href: '/customers', icon: UserCircle, label: '客户管理', permission: 'customers:view' },
  { href: '/finance', icon: Wallet, label: '收支明细', permission: 'finance:view' },
  { href: '/staff', icon: Users, label: '团队管理', permission: 'staff:view' },
  { href: '/settings', icon: Settings, label: '系统设置', permission: 'settings:view' },
  { href: '/assets', icon: Image, label: '素材资源', permission: '' },
  { href: '/property-profile', icon: Building2, label: '民宿档案', permission: 'settings:view' },
  { href: '/kb-guides', icon: MapPin, label: '周边推荐', permission: 'settings:view' },
];

function hasPermission(permissions: string[], required: string): boolean {
  if (!required) return true; // 空权限 = 所有角色可见
  if (permissions.length === 0) return true; // 无权限数据时默认全开
  if (permissions.includes('all') || permissions.includes('*')) return true;
  return permissions.includes(required);
}

function StoreSelector() {
  const { currentStore, stores, setCurrentStore, loading } = useStore();
  const [open, setOpen] = useState(false);
  const dropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClickOutside(e: MouseEvent) {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    }
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Group stores by brand
  const grouped = stores.reduce<Record<string, { brandName: string; items: typeof stores }>>((acc, store) => {
    if (!acc[store.brandId]) {
      acc[store.brandId] = { brandName: store.brandName, items: [] };
    }
    acc[store.brandId].items.push(store);
    return acc;
  }, {});

  if (loading) {
    return (
      <div className="px-4 py-3 border-b border-slate-100">
        <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg text-sm text-slate-400">
          <Loader2 className="w-4 h-4 animate-spin" />
          <span>加载门店...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 py-3 border-b border-slate-100" ref={dropdownRef}>
      <button
        onClick={() => setOpen(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 bg-slate-50 hover:bg-slate-100 rounded-lg text-sm text-slate-700 transition-colors"
      >
        <Building2 className="w-4 h-4 text-emerald-600 shrink-0" />
        <span className="flex-1 truncate text-left">{currentStore?.fullName || '选择门店'}</span>
        <svg className={`w-4 h-4 text-slate-400 transition-transform shrink-0 ${open ? 'rotate-180' : ''}`} fill="none" viewBox="0 0 24 24" stroke="currentColor">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>

      {open && (
        <div className="absolute left-3 right-3 mt-1 bg-white rounded-xl shadow-lg border border-slate-200 z-50 overflow-hidden max-h-80 overflow-y-auto">
          {Object.entries(grouped).map(([brandId, group]) => (
            <div key={brandId}>
              <div className="px-3 py-2 text-xs font-medium text-slate-400 bg-slate-50 sticky top-0">
                {group.brandName}
              </div>
              {group.items.map(store => {
                const isSelected = currentStore?.id === store.id;
                return (
                  <button
                    key={store.id}
                    onClick={() => {
                      setCurrentStore(store);
                      setOpen(false);
                    }}
                    className={`w-full flex items-center gap-2 px-3 py-2.5 text-sm transition-colors ${
                      isSelected
                        ? 'bg-emerald-50 text-emerald-700'
                        : 'text-slate-700 hover:bg-slate-50'
                    }`}
                  >
                    <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${isSelected ? 'bg-emerald-500' : 'bg-slate-300'}`} />
                    <span className="flex-1 truncate text-left">{store.name}</span>
                    {isSelected && <Check className="w-4 h-4 text-emerald-500 shrink-0" />}
                  </button>
                );
              })}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export function Sidebar() {
  const { user, logout } = useAuth();
  const { open, close } = useSidebar();

  const initial = user?.name ? user.name.charAt(0) : '?';
  const roleLabel = user?.roleName || '未登录';

  return (
    <>
      {/* Desktop sidebar - always visible on lg+ */}
      <aside className="hidden lg:flex fixed left-0 top-0 z-40 h-screen w-60 border-r border-slate-200 bg-white flex-col">
        <SidebarContent initial={initial} name={user?.name || '未登录'} roleLabel={roleLabel} logout={logout} />
      </aside>

      {/* Mobile sidebar - slide in from left */}
      <aside
        className={`lg:hidden fixed left-0 top-0 z-40 h-screen w-60 border-r border-slate-200 bg-white flex-col transition-transform duration-300 ease-in-out ${
          open ? 'translate-x-0 flex' : '-translate-x-full'
        }`}
      >
        {/* Close button */}
        <button
          onClick={close}
          className="absolute top-4 right-3 p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 z-10"
        >
          <X className="w-4 h-4" />
        </button>
        <SidebarContent initial={initial} name={user?.name || '未登录'} roleLabel={roleLabel} logout={logout} onNavClick={close} />
      </aside>
    </>
  );
}

function SidebarContent({ initial, name, roleLabel, logout, onNavClick }: {
  initial: string;
  name: string;
  roleLabel: string;
  logout: () => void;
  onNavClick?: () => void;
}) {
  const pathname = usePathname();
  const { user } = useAuth();
  const permissions = user?.permissions || [];

  const visibleItems = menuItems.filter(item => hasPermission(permissions, item.permission));

  return (
    <>
      {/* Logo area */}
      <div className="h-16 bg-white flex items-center px-5 border-b border-slate-100">
        <div className="flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-emerald-600 flex items-center justify-center shadow-sm shadow-emerald-500/20">
            <span className="text-white font-bold text-sm">智</span>
          </div>
          <span className="text-slate-800 font-bold text-lg tracking-wide">智宿管家</span>
        </div>
      </div>

      {/* Store selector */}
      <StoreSelector />

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 py-3 space-y-1">
        {/* AI工作台 —— 置顶高亮入口 */}
        <Link
          href="/ai-workspace"
          onClick={onNavClick}
          className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-semibold transition-all ${
            pathname.startsWith('/ai-workspace')
              ? 'bg-gradient-to-r from-violet-500 to-purple-600 text-white shadow-lg shadow-purple-500/30'
              : 'bg-gradient-to-r from-violet-50 to-purple-50 text-purple-700 hover:shadow-md hover:shadow-purple-200 border border-purple-200 hover:border-purple-300'
          }`}
        >
          <Sparkles className={`w-5 h-5 ${pathname.startsWith('/ai-workspace') ? 'text-white' : 'text-purple-500'}`} />
          <span>AI工作台</span>
          {!pathname.startsWith('/ai-workspace') && (
            <span className="ml-auto text-[10px] px-1.5 py-0.5 bg-purple-100 text-purple-600 rounded-full">NEW</span>
          )}
        </Link>
        <div className="border-t border-slate-100 my-1" />
        {visibleItems.map((item) => {
          const isActive = pathname === item.href || pathname.startsWith(item.href + '/');
          return (
            <Link
              key={item.href}
              href={item.href}
              onClick={onNavClick}
              className={`flex items-center gap-3 px-4 py-3 rounded-lg text-sm font-medium transition-all ${
                isActive
                  ? 'bg-gradient-to-r from-emerald-500 to-emerald-600 text-white shadow-md shadow-emerald-500/25 border-l-4 border-emerald-700'
                  : 'text-slate-600 hover:bg-slate-100 hover:text-slate-700'
              }`}
            >
              <item.icon className={`w-5 h-5 ${isActive ? 'text-white' : 'text-slate-400'}`} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>

      {/* Bottom section - current user */}
      <div className="border-t border-slate-100 px-4 py-3">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-full bg-emerald-100 flex items-center justify-center shrink-0">
            <span className="text-emerald-700 text-sm font-medium">{initial}</span>
          </div>
          <div className="flex-1 min-w-0">
            <p className="text-sm font-medium text-slate-700 truncate">{name}</p>
            <p className="text-xs text-slate-400">{roleLabel}</p>
          </div>
          <button
            onClick={logout}
            className="p-1.5 rounded-lg text-slate-400 hover:text-red-500 hover:bg-red-50 transition-colors"
            title="退出登录"
          >
            <LogOut className="w-4 h-4" />
          </button>
        </div>
      </div>
    </>
  );
}
