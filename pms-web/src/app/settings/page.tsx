'use client';

import { useState, useEffect, useCallback } from 'react';
import { CreditCard, Lock, Eye, EyeOff, Key, CheckCircle2, Monitor, LogOut, Crown, Settings, CheckCircle, XCircle, Clock, Plus, Edit, Loader2, QrCode, Download, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { TabBar } from '@/components/tab-bar';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';
import { Badge } from '@/components/ui/badge';
import { useStore } from '@/lib/context/store-context';
import { toast } from 'sonner';
import { apiGet, apiPost, apiPut } from '@/lib/api-client';
import { ApplyForm } from '@/app/private-stores/apply-form';
import type { ApplicationData, CouponData, PromoterData } from '@/app/private-stores/types';

const tabs = [
  { key: 'subscription', label: '订阅管理' },
  { key: 'security', label: '安全设置' },
  { key: 'application', label: '进件与收款' },
  { key: 'coupons', label: '优惠券管理' },
  { key: 'promoters', label: '分销管理' },
  { key: 'qrcode', label: '门店二维码' },
];

const STATUS_MAP: Record<string, { label: string; className: string }> = {
  draft: { label: '草稿', className: 'bg-slate-100 text-slate-600' },
  reviewing: { label: '平台审核中', className: 'bg-amber-100 text-amber-700' },
  rejected: { label: '平台驳回', className: 'bg-red-100 text-red-600' },
  wx_submitted: { label: '已提交微信', className: 'bg-blue-100 text-blue-700' },
  wx_verifying: { label: '待账户验证', className: 'bg-blue-100 text-blue-700' },
  wx_signing: { label: '待签约', className: 'bg-blue-100 text-blue-700' },
  finished: { label: '已完成', className: 'bg-green-100 text-green-700' },
  wx_rejected: { label: '微信驳回', className: 'bg-red-100 text-red-600' },
};

/* ========== OTA Key 管理组件 ========== */
function OtaKeyManager() {
  const { currentStore } = useStore();
  const [storeKey, setStoreKey] = useState('');
  const [kl, setKl] = useState(true);
  const [gen, setGen] = useState(false);

  const fetchKey = () => {
    if (!currentStore?.id) { setKl(false); return; }
    apiGet(`/api/ota/client/key?storeId=${currentStore.id}`).then(d => {
      setStoreKey(d.storeKey ? d.storeKey.slice(0,10)+'*****************'+d.storeKey.slice(-6) : '');
      setKl(false);
    }).catch(() => { setKl(false); });
  };
  useEffect(() => { fetchKey(); }, [currentStore?.id]);

  const doGen = async () => {
    setGen(true);
    try {
      const d = await apiPost('/api/ota/client/keys', { storeId: currentStore?.id, platform: 'all' });
      navigator.clipboard?.writeText(d.storeKey);
      toast.success('OTA Key 已生成并复制到剪贴板');
      fetchKey();
    } catch { toast.error('生成失败'); }
    setGen(false);
  };

  const doCopy = async () => {
    try {
      const d = await apiGet(`/api/ota/client/key?storeId=${currentStore?.id}`);
      navigator.clipboard?.writeText(d.storeKey);
      toast.success('已复制');
    } catch { toast.error('复制失败'); }
  };

  if (kl) return <p className="text-sm text-slate-400 py-2">加载中...</p>;
  return (
    <div className="mt-2">
      {storeKey ? (
        <div className="flex items-center justify-between py-2 px-3 bg-slate-50 rounded-lg">
          <div className="flex items-center gap-3">
            <code className="text-xs font-mono text-slate-700">{storeKey}</code>
          </div>
          <div className="flex gap-2">
            <OutlineBtn onClick={doCopy}>复制</OutlineBtn>
            <PrimaryBtn onClick={doGen} loading={gen}>重新生成</PrimaryBtn>
          </div>
        </div>
      ) : (
        <div className="py-3">
          <p className="text-sm text-slate-500 mb-2">尚未配置 API Key</p>
          <PrimaryBtn onClick={doGen} loading={gen}>生成 Key</PrimaryBtn>
        </div>
      )}
      <p className="text-xs text-slate-400 mt-2">将此 Key 配置到 OTA RPA 客户端，用于同步携程/美团/抖音/小红书等渠道订单。</p>
    </div>
  );
}

/* ========== 门店二维码组件 ========== */
function StoreQRCode() {
  const { currentStore } = useStore();
  const storeId = currentStore?.id || '';
  const [imgError, setImgError] = useState(false);
  const [imgKey, setImgKey] = useState(0);

  // 二维码图片的 BaseURL — settings 页面同源访问即可，由 Nginx 代理到 pms-server
  const qrcodeUrl = storeId ? `/api/mini/stores/${storeId}/qrcode` : '';

  function handleDownload() {
    if (!qrcodeUrl) return;
    const a = document.createElement('a');
    a.href = qrcodeUrl;
    a.download = `qrcode-${storeId}.png`;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  }

  function handleRefresh() {
    setImgError(false);
    setImgKey(k => k + 1);
  }

  if (!storeId) {
    return <p className="text-sm text-slate-400 py-4">请先选择门店</p>;
  }

  return (
    <div className="mt-4 space-y-5">
      <p className="text-sm text-slate-500">客户扫码即可直接进入您的门店小程序首页，享受直订优惠。</p>

      {/* 二维码展示 */}
      <div className="flex flex-col items-center gap-4 p-6 bg-slate-50 rounded-2xl border border-slate-100">
        {imgError ? (
          <div className="w-[280px] h-[280px] flex flex-col items-center justify-center bg-white rounded-xl border border-slate-200">
            <QrCode className="w-12 h-12 text-slate-300 mb-3" />
            <p className="text-sm text-slate-400 mb-2">加载失败</p>
            <OutlineBtn onClick={handleRefresh} className="text-xs">
              <RefreshCw className="w-3 h-3" />重新加载
            </OutlineBtn>
          </div>
        ) : qrcodeUrl ? (
          <img
            key={imgKey}
            src={qrcodeUrl}
            alt="门店小程序码"
            className="w-[280px] h-[280px] rounded-xl border border-slate-200 bg-white"
            onError={() => setImgError(true)}
          />
        ) : null}

        {/* 门店信息 */}
        <div className="text-center">
          <p className="text-sm font-semibold text-slate-800">{currentStore?.name || '—'}</p>
          <p className="text-xs text-slate-400 mt-0.5">微信扫码进入门店首页</p>
        </div>
      </div>

      {/* 操作按钮 */}
      <div className="flex gap-3 justify-center">
        <PrimaryBtn onClick={handleDownload} disabled={!qrcodeUrl || imgError}>
          <Download className="w-4 h-4" />下载二维码
        </PrimaryBtn>
        <OutlineBtn onClick={handleRefresh}>
          <RefreshCw className="w-4 h-4" />刷新
        </OutlineBtn>
      </div>

      <div className="text-xs text-slate-400 space-y-1 bg-amber-50 rounded-xl p-3 border border-amber-100">
        <p className="font-medium text-amber-700">💡 使用说明</p>
        <p>1. 点击「下载二维码」保存图片到本地</p>
        <p>2. 将二维码打印放置在前台、客房或宣传物料上</p>
        <p>3. 客户用微信扫码即可直接进入您的门店首页预订</p>
        <p>4. 二维码永久有效，门店信息变更后无需重新生成</p>
      </div>
    </div>
  );
}

/* ========== 通用小组件 ========== */
function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-2xl border border-slate-100 p-5 ${className}`}>{children}</div>;
}
function SectionTitle({ children, icon }: { children: React.ReactNode; icon?: React.ReactNode }) {
  return <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">{icon}{children}</h3>;
}
function FormLabel({ children }: { children: React.ReactNode }) {
  return <label className="block text-sm text-slate-500 mb-1.5">{children}</label>;
}
function FormInput({ value, onChange, type = 'text', placeholder = '', disabled = false }: { value: string | number; onChange: (v: string) => void; type?: string; placeholder?: string; disabled?: boolean }) {
  return <input type={type} value={value} onChange={e => onChange(e.target.value)} placeholder={placeholder} disabled={disabled} className={`w-full px-3 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400 transition ${disabled ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''}`} />;
}
function PrimaryBtn({ children, onClick, disabled = false, loading = false, className = '' }: { children: React.ReactNode; onClick: () => void; disabled?: boolean; loading?: boolean; className?: string }) {
  return <button onClick={onClick} disabled={disabled || loading} className={`px-4 py-2 text-sm text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors flex items-center gap-1.5 ${className}`}>{loading ? '处理中...' : children}</button>;
}
function OutlineBtn({ children, onClick, className = '', danger = false }: { children: React.ReactNode; onClick: () => void; className?: string; danger?: boolean }) {
  return <button onClick={onClick} className={`px-4 py-2 text-sm rounded-xl border transition-colors flex items-center gap-1.5 ${danger ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-slate-200 text-slate-600 hover:bg-slate-50'} ${className}`}>{children}</button>;
}

export default function SettingsPage() {
  const [activeTab, setActiveTab] = useState('subscription');
  const [saveLoading, setSaveLoading] = useState(false);
  const [successMsg, setSuccessMsg] = useState('');

  /* ---- 订阅 ---- */
  const [platformSubs, setPlatformSubs] = useState<Array<{packageName:string; duration:string; endAt:string; amount:number}>>([]);
  const [subsLoading, setSubsLoading] = useState(true);
  /* ---- 安全 ---- */
  const [showPwdModal, setShowPwdModal] = useState(false);
  const [pwdForm, setPwdForm] = useState({ old: '', new: '', confirm: '' });
  const [showPwd, setShowPwd] = useState({ old: false, new: false, confirm: false });
  const [sessions, setSessions] = useState<Array<{ id: string; device: string; ip: string; time: string; current: boolean }>>([]);
  const [showLogoutModal, setShowLogoutModal] = useState(false);
  const [logoutSession, setLogoutSession] = useState('');
  const [saving, setSaving] = useState(false);

  /* ---- 进件与收款 ---- */
  const [application, setApplication] = useState<ApplicationData | null>(null);

  /* ---- 优惠券 ---- */
  const [couponList, setCouponList] = useState<CouponData[]>([]);
  const [showCouponForm, setShowCouponForm] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<CouponData | null>(null);
  const [couponForm, setCouponForm] = useState({ name: '', type: 'full_reduce', value: 0, minAmount: 0, perUser: 1, validDays: 30, total: 100 } as any);

  /* ---- 分销 ---- */
  const [promoterList, setPromoterList] = useState<PromoterData[]>([]);
  const [listLoading, setListLoading] = useState('');

  const showSuccess = useCallback((msg: string) => { setSuccessMsg(msg); setTimeout(() => setSuccessMsg(''), 2500); }, []);

  /* ---- 进件与收款 ---- */
  async function submitApp(data: ApplicationData) {
    setSaving(true);
    try {
      await apiPost('/api/mini-admin/application', data);
      const r = await apiGet('/api/mini-admin/application');
      setApplication(r?.data || r);
      toast.success('已提交');
    } catch (e: unknown) {
      toast.error((e as { error?: string })?.error || '提交失败');
    } finally {
      setSaving(false);
    }
  }

  async function loadList(type: 'coupons' | 'promoters') {
    setListLoading(type);
    try {
      const r = await apiGet(`/api/mini-admin/${type}`);
      if (type === 'coupons') setCouponList(r?.data || []);
      else if (type === 'promoters') setPromoterList(r?.data || []);
    } catch {} finally { setListLoading(''); }
  }

  async function saveCoupon() {
    const b = { ...couponForm, value: Number(couponForm.value), minAmount: Number(couponForm.minAmount), perUser: Number(couponForm.perUser), validDays: Number(couponForm.validDays), total: Number(couponForm.total) };
    if (editingCoupon) await apiPut(`/api/mini-admin/coupons/${editingCoupon.id}`, b);
    else await apiPost('/api/mini-admin/coupons', b);
    setShowCouponForm(false);
    setEditingCoupon(null);
    loadList('coupons');
    toast.success('OK');
  }

  async function toggleCoupon(c: CouponData) {
    await apiPost(`/api/mini-admin/coupons/${c.id}/toggle`);
    loadList('coupons');
  }

  async function reviewPromoter(id: string, action: string) {
    try {
      await apiPost(`/api/mini-admin/promoters/${id}/review`, { action });
      loadList('promoters');
      toast.success(action === 'approve' ? '已通过' : '已处理');
    } catch (e: unknown) {
      toast.error((e as { error?: string })?.error || '操作失败');
    }
  }

  useEffect(() => {
    // 加载登录设备会话
    apiGet('/api/auth/sessions').then(d => {
      if (d.data) setSessions(d.data);
    }).catch(() => {});
    // 加载平台订阅状态
    apiGet('/api/settings?type=subscription').then(d => {
      if (d?.subscriptions) setPlatformSubs(d.subscriptions);
      setSubsLoading(false);
    }).catch(() => { setSubsLoading(false); });
  }, []);

  useEffect(() => {
    if (activeTab === 'application') {
      apiGet('/api/mini-admin/application').then(r => setApplication(r?.data || r)).catch(() => {});
    }
    if (activeTab === 'coupons') loadList('coupons');
    if (activeTab === 'promoters') loadList('promoters');
  }, [activeTab]);

  const handleChangePwd = async () => {
    if (!pwdForm.old || !pwdForm.new || !pwdForm.confirm) { showSuccess('请填写完整信息'); return; }
    if (pwdForm.new !== pwdForm.confirm) { showSuccess('两次密码不一致'); return; }
    if (pwdForm.new.length < 6) { showSuccess('密码至少6位'); return; }
    setSaving(true);
    try {
      const data = await apiPost('/api/auth/change-password', { oldPassword: pwdForm.old, newPassword: pwdForm.new });
      if (data.success) {
        setShowPwdModal(false); setPwdForm({ old: '', new: '', confirm: '' }); showSuccess('密码修改成功');
      } else {
        showSuccess(data.error || '修改失败');
      }
    } catch { showSuccess('修改失败，请重试'); }
    finally { setSaving(false); }
  };

  const handleLogoutDevice = (id: string) => { setLogoutSession(id); setShowLogoutModal(true); };
  const handleConfirmLogout = async () => {
    try {
      await apiPost('/api/auth/sessions', { action: 'revoke', sessionId: logoutSession });
      setSessions(s => s.filter(d => d.id !== logoutSession));
      setShowLogoutModal(false);
      showSuccess('设备已退出登录');
    } catch {
      showSuccess('操作失败，请重试');
    }
  };
  const pwdStrength = pwdForm.new.length === 0 ? 0 : pwdForm.new.length < 6 ? 1 : pwdForm.new.length < 10 ? 2 : 3;
  const pwdStrengthLabel = ['', '弱', '中', '强'][pwdStrength];
  const pwdStrengthColor = ['', 'bg-red-400', 'bg-amber-400', 'bg-emerald-500'][pwdStrength];

  return (
    <div className="space-y-5">
      <PageHeader title="系统设置" subtitle="管理订阅与安全设置" icon={<Settings className="w-5 h-5" />} />

      {/* 成功提示 */}
      {successMsg && <div className="fixed top-4 right-4 z-[100] bg-emerald-600 text-white px-5 py-3 rounded-xl shadow-lg flex items-center gap-2 text-sm animate-in fade-in slide-in-from-top-2"><CheckCircle2 className="w-4 h-4" />{successMsg}</div>}

      <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />

      {/* ========== 订阅管理 ========== */}
      {activeTab === 'subscription' && (
        <div className="space-y-4">
          <Card>
            <SectionTitle icon={<Crown className="w-5 h-5 text-emerald-600" />}>当前订阅</SectionTitle>
            {subsLoading ? (
              <p className="text-sm text-slate-400 mt-4">加载中...</p>
            ) : platformSubs.length === 0 ? (
              <p className="text-sm text-slate-400 mt-4">暂无订阅数据</p>
            ) : (
              <div className="space-y-3 mt-4">
                {platformSubs.map((s, i) => (
                  <div key={i} className="flex items-center justify-between p-4 rounded-xl border border-slate-100 bg-slate-50/50">
                    <div className="flex items-center gap-3">
                      <div className={`w-10 h-10 rounded-xl flex items-center justify-center ${s.duration === 'permanent' ? 'bg-emerald-50' : s.duration === 'trial' ? 'bg-amber-50' : 'bg-blue-50'}`}>
                        <Crown className={`w-5 h-5 ${s.duration === 'permanent' ? 'text-emerald-600' : s.duration === 'trial' ? 'text-amber-600' : 'text-blue-600'}`} />
                      </div>
                      <div>
                        <p className="text-sm font-semibold text-slate-800">{s.packageName}</p>
                        <p className="text-xs text-slate-400">
                          {s.duration === 'permanent' ? '永久有效' : s.duration === 'trial' ? `试用至 ${s.endAt?.slice(0,10) || '-'}` : `到期 ${s.endAt?.slice(0,10) || '-'}`}
                          {s.amount > 0 && ` · ¥${s.amount}`}
                        </p>
                      </div>
                    </div>
                    <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                      s.duration === 'permanent' ? 'bg-emerald-100 text-emerald-700' :
                      s.duration === 'trial' ? 'bg-amber-100 text-amber-700' :
                      'bg-blue-100 text-blue-700'
                    }`}>
                      {s.duration === 'permanent' ? '永久' : s.duration === 'trial' ? '试用中' : '已订阅'}
                    </span>
                  </div>
                ))}
              </div>
            )}
          </Card>
          <Card>
            <SectionTitle icon={<CreditCard className="w-5 h-5 text-emerald-600" />}>套餐说明</SectionTitle>
            <div className="grid grid-cols-3 gap-4 mt-4">
              {[
                { name: '基础功能', price: '免费', features: ['房态管理','订单管理','客户管理','员工管理','财务管理','私域小程序'] },
                { name: 'OTA同步', price: '¥299/月', features: ['携程/美团/飞猪','渠道直连','订单同步','价格同步'] },
                { name: 'AI工作台', price: '¥399/月', features: ['AI智能定价','视频创作','内容创作','竞品分析','声音克隆'] },
              ].map(p => (
                <div key={p.name} className="p-4 rounded-xl border border-slate-100 text-center">
                  <h4 className="font-semibold text-slate-800">{p.name}</h4>
                  <p className="text-lg font-bold text-emerald-600 mt-1">{p.price}</p>
                  <div className="mt-3 space-y-1.5">
                    {p.features.map(f => (
                      <div key={f} className="flex items-center gap-1.5 text-xs text-slate-500"><CheckCircle2 className="w-3 h-3 text-emerald-400" />{f}</div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ========== 安全设置 ========== */}
      {activeTab === 'security' && (
        <div className="space-y-4">
          {/* 修改密码 */}
          <Card>
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-3">
                <div className="w-10 h-10 bg-amber-50 rounded-xl flex items-center justify-center"><Lock className="w-5 h-5 text-amber-600" /></div>
                <div><p className="text-sm font-semibold text-slate-800">登录密码</p><p className="text-xs text-slate-400">修改您的登录密码</p></div>
              </div>
              <OutlineBtn onClick={() => setShowPwdModal(true)}><Key className="w-4 h-4" />修改密码</OutlineBtn>
            </div>
          </Card>

          {/* OTA Key 管理 */}
          <Card>
            <SectionTitle icon={<Key className="w-5 h-5 text-emerald-600" />}>API Key</SectionTitle>
            <p className="text-xs text-slate-400 mb-3">RPA 客户端连接使用的 API Key</p>
            <OtaKeyManager />
          </Card>

          {/* 登录设备 */}
          <Card>
            <SectionTitle icon={<Monitor className="w-5 h-5 text-emerald-600" />}>登录设备</SectionTitle>
            <div className="space-y-2.5 mt-4">
              {sessions.length === 0 ? (
                <p className="text-sm text-slate-400 py-4">暂无设备信息</p>
              ) : sessions.map(s => (
                <div key={s.id} className="flex items-center justify-between py-2.5 px-3 rounded-xl hover:bg-slate-50 transition">
                  <div className="flex items-center gap-3">
                    <Monitor className="w-4 h-4 text-slate-400" />
                    <div>
                      <p className="text-sm font-medium text-slate-700 flex items-center gap-2">{s.device}{s.current && <span className="px-1.5 py-0.5 bg-emerald-100 text-emerald-700 text-xs rounded-md">当前</span>}</p>
                      <p className="text-xs text-slate-400">{s.ip} · {s.time}</p>
                    </div>
                  </div>
                  {!s.current && <button onClick={() => handleLogoutDevice(s.id)} className="text-xs text-red-500 hover:text-red-700 transition flex items-center gap-1"><LogOut className="w-3 h-3" />退出</button>}
                </div>
              ))}
            </div>
          </Card>
        </div>
      )}

      {/* ========== 进件与收款 ========== */}
      {activeTab === 'application' && (
        <div className="space-y-4">
          {application?.status && application.status !== 'draft' ? (
            <Card>
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-base font-semibold text-slate-800">进件状态</h3>
              </div>
              <div className={`p-5 rounded-xl border ${
                application.status === 'finished' ? 'bg-green-50 border-green-200' :
                application.status === 'rejected' || application.status === 'wx_rejected' ? 'bg-red-50 border-red-200' :
                'bg-amber-50 border-amber-200'
              }`}>
                <div className="flex items-center gap-3 mb-3">
                  {application.status === 'finished' ? (
                    <CheckCircle className="w-6 h-6 text-green-600" />
                  ) : application.status === 'rejected' || application.status === 'wx_rejected' ? (
                    <XCircle className="w-6 h-6 text-red-600" />
                  ) : (
                    <Clock className="w-6 h-6 text-amber-500" />
                  )}
                  <Badge className={`px-3 py-1 rounded-lg ${STATUS_MAP[application.status]?.className}`}>
                    {STATUS_MAP[application.status]?.label || application.status}
                  </Badge>
                </div>
                {application.subMchid && <p className="text-sm text-slate-600 mb-2">特约商户号：{application.subMchid}</p>}
                {application.rejectReason && <p className="text-sm text-red-500 mb-3">驳回原因：{application.rejectReason}</p>}
                {(application.status === 'rejected' || application.status === 'wx_rejected') && (
                  <PrimaryBtn onClick={() => setApplication(null)} className="px-4 py-2 text-sm">重新申请</PrimaryBtn>
                )}
              </div>
            </Card>
          ) : (
            <ApplyForm onSubmit={submitApp} saving={saving} />
          )}
        </div>
      )}

      {/* ========== 优惠券管理 ========== */}
      {activeTab === 'coupons' && (
        <Card>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">🎫 优惠券管理</h3>
            <PrimaryBtn
              onClick={() => {
                setEditingCoupon(null);
                setCouponForm({ name: '', type: 'full_reduce', value: 0, minAmount: 0, perUser: 1, validDays: 30, total: 100 });
                setShowCouponForm(true);
              }}
              className="px-4 py-2 text-sm"
            >
              <Plus className="w-4 h-4" />新建券
            </PrimaryBtn>
          </div>
          {listLoading === 'coupons' ? (
            <p className="text-center py-12 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />加载中...
            </p>
          ) : couponList.length === 0 ? (
            <p className="text-center py-12 text-slate-400">暂无优惠券</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">名称</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">类型</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">面值</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">门槛</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">已领/发行</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">状态</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-500">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {couponList.map((c) => (
                    <tr key={c.id} className="hover:bg-slate-50/50">
                      <td className="px-4 py-3">
                        <div className="text-sm font-medium text-slate-800">{c.name}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-slate-600">
                          {c.type === 'full_reduce' ? '满减' : c.type === 'discount' ? '折扣' : '新客'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm font-semibold text-slate-800">
                          {c.type === 'discount' ? `${c.value}折` : `¥${c.value}`}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-slate-600">
                          {c.minAmount > 0 ? `满¥${c.minAmount}` : '无门槛'}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm text-slate-600">
                          {c.claimed ?? 0}/{c.total === -1 ? '不限' : c.total}
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                          c.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
                        }`}>
                          {c.status === 'approved' ? '上线' : '下线'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          <OutlineBtn
                            onClick={() => {
                              setEditingCoupon(c);
                              setCouponForm({
                                name: c.name || '',
                                type: c.type || 'full_reduce',
                                value: c.value || 0,
                                minAmount: c.minAmount || 0,
                                perUser: c.perUser || 1,
                                validDays: c.validDays || 30,
                                total: c.total || 100
                              });
                              setShowCouponForm(true);
                            }}
                            className="px-3 py-1.5 text-xs"
                          >
                            <Edit className="w-3 h-3" />编辑
                          </OutlineBtn>
                          <OutlineBtn
                            onClick={() => toggleCoupon(c)}
                            className="px-3 py-1.5 text-xs"
                          >
                            {c.status === 'approved' ? '下线' : '上线'}
                          </OutlineBtn>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ========== 分销管理 ========== */}
      {activeTab === 'promoters' && (
        <Card>
          <div className="flex items-center justify-between mb-5">
            <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">👥 分销管理</h3>
          </div>
          {listLoading === 'promoters' ? (
            <p className="text-center py-12 text-slate-400">
              <Loader2 className="w-5 h-5 animate-spin inline mr-2" />加载中...
            </p>
          ) : promoterList.length === 0 ? (
            <p className="text-center py-12 text-slate-400">暂无推广员</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead className="bg-slate-50">
                  <tr>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">推广码</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">状态</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">累计佣金</th>
                    <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">申请时间</th>
                    <th className="text-right px-4 py-3 text-xs font-medium text-slate-500">操作</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {promoterList.map((p) => (
                    <tr key={p.id} className="hover:bg-slate-50/50">
                      <td className="px-4 py-3">
                        <div className="text-sm font-mono text-slate-700">{p.promoCode}</div>
                      </td>
                      <td className="px-4 py-3">
                        <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                          p.status === 'approved' ? 'bg-green-100 text-green-700' :
                          p.status === 'pending' ? 'bg-amber-100 text-amber-700' :
                          'bg-slate-100 text-slate-500'
                        }`}>
                          {p.status === 'approved' ? '已通过' : p.status === 'pending' ? '待审核' : '已禁用'}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-sm font-semibold text-slate-800">¥{((p.totalCommission || 0) / 100).toFixed(2)}</div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-xs text-slate-500">{p.createdAt?.slice(0, 10)}</div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {p.status === 'pending' ? (
                            <>
                              <OutlineBtn
                                onClick={() => reviewPromoter(p.id, 'approve')}
                                className="px-3 py-1.5 text-xs text-green-600 border-green-200 hover:bg-green-50"
                              >
                                通过
                              </OutlineBtn>
                              <OutlineBtn
                                onClick={() => reviewPromoter(p.id, 'reject')}
                                className="px-3 py-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50"
                              >
                                驳回
                              </OutlineBtn>
                            </>
                          ) : p.status === 'approved' ? (
                            <OutlineBtn
                              onClick={() => reviewPromoter(p.id, 'reject')}
                              className="px-3 py-1.5 text-xs text-red-600 border-red-200 hover:bg-red-50"
                            >
                              禁用
                            </OutlineBtn>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      )}

      {/* ========== 门店二维码 ========== */}
      {activeTab === 'qrcode' && (
        <Card>
          <SectionTitle icon={<QrCode className="w-5 h-5 text-emerald-600" />}>门店小程序码</SectionTitle>
          <StoreQRCode />
        </Card>
      )}

      {/* ========== 优惠券弹窗 ========== */}
      <Dialog open={showCouponForm} onOpenChange={setShowCouponForm}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{editingCoupon?'编辑券':'新建券'}</DialogTitle></DialogHeader>
        <div className="space-y-3"><FormInput placeholder="券名称" value={couponForm.name} onChange={(v)=>setCouponForm({...couponForm,name:v})}/>
        <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={couponForm.type} onChange={(e)=>setCouponForm({...couponForm,type:e.target.value as 'full_reduce' | 'discount' | 'newcomer'})}><option value="full_reduce">满减</option><option value="discount">折扣</option><option value="newcomer">新客</option></select>
        <div className="flex gap-3"><FormInput placeholder={couponForm.type==='discount'?'折扣值（如85）':'面值'} type="number" value={couponForm.value} onChange={(v)=>setCouponForm({...couponForm,value:Number(v)})}/><FormInput placeholder="门槛（0=无门槛）" type="number" value={couponForm.minAmount} onChange={(v)=>setCouponForm({...couponForm,minAmount:Number(v)})}/></div>
        <div className="flex gap-3"><FormInput placeholder="每人限领" type="number" value={couponForm.perUser} onChange={(v)=>setCouponForm({...couponForm,perUser:Number(v)})}/><FormInput placeholder="有效期（天）" type="number" value={couponForm.validDays} onChange={(v)=>setCouponForm({...couponForm,validDays:Number(v)})}/></div>
        <FormInput placeholder="总发行量" type="number" value={couponForm.total} onChange={(v)=>setCouponForm({...couponForm,total:Number(v)})}/></div>
        <DialogFooter><OutlineBtn onClick={()=>setShowCouponForm(false)}>取消</OutlineBtn><PrimaryBtn onClick={saveCoupon}>保存</PrimaryBtn></DialogFooter>
      </DialogContent></Dialog>

      {/* ========== 弹窗：修改密码 ========== */}
      {showPwdModal && (
        <Dialog open={showPwdModal} onOpenChange={setShowPwdModal}>
          <DialogContent className="max-w-[460px]">
            <DialogHeader><DialogTitle>修改密码</DialogTitle></DialogHeader>
            <div className="space-y-4 py-2">
              <div>
                <FormLabel>当前密码</FormLabel>
                <div className="relative">
                  <input type={showPwd.old ? 'text' : 'password'} value={pwdForm.old} onChange={e => setPwdForm(f => ({ ...f, old: e.target.value }))} className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400 pr-9" />
                  <button type="button" onClick={() => setShowPwd(s => ({ ...s, old: !s.old }))} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{showPwd.old ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
                </div>
              </div>
              <div>
                <FormLabel>新密码</FormLabel>
                <div className="relative">
                  <input type={showPwd.new ? 'text' : 'password'} value={pwdForm.new} onChange={e => setPwdForm(f => ({ ...f, new: e.target.value }))} className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400 pr-9" />
                  <button type="button" onClick={() => setShowPwd(s => ({ ...s, new: !s.new }))} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{showPwd.new ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
                </div>
                {pwdForm.new && (
                  <div className="mt-2 flex items-center gap-2">
                    <div className="flex-1 h-1.5 bg-slate-100 rounded-full overflow-hidden"><div className={`h-full rounded-full transition-all ${pwdStrengthColor}`} style={{ width: `${pwdStrength * 33}%` }} /></div>
                    <span className="text-xs text-slate-400">强度: {pwdStrengthLabel}</span>
                  </div>
                )}
              </div>
              <div>
                <FormLabel>确认新密码</FormLabel>
                <div className="relative">
                  <input type={showPwd.confirm ? 'text' : 'password'} value={pwdForm.confirm} onChange={e => setPwdForm(f => ({ ...f, confirm: e.target.value }))} className="w-full px-3 py-2 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-400 pr-9" />
                  <button type="button" onClick={() => setShowPwd(s => ({ ...s, confirm: !s.confirm }))} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600">{showPwd.confirm ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}</button>
                </div>
                {pwdForm.confirm && pwdForm.new !== pwdForm.confirm && <p className="text-xs text-red-500 mt-1">两次密码不一致</p>}
              </div>
              <div className="text-xs text-slate-400 space-y-1 pt-1">
                <p>密码要求：</p>
                <p className="flex items-center gap-1.5"><span className={`w-1 h-1 rounded-full ${pwdForm.new.length >= 8 ? 'bg-emerald-500' : 'bg-slate-300'}`} />至少8个字符</p>
                <p className="flex items-center gap-1.5"><span className={`w-1 h-1 rounded-full ${/[A-Z]/.test(pwdForm.new) ? 'bg-emerald-500' : 'bg-slate-300'}`} />包含大写字母</p>
                <p className="flex items-center gap-1.5"><span className={`w-1 h-1 rounded-full ${/[0-9]/.test(pwdForm.new) ? 'bg-emerald-500' : 'bg-slate-300'}`} />包含数字</p>
              </div>
            </div>
            <DialogFooter>
              <OutlineBtn onClick={() => { setShowPwdModal(false); setPwdForm({ old: '', new: '', confirm: '' }); }}>取消</OutlineBtn>
              <PrimaryBtn onClick={handleChangePwd} disabled={!pwdForm.old || !pwdForm.new || !pwdForm.confirm || pwdForm.new !== pwdForm.confirm || pwdForm.new.length < 8}>确认修改</PrimaryBtn>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}

      {/* ========== 弹窗：退出设备 ========== */}
      {showLogoutModal && (
        <Dialog open={showLogoutModal} onOpenChange={setShowLogoutModal}>
          <DialogContent className="max-w-[400px]">
            <DialogHeader><DialogTitle>退出登录</DialogTitle></DialogHeader>
            <div className="py-2 flex items-center gap-3">
              <div className="w-10 h-10 bg-red-50 rounded-xl flex items-center justify-center flex-shrink-0"><LogOut className="w-5 h-5 text-red-500" /></div>
              <p className="text-sm text-slate-600">确认将该设备退出登录？退出后需要重新登录。</p>
            </div>
            <DialogFooter>
              <OutlineBtn onClick={() => setShowLogoutModal(false)}>取消</OutlineBtn>
              <PrimaryBtn onClick={handleConfirmLogout} className="bg-red-600 hover:bg-red-700">确认退出</PrimaryBtn>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}
