'use client';

import { useState, useEffect, useRef } from 'react';
import { Bell, Search, X, ArrowRight, Package, BedDouble, FileText, Users, Settings, LayoutDashboard, Store, DollarSign, Radio, BarChart3, UserCircle, Shield, Clock, AlertCircle, CheckCircle2, Info, LogIn, LogOut, SprayCan, ChevronDown, Menu } from 'lucide-react';
import { apiGet } from '@/lib/api-client';
import { useStore } from '@/lib/context/store-context';
import { useQuickAction } from '@/lib/context/quick-action-context';
import { useAuth } from '@/lib/auth/auth-context';
import { useSidebar } from '@/lib/context/sidebar-context';
import { useRouter } from 'next/navigation';

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface Notification {
  id: string;
  type: 'order' | 'checkin' | 'checkout' | 'reconciliation' | 'alert' | 'channel';
  title: string;
  desc: string;
  time: string;
  read: boolean;
}

interface SearchItem {
  icon: React.ReactNode;
  label: string;
  desc: string;
  path: string;
  category: string;
}


// ========== 全局搜索弹窗 ==========
function SearchDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [query, setQuery] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);
  const router = useRouter();

  const searchItems: SearchItem[] = [
    // 菜单/页面
    { icon: <LayoutDashboard className="w-4 h-4" />, label: '工作台', desc: '查看今日经营概况', path: '/dashboard', category: '页面' },
    { icon: <Store className="w-4 h-4" />, label: '门店管理', desc: '管理门店、房型、品牌', path: '/stores', category: '页面' },
    { icon: <BedDouble className="w-4 h-4" />, label: '房间管理', desc: '日房态、月房态、入住退房', path: '/rooms', category: '页面' },
    { icon: <DollarSign className="w-4 h-4" />, label: '价格管理', desc: '价格日历、基础房价、特价', path: '/pricing', category: '页面' },
    { icon: <Radio className="w-4 h-4" />, label: '渠道管理', desc: '渠道直连、评价管理', path: '/channels', category: '页面' },
    { icon: <Package className="w-4 h-4" />, label: '收支明细', desc: '收支总览、流水、对账', path: '/finance', category: '页面' },
    { icon: <BarChart3 className="w-4 h-4" />, label: 'AI工作台', desc: '智能分析、收益优化', path: '/ai-workspace', category: '页面' },
    { icon: <UserCircle className="w-4 h-4" />, label: '客户管理', desc: '客户列表、标签', path: '/customers', category: '页面' },
    { icon: <Users className="w-4 h-4" />, label: '团队管理', desc: '员工、角色、日志', path: '/staff', category: '页面' },
    { icon: <Shield className="w-4 h-4" />, label: '系统设置', desc: '基础信息、业务参数', path: '/settings', category: '页面' },
    // 快捷操作
    { icon: <BedDouble className="w-4 h-4" />, label: '办理入住', desc: '快速为客人办理入住', path: '/rooms', category: '操作' },
    { icon: <FileText className="w-4 h-4" />, label: '新建订单', desc: '手动创建新订单', path: '/rooms', category: '操作' },
    { icon: <DollarSign className="w-4 h-4" />, label: '调整房价', desc: '修改房间价格', path: '/pricing', category: '操作' },
    { icon: <Settings className="w-4 h-4" />, label: '添加房间', desc: '新增房间到门店', path: '/stores', category: '操作' },
  ];

  const filtered = query.trim()
    ? searchItems.filter(item =>
        item.label.toLowerCase().includes(query.toLowerCase()) ||
        item.desc.toLowerCase().includes(query.toLowerCase()) ||
        item.category.toLowerCase().includes(query.toLowerCase())
      )
    : searchItems.slice(0, 8);

  const grouped = filtered.reduce<Record<string, SearchItem[]>>((acc, item) => {
    if (!acc[item.category]) acc[item.category] = [];
    acc[item.category].push(item);
    return acc;
  }, {});

  useEffect(() => {
    if (open) {
      setQuery('');
      setTimeout(() => inputRef.current?.focus(), 100);
    }
  }, [open]);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        if (open) onClose();
      }
      if (e.key === 'Escape' && open) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onClose]);

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" onClick={onClose} />
      <div className="fixed top-[15%] left-1/2 -translate-x-1/2 z-50 w-[560px] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* 搜索输入 */}
        <div className="flex items-center gap-3 px-5 py-4 border-b border-slate-100">
          <Search className="w-5 h-5 text-slate-400 shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="搜索功能、页面、操作..."
            className="flex-1 text-base outline-none text-slate-800 placeholder:text-slate-400"
          />
          <kbd className="hidden sm:inline-flex items-center px-2 py-0.5 text-xs text-slate-400 bg-slate-100 rounded border border-slate-200">ESC</kbd>
        </div>

        {/* 搜索结果 */}
        <div className="max-h-[360px] overflow-y-auto p-2">
          {Object.keys(grouped).length === 0 && (
            <div className="py-8 text-center text-sm text-slate-400">
              未找到 &quot;{query}&quot; 相关结果
            </div>
          )}
          {Object.entries(grouped).map(([category, items]) => (
            <div key={category}>
              <div className="px-3 py-1.5 text-xs font-medium text-slate-400 uppercase tracking-wider">{category}</div>
              {items.map((item) => (
                <button
                  key={item.label + item.path}
                  onClick={() => { router.push(item.path); onClose(); }}
                  className="w-full flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-emerald-50 transition-colors text-left group"
                >
                  <div className="w-8 h-8 bg-slate-100 group-hover:bg-emerald-100 rounded-lg flex items-center justify-center text-slate-500 group-hover:text-emerald-600 transition-colors">
                    {item.icon}
                  </div>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-700 group-hover:text-emerald-700">{item.label}</div>
                    <div className="text-xs text-slate-400 truncate">{item.desc}</div>
                  </div>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-300 group-hover:text-emerald-500 transition-colors" />
                </button>
              ))}
            </div>
          ))}
        </div>

        {/* 底部提示 */}
        <div className="px-5 py-2.5 border-t border-slate-100 flex items-center gap-4 text-xs text-slate-400">
          <span className="flex items-center gap-1"><kbd className="px-1 py-0.5 bg-slate-100 rounded text-[10px]">↑↓</kbd> 导航</span>
          <span className="flex items-center gap-1"><kbd className="px-1 py-0.5 bg-slate-100 rounded text-[10px]">↵</kbd> 打开</span>
          <span className="flex items-center gap-1"><kbd className="px-1 py-0.5 bg-slate-100 rounded text-[10px]">⌘K</kbd> 搜索</span>
        </div>
      </div>
    </>
  );
}

