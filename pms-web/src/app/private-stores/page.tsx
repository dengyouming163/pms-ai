'use client';

import { useEffect, useState } from 'react';
import { apiGet, apiPut, apiPost } from '@/lib/api-client';
import { PageHeader } from '@/components/page-header';
import { TabBar } from '@/components/tab-bar';


import { Badge } from '@/components/ui/badge';
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from '@/components/ui/dialog';

import { Switch } from '@/components/ui/switch';
import { toast } from 'sonner';
import { Store, CheckCircle, XCircle, Clock, Plus, Edit, Loader2, Image as ImageIcon } from 'lucide-react';
import { ApplyForm } from './apply-form';
import { AssetPicker } from '@/components/asset-picker';
import type { ApplicationData, PackageData, CouponData, PromoterData } from './types';

function Card({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <div className={`bg-white rounded-xl border border-slate-200 p-5 ${className}`}>{children}</div>;
}

function FormLabel({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return <label className={`block text-sm font-medium text-slate-700 mb-2 ${className}`}>{children}</label>;
}

function FormInput({ 
  value, onChange, type = 'text', placeholder = '', disabled = false, className = '' 
}: { 
  value: string | number; 
  onChange: (v: string) => void; 
  type?: string; 
  placeholder?: string; 
  disabled?: boolean;
  className?: string;
}) {
  return (
    <input 
      type={type} 
      value={value} 
      onChange={e => onChange(e.target.value)} 
      placeholder={placeholder} 
      disabled={disabled} 
      className={`w-full px-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition ${disabled ? 'bg-slate-50 text-slate-400 cursor-not-allowed' : ''} ${className}`} 
    />
  );
}

function FormTextarea({ value, onChange, rows = 3, placeholder = '', className = '' }: { 
  value: string; 
  onChange: (v: string) => void; 
  rows?: number; 
  placeholder?: string;
  className?: string;
}) {
  return (
    <textarea 
      value={value} 
      onChange={e => onChange(e.target.value)} 
      rows={rows} 
      placeholder={placeholder} 
      className={`w-full px-4 py-2.5 text-sm rounded-xl border border-slate-200 focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 transition resize-none ${className}`} 
    />
  );
}

function PrimaryBtn({ children, onClick, disabled = false, loading = false, className = '' }: { 
  children: React.ReactNode; 
  onClick: () => void; 
  disabled?: boolean; 
  loading?: boolean; 
  className?: string;
}) {
  return (
    <button 
      onClick={onClick} 
      disabled={disabled || loading} 
      className={`px-5 py-2.5 text-sm text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed rounded-xl transition-colors flex items-center gap-1.5 ${className}`}
    >
      {loading ? '处理中...' : children}
    </button>
  );
}

function OutlineBtn({ children, onClick, className = '', danger = false }: { 
  children: React.ReactNode; 
  onClick: () => void; 
  className?: string; 
  danger?: boolean;
}) {
  return (
    <button onClick={onClick} className={`px-5 py-2.5 text-sm rounded-xl border transition-colors flex items-center gap-1.5 ${danger ? 'border-red-200 text-red-600 hover:bg-red-50' : 'border-slate-200 text-slate-600 hover:bg-slate-50'} ${className}`}>
      {children}
    </button>
  );
}

const tabs = [
  { key: 'decoration', label: '门店装修' },
  { key: 'application', label: '进件与收款' },
  { key: 'coupons', label: '优惠券管理' },
  { key: 'promoters', label: '分销管理' },
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

export default function PrivateStoresPage() {
  const [activeTab, setActiveTab] = useState('decoration');
  const [storeId, setStoreId] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const [headerImages, setHeaderImages] = useState('');
  const [intro, setIntro] = useState('');
  const [gallery, setGallery] = useState('');
  const [cancelPolicy, setCancelPolicy] = useState({ freeHours: 24, feeRate: 20 });
  const [online, setOnline] = useState(false);
  const [memberDiscounts, setMemberDiscounts] = useState<Record<string, number>>({});

  const [application, setApplication] = useState<ApplicationData | null>(null);

  const [packageList, setPackageList] = useState<PackageData[]>([]);
  const [showPkgForm, setShowPkgForm] = useState(false);
  const [editingPkg, setEditingPkg] = useState<PackageData | null>(null);
  const [pkgForm, setPkgForm] = useState({ name: '', price: 0, stock: -1, description: '', roomTypeIds: '', benefits: '', images: '' });

  const [couponList, setCouponList] = useState<CouponData[]>([]);
  const [showCouponForm, setShowCouponForm] = useState(false);
  const [editingCoupon, setEditingCoupon] = useState<CouponData | null>(null);
  const [couponForm, setCouponForm] = useState({ name: '', type: 'full_reduce', value: 0, minAmount: 0, perUser: 1, validDays: 30, total: 100 } as any);

  const [promoterList, setPromoterList] = useState<PromoterData[]>([]);
  const [listLoading, setListLoading] = useState('');
  const [showAssetPicker, setShowAssetPicker] = useState(false);
  const [assetTarget, setAssetTarget] = useState<'header' | 'gallery'>('header');

  useEffect(() => {
    const sid = (typeof window !== 'undefined' && localStorage.getItem('currentStoreId')) || '';
    setStoreId(sid); if (!sid) { setLoading(false); return; }
    Promise.all([apiGet('/api/mini-admin/store-config'), apiGet('/api/mini-admin/application')])
      .then(([cr, ar]) => { const c = cr?.data || cr; const a = ar?.data || ar; if (c) { setHeaderImages((c.headerImages||[]).join('\n')); setIntro(c.intro||''); setGallery((c.gallery||[]).join('\n')); setCancelPolicy(c.cancelPolicy||{freeHours:24,feeRate:20}); setOnline(c.online||false); setMemberDiscounts(c.memberDiscounts||{}); } if (a) setApplication(a); })
      .catch(()=>{}).finally(()=>setLoading(false));
  }, []);

  async function saveDecoration() { setSaving(true); try { await apiPut('/api/mini-admin/store-config',{headerImages:headerImages.split('\n').map(s=>s.trim()).filter(Boolean),intro,gallery:gallery.split('\n').map(s=>s.trim()).filter(Boolean),cancelPolicy,memberDiscounts,online}); toast.success('已保存'); } catch(e:unknown){toast.error((e as { error?: string })?.error||'保存失败')} finally{setSaving(false)} }
  async function submitApp(data: ApplicationData) { setSaving(true); try { await apiPost('/api/mini-admin/application',data); const r=await apiGet('/api/mini-admin/application'); setApplication(r?.data||r); toast.success('已提交'); } catch(e:unknown){toast.error((e as { error?: string })?.error||'提交失败')} finally{setSaving(false)} }

  async function loadList(type: 'packages' | 'coupons' | 'promoters') { setListLoading(type); try { const r=await apiGet(`/api/mini-admin/${type}`); if(type==='packages')setPackageList(r?.data||[]); else if(type==='coupons')setCouponList(r?.data||[]); else if(type==='promoters')setPromoterList(r?.data||[]); } catch {} finally { setListLoading(''); } }
  async function savePkg() { const b={...pkgForm,price:Number(pkgForm.price),stock:Number(pkgForm.stock),roomTypeIds:pkgForm.roomTypeIds.split(',').map((s:string)=>s.trim()).filter(Boolean),benefits:pkgForm.benefits.split('\n').map((s:string)=>s.trim()).filter(Boolean),images:pkgForm.images.split('\n').map((s:string)=>s.trim()).filter(Boolean)}; if(editingPkg)await apiPut(`/api/mini-admin/packages/${editingPkg.id}`,b); else await apiPost('/api/mini-admin/packages',b); setShowPkgForm(false);setEditingPkg(null);loadList('packages');toast.success('OK'); }
  async function togglePkg(p: PackageData){await apiPost(`/api/mini-admin/packages/${p.id}/toggle`);loadList('packages')}
  async function saveCoupon(){const b={...couponForm,value:Number(couponForm.value),minAmount:Number(couponForm.minAmount),perUser:Number(couponForm.perUser),validDays:Number(couponForm.validDays),total:Number(couponForm.total)};if(editingCoupon)await apiPut(`/api/mini-admin/coupons/${editingCoupon.id}`,b);else await apiPost('/api/mini-admin/coupons',b);setShowCouponForm(false);setEditingCoupon(null);loadList('coupons');toast.success('OK');}
  async function toggleCoupon(c: CouponData){await apiPost(`/api/mini-admin/coupons/${c.id}/toggle`);loadList('coupons')}
  async function reviewPromoter(id:string,action:string){try{await apiPost(`/api/mini-admin/promoters/${id}/review`,{action});loadList('promoters');toast.success(action==='approve'?'已通过':'已处理')}catch(e:unknown){toast.error((e as { error?: string })?.error||'操作失败')}}

  useEffect(()=>{if(activeTab==='packages')loadList('packages');if(activeTab==='coupons')loadList('coupons');if(activeTab==='promoters')loadList('promoters');},[activeTab]);

  if(loading)return <div className="flex items-center justify-center py-20 text-slate-400"><Loader2 className="w-6 h-6 animate-spin mr-2"/>加载中...</div>;
  if(!storeId)return <div className="flex items-center justify-center py-20 text-slate-400">请先在顶部选择门店</div>;

  return (<div className="space-y-5">
    <PageHeader title="私域门店" subtitle="管理小程序门店装修、收款进件与营销工具" icon={<Store className="w-5 h-5"/>}/>
    <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab}/>

    {activeTab === 'decoration' && (
      <Card>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">🎨 门店装修</h3>
          <PrimaryBtn onClick={saveDecoration} loading={saving}>保存配置</PrimaryBtn>
        </div>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
          {/* 左侧：图片区域 */}
          <div className="space-y-5">
            <div>
              <div className="flex items-center justify-between mb-3">
                <FormLabel>头图（最多9张）</FormLabel>
                <OutlineBtn onClick={() => { setAssetTarget('header'); setShowAssetPicker(true); }} className="px-3 py-1.5 text-xs">
                  <ImageIcon className="w-3 h-3" />从素材库选择
                </OutlineBtn>
              </div>
              <div className="grid grid-cols-3 gap-2">
                {headerImages.split('\n').filter(Boolean).map((url, i) => (
                  <div key={i} className="relative aspect-video rounded-xl overflow-hidden border border-slate-200 bg-slate-50 group">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    <button 
                      onClick={() => { 
                        const lines = headerImages.split('\n'); 
                        lines.splice(lines.indexOf(url), 1); 
                        setHeaderImages(lines.join('\n')); 
                      }} 
                      className="absolute top-1 right-1 w-5 h-5 bg-red-500 text-white rounded-full text-[10px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {headerImages.split('\n').filter(Boolean).length < 9 && (
                  <button 
                    onClick={() => { setAssetTarget('header'); setShowAssetPicker(true); }} 
                    className="aspect-video rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center text-slate-400 hover:border-emerald-300 hover:text-emerald-500 transition"
                  >
                    <Plus className="w-5 h-5" />
                  </button>
                )}
              </div>
            </div>
            <div>
              <div className="flex items-center justify-between mb-3">
                <FormLabel>相册（最多30张）</FormLabel>
                <OutlineBtn onClick={() => { setAssetTarget('gallery'); setShowAssetPicker(true); }} className="px-3 py-1.5 text-xs">
                  <ImageIcon className="w-3 h-3" />从素材库选择
                </OutlineBtn>
              </div>
              <div className="grid grid-cols-6 gap-2">
                {gallery.split('\n').filter(Boolean).map((url, i) => (
                  <div key={i} className="relative aspect-square rounded-xl overflow-hidden border border-slate-200 bg-slate-50 group">
                    <img src={url} alt="" className="w-full h-full object-cover" />
                    <button 
                      onClick={() => { 
                        const lines = gallery.split('\n'); 
                        lines.splice(lines.indexOf(url), 1); 
                        setGallery(lines.join('\n')); 
                      }} 
                      className="absolute top-0.5 right-0.5 w-4 h-4 bg-red-500 text-white rounded-full text-[9px] flex items-center justify-center opacity-0 group-hover:opacity-100 transition"
                    >
                      ×
                    </button>
                  </div>
                ))}
                {gallery.split('\n').filter(Boolean).length < 30 && (
                  <button 
                    onClick={() => { setAssetTarget('gallery'); setShowAssetPicker(true); }} 
                    className="aspect-square rounded-xl border-2 border-dashed border-slate-200 flex items-center justify-center text-slate-400 hover:border-emerald-300 hover:text-emerald-500 transition"
                  >
                    <Plus className="w-4 h-4" />
                  </button>
                )}
              </div>
            </div>
          </div>
          {/* 右侧：信息区域 */}
          <div className="space-y-5">
            <div>
              <FormLabel>门店简介</FormLabel>
              <FormTextarea 
                value={intro} 
                onChange={setIntro} 
                rows={4} 
                placeholder="介绍你的民宿特色..." 
              />
            </div>
            <div className="grid grid-cols-2 gap-4">
              <div>
                <FormLabel>免费取消时限</FormLabel>
                <FormInput 
                  type="number" 
                  value={cancelPolicy.freeHours} 
                  onChange={(v: string) => setCancelPolicy({ ...cancelPolicy, freeHours: Number(v) })} 
                  placeholder="24" 
                />
                <span className="text-xs text-slate-400 mt-1 block">入住前N小时</span>
              </div>
              <div>
                <FormLabel>超时手续费</FormLabel>
                <FormInput 
                  type="number" 
                  value={cancelPolicy.feeRate} 
                  onChange={(v: string) => setCancelPolicy({ ...cancelPolicy, feeRate: Number(v) })} 
                  placeholder="20" 
                />
                <span className="text-xs text-slate-400 mt-1 block">%</span>
              </div>
            </div>
            <div>
              <FormLabel>会员折扣率（%）</FormLabel>
              <div className="space-y-3">
                {[{ key: 'gold', label: '金卡' }, { key: 'platinum', label: '白金卡' }, { key: 'diamond', label: '钻石卡' }].map(lv => (
                  <div key={lv.key} className="flex items-center gap-3">
                    <span className="text-sm text-slate-600 w-16">{lv.label}</span>
                    <FormInput 
                      type="number" 
                      value={memberDiscounts[lv.key] || ''} 
                      onChange={(v: string) => setMemberDiscounts({ ...memberDiscounts, [lv.key]: Number(v) || 0 })} 
                      placeholder="100" 
                      className="flex-1" 
                    />
                    <span className="text-xs text-slate-400">%</span>
                  </div>
                ))}
              </div>
            </div>
            <div className="flex items-center gap-3 pt-2">
              <Switch checked={online} onCheckedChange={setOnline} />
              <span className="text-sm font-medium text-slate-700">上线门店</span>
              <span className="text-xs text-slate-400">需先完成进件</span>
            </div>
          </div>
        </div>
      </Card>
    )}

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

    {activeTab === 'packages' && (
      <Card>
        <div className="flex items-center justify-between mb-5">
          <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">📦 套餐管理</h3>
          <PrimaryBtn 
            onClick={() => { 
              setEditingPkg(null); 
              setPkgForm({ name: '', price: 0, stock: -1, description: '', roomTypeIds: '', benefits: '', images: '' }); 
              setShowPkgForm(true); 
            }} 
            className="px-4 py-2 text-sm"
          >
            <Plus className="w-4 h-4" />新建套餐
          </PrimaryBtn>
        </div>
        {listLoading === 'packages' ? (
          <p className="text-center py-12 text-slate-400">
            <Loader2 className="w-5 h-5 animate-spin inline mr-2" />加载中...
          </p>
        ) : packageList.length === 0 ? (
          <p className="text-center py-12 text-slate-400">暂无套餐</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead className="bg-slate-50">
                <tr>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">名称</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">价格</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">库存</th>
                  <th className="text-left px-4 py-3 text-xs font-medium text-slate-500">状态</th>
                  <th className="text-right px-4 py-3 text-xs font-medium text-slate-500">操作</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {packageList.map((p) => (
                  <tr key={p.id} className="hover:bg-slate-50/50">
                    <td className="px-4 py-3">
                      <div className="text-sm font-medium text-slate-800">{p.name}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm font-semibold text-slate-800">¥{p.price}</div>
                    </td>
                    <td className="px-4 py-3">
                      <div className="text-sm text-slate-600">{p.stock === -1 ? '不限' : p.stock}</div>
                    </td>
                    <td className="px-4 py-3">
                      <span className={`px-2.5 py-1 rounded-lg text-xs font-medium ${
                        p.status === 'approved' ? 'bg-green-100 text-green-700' : 'bg-slate-100 text-slate-500'
                      }`}>
                        {p.status === 'approved' ? '上架' : '下架'}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right">
                      <div className="flex items-center justify-end gap-2">
                        <OutlineBtn 
                          onClick={() => { 
                            setEditingPkg(p); 
                            setPkgForm({ 
                              name: p.name || '', 
                              price: p.price || 0, 
                              stock: p.stock ?? -1, 
                              description: p.description || '', 
                              roomTypeIds: (p.roomTypeIds || []).join(', '), 
                              benefits: (p.benefits || []).join('\n'), 
                              images: (p.images || []).join('\n') 
                            }); 
                            setShowPkgForm(true); 
                          }} 
                          className="px-3 py-1.5 text-xs"
                        >
                          <Edit className="w-3 h-3" />编辑
                        </OutlineBtn>
                        <OutlineBtn 
                          onClick={() => togglePkg(p)} 
                          className="px-3 py-1.5 text-xs"
                        >
                          {p.status === 'approved' ? '下架' : '上架'}
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

    <Dialog open={showPkgForm} onOpenChange={setShowPkgForm}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{editingPkg?'编辑套餐':'新建套餐'}</DialogTitle></DialogHeader>
      <div className="space-y-3"><FormInput placeholder="套餐名称" value={pkgForm.name} onChange={(v)=>setPkgForm({...pkgForm,name:v})}/>
      <div className="flex gap-3"><FormInput placeholder="价格" type="number" value={pkgForm.price} onChange={(v)=>setPkgForm({...pkgForm,price:Number(v)})}/><FormInput placeholder="库存（-1不限）" type="number" value={pkgForm.stock} onChange={(v)=>setPkgForm({...pkgForm,stock:Number(v)})}/></div>
      <FormTextarea placeholder="描述" value={pkgForm.description} onChange={(v)=>setPkgForm({...pkgForm,description:v})} rows={3}/>
      <FormInput placeholder="适用房型ID（逗号分隔）" value={pkgForm.roomTypeIds} onChange={(v)=>setPkgForm({...pkgForm,roomTypeIds:v})}/>
      <FormTextarea placeholder="权益（每行一个）" value={pkgForm.benefits} onChange={(v)=>setPkgForm({...pkgForm,benefits:v})} rows={3}/>
      <FormInput placeholder="图片URL（每行一个）" value={pkgForm.images} onChange={(v)=>setPkgForm({...pkgForm,images:v})}/></div>
      <DialogFooter><OutlineBtn onClick={()=>setShowPkgForm(false)}>取消</OutlineBtn><PrimaryBtn onClick={savePkg}>保存</PrimaryBtn></DialogFooter>
    </DialogContent></Dialog>

    <Dialog open={showCouponForm} onOpenChange={setShowCouponForm}><DialogContent className="sm:max-w-md"><DialogHeader><DialogTitle>{editingCoupon?'编辑券':'新建券'}</DialogTitle></DialogHeader>
      <div className="space-y-3"><FormInput placeholder="券名称" value={couponForm.name} onChange={(v)=>setCouponForm({...couponForm,name:v})}/>
      <select className="w-full rounded-lg border border-slate-200 px-3 py-2 text-sm" value={couponForm.type} onChange={(e)=>setCouponForm({...couponForm,type:e.target.value as 'full_reduce' | 'discount' | 'newcomer'})}><option value="full_reduce">满减</option><option value="discount">折扣</option><option value="newcomer">新客</option></select>
      <div className="flex gap-3"><FormInput placeholder={couponForm.type==='discount'?'折扣值（如85）':'面值'} type="number" value={couponForm.value} onChange={(v)=>setCouponForm({...couponForm,value:Number(v)})}/><FormInput placeholder="门槛（0=无门槛）" type="number" value={couponForm.minAmount} onChange={(v)=>setCouponForm({...couponForm,minAmount:Number(v)})}/></div>
      <div className="flex gap-3"><FormInput placeholder="每人限领" type="number" value={couponForm.perUser} onChange={(v)=>setCouponForm({...couponForm,perUser:Number(v)})}/><FormInput placeholder="有效期（天）" type="number" value={couponForm.validDays} onChange={(v)=>setCouponForm({...couponForm,validDays:Number(v)})}/></div>
      <FormInput placeholder="总发行量" type="number" value={couponForm.total} onChange={(v)=>setCouponForm({...couponForm,total:Number(v)})}/></div>
      <DialogFooter><OutlineBtn onClick={()=>setShowCouponForm(false)}>取消</OutlineBtn><PrimaryBtn onClick={saveCoupon}>保存</PrimaryBtn></DialogFooter>
    </DialogContent></Dialog>

    <AssetPicker open={showAssetPicker} onOpenChange={setShowAssetPicker} onSelect={(url)=>{
      if(assetTarget==='header') setHeaderImages(f=>{const lines=f.split('\n').filter(Boolean);if(lines.length>=9){toast.error('最多9张');return f;} return [...lines,url].join('\n')});
      else setGallery(f=>{const lines=f.split('\n').filter(Boolean);if(lines.length>=30){toast.error('最多30张');return f;} return [...lines,url].join('\n')});
      toast.success('已添加');
    }}/>
  </div>);
}
