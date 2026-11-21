'use client';

import { useState, useEffect, useCallback, Suspense } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { apiGet, apiPut } from '@/lib/api-client';
import { Settings2, ArrowLeft, Info, Banknote, CalendarClock, Package, Loader2, Percent } from 'lucide-react';

// 预订模式：A=订金 B=全款 AB=双开
type BookingMode = 'A' | 'B' | 'AB';

// 结算模式：agreement=协议价 commission=分佣
type SettleMode = 'agreement' | 'commission';

// 取消政策档位
const cancelTiers: Record<string, { label: string; desc: string; example: string }> = {
  flexible: {
    label: '宽松',
    desc: '入住前 48 小时免费取消，之后扣 30%',
    example: '适合节假日流量大的门店',
  },
  lenient: {
    label: '适中偏宽',
    desc: '入住前 24 小时免费取消，之后扣 50%',
    example: '平衡取消率与收益',
  },
  moderate: {
    label: '适中',
    desc: '入住前 24 小时免费取消，当日扣 100%',
    example: '常用默认档位',
  },
  strict: {
    label: '严格',
    desc: '入住前 48 小时免费取消，之后扣 100%',
    example: '适合旺季稀缺房型',
  },
};

// 各档位对应的阶梯扣费规则（[{beforeHours, chargePct}]，与档位文案一致）
const tierRules: Record<string, { beforeHours: number; chargePct: number }[]> = {
  flexible: [{ beforeHours: 48, chargePct: 0 }, { beforeHours: 0, chargePct: 30 }],
  lenient: [{ beforeHours: 24, chargePct: 0 }, { beforeHours: 0, chargePct: 50 }],
  moderate: [{ beforeHours: 24, chargePct: 0 }, { beforeHours: 0, chargePct: 100 }],
  strict: [{ beforeHours: 48, chargePct: 0 }, { beforeHours: 0, chargePct: 100 }],
};

const modeOptions: { value: BookingMode; label: string; desc: string }[] = [
  { value: 'A', label: '订金模式', desc: '线上付订金，到店补尾款' },
  { value: 'B', label: '全款模式', desc: '线上全额支付' },
  { value: 'AB', label: '双开', desc: '客人可选订金或全款' },
];

const settleModeOptions: { value: SettleMode; label: string; desc: string }[] = [
  { value: 'agreement', label: '协议价', desc: '商家按协议价结算，平台赚取差价' },
  { value: 'commission', label: '分佣', desc: '按每笔交易额比例抽取平台佣金' },
];

interface PlatformProduct {
  id: string;
  name: string;
  productType: string;
  storeId: string;
}

/** 后端 modes 数组（wire）→ 前端单选值：['A','B'] → 'AB' */
const radioFromModes = (modes: string[]): BookingMode => {
  const set = new Set(modes);
  if (set.has('A') && set.has('B')) return 'AB';
  if (set.has('A')) return 'A';
  return 'B';
};

/** 前端单选值 → 后端 modes 数组：'AB' → ['A','B'] */
const modesFromRadio = (m: BookingMode): string[] => (m === 'AB' ? ['A', 'B'] : [m]);