// ========== 消息通知弹窗 ==========
function NotificationPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const panelRef = useRef<HTMLDivElement>(null);
  const [notifications, setNotifications] = useState<Notification[]>([]);
  const [notifLoading, setNotifLoading] = useState(false);
  const [notifError, setNotifError] = useState<string | null>(null);

  // 打开面板时从 API 加载通知
  useEffect(() => {
    if (open) {
      setNotifLoading(true);
      setNotifError(null);
      apiGet<{ success: boolean; data: Notification[] }>('/api/notifications?limit=20')
        .then((res) => {
          if (res.success && Array.isArray(res.data)) {
            setNotifications(res.data);
          }
        })
        .catch((err) => {
          setNotifError('通知加载失败');
          console.error('加载通知失败:', err);
        })
        .finally(() => setNotifLoading(false));
    }
  }, [open]);

  const unreadCount = notifications.filter(n => !n.read).length;

  const typeConfig: Record<string, { icon: React.ReactNode; color: string }> = {
    order: { icon: <FileText className="w-4 h-4" />, color: 'text-blue-500 bg-blue-50' },
    checkin: { icon: <LogIn className="w-4 h-4" />, color: 'text-emerald-500 bg-emerald-50' },
    checkout: { icon: <LogOut className="w-4 h-4" />, color: 'text-orange-500 bg-orange-50' },
    reconciliation: { icon: <DollarSign className="w-4 h-4" />, color: 'text-purple-500 bg-purple-50' },
    alert: { icon: <AlertCircle className="w-4 h-4" />, color: 'text-amber-500 bg-amber-50' },
    channel: { icon: <Radio className="w-4 h-4" />, color: 'text-indigo-500 bg-indigo-50' },
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} />
      <div ref={panelRef} className="fixed right-[76px] top-[60px] z-50 w-[380px] bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
        {/* 头部 */}
        <div className="flex items-center justify-between px-5 py-3.5 border-b border-slate-100">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-slate-800">消息通知</span>
            {unreadCount > 0 && (
              <span className="text-xs px-1.5 py-0.5 bg-red-500 text-white rounded-full">{unreadCount}</span>
            )}
          </div>
          <button className="text-xs text-emerald-600 hover:text-emerald-700 font-medium transition-colors">
            全部已读
          </button>
        </div>

        {/* 通知列表 */}
        <div className="max-h-[400px] overflow-y-auto">
          {notifLoading && (
            <div className="flex items-center justify-center py-8">
              <SprayCan className="w-5 h-5 text-slate-300 animate-spin" />
              <span className="ml-2 text-sm text-slate-400">加载中...</span>
            </div>
          )}
          {notifError && (
            <div className="flex flex-col items-center justify-center py-8 text-slate-400">
              <AlertCircle className="w-8 h-8 mb-2 opacity-50" />
              <p className="text-sm">{notifError}</p>
              <button onClick={() => { setNotifError(null); setNotifLoading(true); apiGet('/api/notifications?limit=20').then((res: any) => { if (res.success) setNotifications(res.data); }).catch(() => setNotifError('通知加载失败')).finally(() => setNotifLoading(false)); }}
                className="mt-2 text-xs text-emerald-600 hover:text-emerald-700">点击重试</button>
            </div>
          )}
          {!notifLoading && !notifError && notifications.length === 0 && (
            <div className="flex flex-col items-center justify-center py-12 text-slate-400">
              <Bell className="w-10 h-10 mb-2 opacity-50" />
              <p className="text-sm">暂无新通知</p>
            </div>
          )}
          {!notifLoading && !notifError && notifications.map((n) => {
            const config = typeConfig[n.type];
            return (
              <div key={n.id} className={`flex gap-3 px-5 py-3.5 hover:bg-slate-50 transition-colors cursor-pointer border-b border-slate-50 ${!n.read ? 'bg-emerald-50/30' : ''}`}>
                <div className={`w-8 h-8 rounded-lg flex items-center justify-center shrink-0 ${config.color}`}>
                  {config.icon}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800 truncate">{n.title}</span>
                    {!n.read && <span className="w-1.5 h-1.5 bg-emerald-500 rounded-full shrink-0" />}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 truncate">{n.desc}</div>
                  <div className="flex items-center gap-1 mt-1 text-xs text-slate-400">
                    <Clock className="w-3 h-3" />
                    {n.time}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        {/* 底部 */}
        <div className="px-5 py-3 border-t border-slate-100 text-center">
          <button className="text-xs text-emerald-600 hover:text-emerald-700 font-medium transition-colors">
            查看全部通知
          </button>
        </div>
      </div>
    </>
  );
}

// ========== 主Header组件 ==========
export function Header() {
  const { currentStore } = useStore();
  const quickAction = useQuickAction();
  const { user, logout } = useAuth();
  const { toggle: toggleSidebar } = useSidebar();
  const router = useRouter();
  const [searchOpen, setSearchOpen] = useState(false);
  const [notifOpen, setNotifOpen] = useState(false);
  const [aiOpen, setAiOpen] = useState(false);
  const [showSearchHint, setShowSearchHint] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);

  // 全局快捷键 Cmd+K 打开搜索
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'k') {
        e.preventDefault();
        setSearchOpen(prev => !prev);
        setAiOpen(false);
        setNotifOpen(false);
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

  // 3秒后显示搜索提示
  useEffect(() => {
    const timer = setTimeout(() => setShowSearchHint(true), 3000);
    return () => clearTimeout(timer);
  }, []);

  const openSearch = () => { setSearchOpen(true); setNotifOpen(false); };
  const openNotif = () => { setNotifOpen(true); setAiOpen(false); setSearchOpen(false); };

  return (
    <>
      <header className="fixed top-0 left-0 lg:left-60 right-0 z-30 h-16 bg-white border-b border-slate-200 flex items-center justify-between px-4 lg:px-6">
        {/* Left: Menu toggle (mobile) + Page title */}
        <div className="flex items-center gap-3">
          <button
            onClick={toggleSidebar}
            className="lg:hidden p-2 -ml-2 rounded-lg hover:bg-slate-100 text-slate-600"
            aria-label="菜单"
          >
            <Menu className="w-5 h-5" />
          </button>
          <div className="w-1 h-6 bg-emerald-500 rounded-full" />
          <h1 className="text-lg font-semibold text-slate-800" id="page-title">
            工作台
          </h1>
          {currentStore && (
            <span className="text-xs text-slate-400 bg-slate-50 px-2 py-0.5 rounded-full">
              {currentStore.fullName}
            </span>
          )}
        </div>

        {/* Right: Actions */}
        <div className="flex items-center gap-2">
          {/* 快捷操作：办理入住 */}
          <button
            onClick={() => quickAction.openCheckin()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl bg-emerald-50 text-emerald-700 hover:bg-emerald-100 hover:shadow-md transition-all border border-emerald-200"
          >
            <LogIn className="w-4 h-4" />
            <span className="hidden lg:inline">办理入住</span>
          </button>

          {/* 快捷操作：办理退房 */}
          <button
            onClick={() => quickAction.openCheckout()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl bg-blue-50 text-blue-700 hover:bg-blue-100 hover:shadow-md transition-all border border-blue-200"
          >
            <LogOut className="w-4 h-4" />
            <span className="hidden lg:inline">办理退房</span>
          </button>

          {/* 快捷操作：房务任务 */}
          <button
            onClick={() => quickAction.openHousekeeping()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm font-medium rounded-xl bg-amber-50 text-amber-700 hover:bg-amber-100 hover:shadow-md transition-all border border-amber-200"
          >
            <SprayCan className="w-4 h-4" />
            <span className="hidden lg:inline">房务任务</span>
          </button>

          <div className="w-px h-8 bg-slate-200 mx-1" />

          {/* Search */}
          <button
            onClick={openSearch}
            className="relative flex items-center gap-2 w-64 pl-3 pr-2 py-2 bg-slate-50 border border-slate-200 rounded-xl hover:border-emerald-300 hover:bg-white transition-all group"
          >
            <Search className="w-4 h-4 text-slate-400 group-hover:text-emerald-500 transition-colors" />
            <span className="text-sm text-slate-400 group-hover:text-slate-500 transition-colors">搜索功能、订单、房间...</span>
            <kbd className="ml-auto text-[10px] text-slate-400 bg-white px-1.5 py-0.5 rounded border border-slate-200">⌘K</kbd>
            {showSearchHint && !searchOpen && (
              <span className="absolute -top-1 -right-1 w-2 h-2 bg-emerald-500 rounded-full animate-pulse" />
            )}
          </button>

          {/* Notifications */}
          <button
            onClick={openNotif}
            className={`relative p-2 rounded-xl transition-colors ${notifOpen ? 'bg-emerald-50 text-emerald-600' : 'hover:bg-slate-100 text-slate-500'}`}
          >
            <Bell className="w-5 h-5" />
            <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
          </button>

          {/* User Menu */}
          <div className="relative">
            <button
              onClick={() => { setUserMenuOpen(!userMenuOpen); setAiOpen(false); setSearchOpen(false); setNotifOpen(false); }}
              className="flex items-center gap-2 pl-2 pr-3 py-1.5 rounded-xl hover:bg-slate-50 transition-colors"
            >
              <div className="w-8 h-8 rounded-lg bg-emerald-100 flex items-center justify-center text-emerald-700 text-sm font-semibold">
                {user?.name?.charAt(0) || '?'}
              </div>
              <div className="hidden md:block text-left">
                <div className="text-sm font-medium text-slate-700 leading-tight">{user?.name || '未登录'}</div>
                <div className="text-xs text-slate-400 leading-tight">{user?.roleName || ''}</div>
              </div>
              <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
            </button>

            {userMenuOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setUserMenuOpen(false)} />
                <div className="absolute right-0 top-full mt-2 w-56 bg-white rounded-xl shadow-xl border border-slate-200 overflow-hidden z-50">
                  <div className="px-4 py-3 border-b border-slate-100 bg-slate-50">
                    <div className="text-sm font-medium text-slate-800">{user?.name}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{user?.phone} · {user?.roleName}</div>
                    <div className="text-xs text-slate-400 mt-0.5">{user?.department} · {user?.position}</div>
                  </div>
                  <div className="py-1">
                    <button
                      onClick={() => { setUserMenuOpen(false); router.push('/staff'); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
                    >
                      <Users className="w-4 h-4" />
                      团队管理
                    </button>
                    <button
                      onClick={() => { setUserMenuOpen(false); router.push('/settings'); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-slate-700 hover:bg-emerald-50 hover:text-emerald-700 transition-colors"
                    >
                      <Settings className="w-4 h-4" />
                      系统设置
                    </button>
                  </div>
                  <div className="border-t border-slate-100 py-1">
                    <button
                      onClick={() => { setUserMenuOpen(false); logout(); }}
                      className="w-full flex items-center gap-3 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 transition-colors"
                    >
                      <LogOut className="w-4 h-4" />
                      退出登录
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </div>
      </header>

      {/* 弹窗组件 */}
      <SearchDialog open={searchOpen} onClose={() => setSearchOpen(false)} />
      <NotificationPanel open={notifOpen} onClose={() => setNotifOpen(false)} />
    </>
  );
}