function ProductConfigContent() {
  const router = useRouter();
  const searchParams = useSearchParams();

  const [storeId, setStoreId] = useState('');
  const [products, setProducts] = useState<PlatformProduct[]>([]);
  const [productId, setProductId] = useState('');
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [loadingConfig, setLoadingConfig] = useState(false);
  const [loadError, setLoadError] = useState('');

  const [mode, setMode] = useState<BookingMode>('AB');
  const [depositAmount, setDepositAmount] = useState('500');
  const [tier, setTier] = useState('moderate');
  const [settleMode, setSettleMode] = useState<SettleMode>('commission');
  const [agreementPrice, setAgreementPrice] = useState('');
  const [commissionRate, setCommissionRate] = useState('');
  const [saving, setSaving] = useState(false);
  const [toast, setToast] = useState('');

  const showToast = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(''), 2500);
  };

  // 解析门店：URL query 优先，兜底 localStorage currentStoreId
  const resolveStoreId = useCallback(() => {
    const fromQuery = searchParams.get('storeId');
    if (fromQuery) return fromQuery;
    if (typeof window !== 'undefined') {
      return window.localStorage.getItem('currentStoreId') || '';
    }
    return '';
  }, [searchParams]);

  // 加载商品列表（配置页选择商品用）
  const loadProducts = useCallback(async (sid: string) => {
    setLoadingProducts(true);
    setLoadError('');
    try {
      const res = await apiGet(`/api/platform/config/products?storeId=${encodeURIComponent(sid)}`);
      // /config/products 转发平台 /api/products 返回 { data: { list, total } }
      const raw = res?.data?.list ?? res?.list;
      const list: PlatformProduct[] = Array.isArray(raw) ? raw : [];
      setProducts(list);
      const fromQuery = searchParams.get('productId');
      if (fromQuery && list.some((p) => p.id === fromQuery)) {
        setProductId(fromQuery);
      } else if (list.length > 0) {
        setProductId(list[0].id);
      } else {
        setProductId('');
      }
    } catch (e: any) {
      setProducts([]);
      setProductId('');
      setLoadError(e?.message || '商品列表加载失败');
    }
    setLoadingProducts(false);
  }, [searchParams]);

  // 加载配置回填
  const loadConfig = useCallback(async (sid: string, pid: string) => {
    setLoadingConfig(true);
    setLoadError('');
    try {
      const [bmRes, cpRes, agRes] = await Promise.all([
        apiGet(`/api/platform/config/booking-mode-config?storeId=${encodeURIComponent(sid)}&productId=${encodeURIComponent(pid)}`),
        apiGet(`/api/platform/config/cancel-policy?storeId=${encodeURIComponent(sid)}&productId=${encodeURIComponent(pid)}`),
        apiGet(`/api/platform/config/agreement-config?storeId=${encodeURIComponent(sid)}&productId=${encodeURIComponent(pid)}`),
      ]);
      const bm = bmRes.data || {};
      const cp = cpRes.data || {};
      const ag = agRes.data || {};
      setMode(radioFromModes(bm.modes || ['B']));
      setDepositAmount(String(Math.round((bm.depositAmount ?? 0) / 100)));
      setTier(cp.tier || 'moderate');
      setSettleMode(ag.settleMode === 'agreement' ? 'agreement' : 'commission');
      setAgreementPrice(ag.agreementPrice != null ? String(ag.agreementPrice) : '');
      setCommissionRate(ag.commissionRate != null ? String(ag.commissionRate) : '');
    } catch (e: any) {
      setLoadError(e?.message || '配置加载失败');
    }
    setLoadingConfig(false);
  }, []);

  // 初始化：解析 storeId → 加载商品
  useEffect(() => {
    const sid = resolveStoreId();
    setStoreId(sid);
    if (sid) loadProducts(sid);
  }, [resolveStoreId, loadProducts]);

  // 商品切换时重新加载配置
  useEffect(() => {
    if (storeId && productId) loadConfig(storeId, productId);
  }, [storeId, productId, loadConfig]);

  const handleSave = async () => {
    if (!storeId || !productId) {
      showToast('请先选择门店和商品');
      return;
    }
    const depositCents = Number.isFinite(Number(depositAmount))
      ? Math.round(Number(depositAmount) * 100)
      : 0;
    // 协议价/分佣：按当前结算模式构造载荷（未用字段省略，避免传 null 触发后端校验失败）
    // 注意：agreementPrice 直接以「元」提交，不做 ×100/÷100 换算（区别于上方 depositAmount 的「分」习惯）
    const agreementPayload: Record<string, unknown> = { storeId, productId, settleMode };
    if (settleMode === 'agreement') {
      const rawPrice = Number(agreementPrice);
      if (agreementPrice.trim() === '' || !Number.isFinite(rawPrice) || rawPrice < 0) {
        showToast('请输入有效的协议价（非负金额）');
        return;
      }
      // 限制两位小数（后端 decimal(10,2)，超位四舍五入会致回填不一致）；并设上限防 DB 溢出
      const price = Math.round(rawPrice * 100) / 100;
      if (price > 99999999.99) {
        showToast('协议价过大，不能超过 99999999.99');
        return;
      }
      agreementPayload.agreementPrice = price;
    } else {
      const rate = Number(commissionRate);
      if (commissionRate.trim() === '' || !Number.isInteger(rate) || rate < 0 || rate > 100) {
        showToast('分佣比例需为 0-100 的整数');
        return;
      }
      agreementPayload.commissionRate = rate;
    }
    setSaving(true);
    try {
      await Promise.all([
        apiPut('/api/platform/config/booking-mode-config', {
          storeId,
          productId,
          modes: modesFromRadio(mode),
          depositAmount: depositCents,
        }),
        apiPut('/api/platform/config/cancel-policy', {
          storeId,
          productId,
          tier,
          rules: tierRules[tier] || [],
        }),
        apiPut('/api/platform/config/agreement-config', agreementPayload),
      ]);
      showToast('配置已保存');
    } catch (e: any) {
      showToast(e?.message || '保存失败');
    }
    setSaving(false);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        title="套餐配置"
        subtitle="预订模式、取消政策档位与协议价/分佣"
        icon={<Settings2 className="w-5 h-5" />}
        actions={[
          {
            label: '返回套餐订单',
            icon: <ArrowLeft className="w-4 h-4" />,
            onClick: () => router.push('/orders/product'),
          },
        ]}
      />

      {/* 门店 + 商品选择 */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex flex-wrap items-center gap-4">
        <Package className="w-5 h-5 text-emerald-500 shrink-0" />
        <div>
          <p className="text-xs text-slate-400">当前门店</p>
          <p className="text-sm font-medium text-slate-800">{storeId || '未选择'}</p>
        </div>
        <div className="flex-1 min-w-[240px]">
          <label className="block text-xs text-slate-400 mb-1">配置商品</label>
          <select
            value={productId}
            onChange={(e) => setProductId(e.target.value)}
            disabled={loadingProducts || products.length === 0}
            className="w-full max-w-md px-4 py-2.5 border border-slate-200 rounded-xl text-sm bg-white focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500 disabled:bg-slate-50"
          >
            {loadingProducts && <option>加载商品中...</option>}
            {!loadingProducts && products.length === 0 && <option value="">该门店暂无商品</option>}
            {products.map((p) => (
              <option key={p.id} value={p.id}>{p.name}</option>
            ))}
          </select>
        </div>
        {loadingConfig && (
          <span className="inline-flex items-center gap-1.5 text-xs text-slate-400">
            <Loader2 className="w-3.5 h-3.5 animate-spin" /> 加载配置
          </span>
        )}
      </div>

      {!storeId && (
        <div className="bg-amber-50 border border-amber-200 rounded-xl p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          <p className="text-sm text-amber-800">未检测到当前门店，请先在民宿端选择门店后再进行套餐配置。</p>
        </div>
      )}

      {loadError && (
        <div className="bg-red-50 border border-red-200 rounded-xl p-4 flex items-start gap-3">
          <Info className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <p className="text-sm text-red-700">{loadError}</p>
        </div>
      )}

      <div className="grid lg:grid-cols-2 gap-5">
        {/* 预订模式配置 */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Banknote className="w-4 h-4 text-emerald-500" />
            <h3 className="text-base font-semibold text-slate-800">预订模式</h3>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid gap-3">
              {modeOptions.map(opt => (
                <label
                  key={opt.value}
                  className={`flex items-center gap-3 border rounded-xl px-4 py-3 cursor-pointer transition-colors ${
                    mode === opt.value ? 'border-emerald-500 bg-emerald-50/60' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="mode"
                    value={opt.value}
                    checked={mode === opt.value}
                    onChange={() => setMode(opt.value)}
                    className="accent-emerald-500"
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-800">{opt.label}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{opt.desc}</div>
                  </div>
                  {mode === opt.value && <StatusBadge label="已选" type="success" className="ml-auto" />}
                </label>
              ))}
            </div>
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-1.5">订金金额（元）</label>
              <input
                type="number"
                min={0}
                className="w-full max-w-xs px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                value={depositAmount}
                onChange={e => setDepositAmount(e.target.value)}
              />
              <p className="text-xs text-slate-400 mt-1.5">仅订金模式（A）生效；全款模式不拆分。</p>
            </div>
          </div>
        </div>

        {/* 取消政策档位 */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <CalendarClock className="w-4 h-4 text-emerald-500" />
            <h3 className="text-base font-semibold text-slate-800">取消政策档位</h3>
          </div>
          <div className="p-5 space-y-3">
            {Object.entries(cancelTiers).map(([key, tierInfo]) => (
              <label
                key={key}
                className={`flex items-start gap-3 border rounded-xl px-4 py-3 cursor-pointer transition-colors ${
                  tier === key ? 'border-emerald-500 bg-emerald-50/60' : 'border-slate-200 hover:border-slate-300'
                }`}
              >
                <input
                  type="radio"
                  name="tier"
                  value={key}
                  checked={tier === key}
                  onChange={() => setTier(key)}
                  className="accent-emerald-500 mt-0.5"
                />
                <div className="flex-1">
                  <div className="flex items-center gap-2">
                    <span className="text-sm font-medium text-slate-800">{tierInfo.label}</span>
                    {tier === key && <StatusBadge label="已选" type="success" />}
                  </div>
                  <div className="text-xs text-slate-600 mt-0.5">{tierInfo.desc}</div>
                  <div className="text-[10px] text-slate-400 mt-0.5">{tierInfo.example}</div>
                </div>
              </label>
            ))}
            <div className="bg-blue-50 rounded-xl p-3 flex items-start gap-2">
              <Info className="w-4 h-4 text-blue-500 shrink-0 mt-0.5" />
              <p className="text-xs text-blue-700">退款时按所选档位的阶梯规则计算可退金额；已确认预约/已接单订单不可由民宿退款。</p>
            </div>
          </div>
        </div>

        {/* 协议价/分佣配置 */}
        <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden lg:col-span-2">
          <div className="px-5 py-4 border-b border-slate-100 flex items-center gap-2">
            <Percent className="w-4 h-4 text-emerald-500" />
            <h3 className="text-base font-semibold text-slate-800">协议价/分佣</h3>
          </div>
          <div className="p-5 space-y-4">
            <div className="grid md:grid-cols-2 gap-3">
              {settleModeOptions.map(opt => (
                <label
                  key={opt.value}
                  className={`flex items-center gap-3 border rounded-xl px-4 py-3 cursor-pointer transition-colors ${
                    settleMode === opt.value ? 'border-emerald-500 bg-emerald-50/60' : 'border-slate-200 hover:border-slate-300'
                  }`}
                >
                  <input
                    type="radio"
                    name="settleMode"
                    value={opt.value}
                    checked={settleMode === opt.value}
                    onChange={() => setSettleMode(opt.value)}
                    className="accent-emerald-500"
                  />
                  <div>
                    <div className="text-sm font-medium text-slate-800">{opt.label}</div>
                    <div className="text-xs text-slate-500 mt-0.5">{opt.desc}</div>
                  </div>
                  {settleMode === opt.value && <StatusBadge label="已选" type="success" className="ml-auto" />}
                </label>
              ))}
            </div>

            {settleMode === 'agreement' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">协议价（元）</label>
                <input
                  type="number"
                  min={0}
                  step="0.01"
                  className="w-full max-w-xs px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                  value={agreementPrice}
                  onChange={e => setAgreementPrice(e.target.value)}
                  placeholder="例如 150"
                />
                <p className="text-xs text-slate-400 mt-1.5">协议价直接以元填写、不做任何换算（区别于订金字段的分值习惯）；商家按此结算，客人实付与协议价之间的差价计入平台。</p>
              </div>
            )}

            {settleMode === 'commission' && (
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">分佣比例（%）</label>
                <input
                  type="number"
                  min={0}
                  max={100}
                  step="1"
                  className="w-full max-w-xs px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
                  value={commissionRate}
                  onChange={e => setCommissionRate(e.target.value)}
                  placeholder="例如 10"
                />
                <p className="text-xs text-slate-400 mt-1.5">平台按每笔交易额抽取该比例佣金，需为 0-100 的整数。</p>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 保存栏 */}
      <div className="bg-white rounded-xl border border-slate-200 p-4 flex items-center justify-between">
        <span className="text-sm text-slate-500">配置保存后对所选商品的私域套餐生效</span>
        <button
          onClick={handleSave}
          disabled={saving || !storeId || !productId}
          className="px-6 py-2.5 bg-gradient-to-r from-emerald-500 to-emerald-600 text-white rounded-xl text-sm font-medium hover:shadow-lg hover:shadow-emerald-500/25 disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {saving ? '保存中...' : '保存配置'}
        </button>
      </div>

      {toast && (
        <div className="fixed top-5 left-1/2 -translate-x-1/2 z-[60] bg-slate-800 text-white px-4 py-2 rounded-lg text-sm shadow-lg">
          {toast}
        </div>
      )}
    </div>
  );
}

export default function ProductConfigPage() {
  return (
    <Suspense fallback={<div className="p-6 text-sm text-slate-500">加载中...</div>}>
      <ProductConfigContent />
    </Suspense>
  );
}
