'use client';

import { useState, useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { apiGet, apiPost } from '@/lib/api-client';
import { Button } from '@/components/ui/button';

interface CompConfig { id: string; hotelName: string; platform: string; platformHotelId: string; platformUrl: string; competitorRoomType: string; ourRoomTypeId: string; lastPrice: number; lastCrawledAt: string; status: string; }

const PLATFORM_INFO: Record<string, { url: string; searchHint: string; appHint: string }> = {
  '携程': { url: 'https://hotels.ctrip.com/', searchHint: 'PC网页直达酒店页', appHint: '携程App→搜索酒店名→详情页网址中hotel后的数字即酒店ID' },
  '美团': { url: 'https://hotel.meituan.com/', searchHint: 'PC网页需登录', appHint: '美团App→酒店→搜索酒店名→详情→分享→复制链接' },
  '飞猪': { url: 'https://www.fliggy.com/', searchHint: 'PC网页可搜索', appHint: '飞猪App→酒店→搜索酒店名→详情页' },
  '抖音': { url: 'https://www.douyin.com/', searchHint: '无酒店独立页', appHint: '抖音App→搜索酒店名→团购页面看价格' },
  '途家': { url: 'https://www.tujia.com/', searchHint: 'PC网页搜索', appHint: '途家App→搜索酒店名→详情页' },
  'Booking': { url: 'https://www.booking.com/', searchHint: 'PC网页搜索', appHint: 'Booking App→搜索酒店名→详情页' },
};

const MAX_COMPETITORS = 10;

export default function CompetitorPage() {
  const router = useRouter();
  const [configs, setConfigs] = useState<CompConfig[]>([]);
  const [roomTypes, setRoomTypes] = useState<any[]>([]);
  const [activeChannels, setActiveChannels] = useState<string[]>([]);
  const [storeInfo, setStoreInfo] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({ hotelName: '', platform: '', platformHotelId: '', platformUrl: '', competitorRoomType: '', ourRoomTypeId: '' });
  const [historyModal, setHistoryModal] = useState<CompConfig | null>(null);
  const [priceHistory, setPriceHistory] = useState<any[]>([]);
  const [editPriceModal, setEditPriceModal] = useState<CompConfig | null>(null);
  const [editPrice, setEditPrice] = useState('');
  const [deleteModal, setDeleteModal] = useState<CompConfig | null>(null);
  const [showGuide, setShowGuide] = useState(true);

  useEffect(() => {
    Promise.all([
      apiGet('/api/competitor-prices').catch(() => ({ data: [] })),
      apiGet('/api/stores?type=roomTypes').catch(() => []),
      apiGet('/api/pricing?type=channel-pricing').catch(() => ({ channels: [] })),
      apiGet('/api/stores').catch(() => []),
    ]).then(([compData, rtData, chData, storesData]: any[]) => {
      setConfigs(compData?.data || []);
      setRoomTypes(Array.isArray(rtData) ? rtData : []);
      setActiveChannels((chData?.channels || []).map((c: any) => c.name));
      const stores = Array.isArray(storesData) ? storesData : [];
      if (stores.length > 0) setStoreInfo(stores[0]);
      setLoading(false);
    });
  }, []);

  const canAdd = configs.length < MAX_COMPETITORS;

  const handleAdd = async () => {
    if (!form.hotelName || !form.platform) return;
    await apiPost('/api/competitor-prices', form);
    const d = await apiGet('/api/competitor-prices') as any;
    setConfigs(d?.data || []);
    setShowForm(false);
    setForm({ hotelName: '', platform: '', platformHotelId: '', platformUrl: '', competitorRoomType: '', ourRoomTypeId: '' });
  };

  const getQuickLink = (cfg: CompConfig) => {
    if (cfg.platformUrl) return cfg.platformUrl;
    if (cfg.platform === '携程' && cfg.platformHotelId) return `https://hotels.ctrip.com/hotel/${cfg.platformHotelId}.html`;
    if (cfg.platform === '美团' && cfg.platformHotelId) return `https://hotel.meituan.com/${cfg.platformHotelId}/`;
    return PLATFORM_INFO[cfg.platform]?.url || '#';
  };

  return (
    <div className="h-screen bg-gradient-to-br from-slate-50 via-white to-blue-50 flex flex-col">
      <div className="flex items-center justify-between px-6 py-3 bg-white/90 border-b flex-shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center text-xl shadow-md">🔍</div>
          <div><h1 className="text-base font-bold text-slate-800">竞品价格管理</h1><p className="text-xs text-slate-400">{configs.length}/{MAX_COMPETITORS} 个竞品{storeInfo && ` · 📍 ${storeInfo.name}`}</p></div>
        </div>
        <div className="flex items-center gap-2">
          <Button onClick={() => setShowForm(true)} disabled={!canAdd} size="sm" variant="outline" className="text-xs">{canAdd ? `+ 添加竞品(${configs.length}/${MAX_COMPETITORS})` : `已满(${MAX_COMPETITORS})`}</Button>
          <button onClick={() => router.back()} className="text-xs px-3 py-1.5 border border-slate-200 rounded-lg text-slate-400 hover:text-slate-600">← 返回</button>
        </div>
      </div>

      <div className="flex flex-1 min-h-0">
        <div className="flex-1 overflow-y-auto p-6 space-y-4 max-w-5xl mx-auto">
          {showGuide && configs.length === 0 && (
            <div className="bg-gradient-to-br from-blue-50 via-white to-indigo-50 rounded-2xl border border-blue-200 p-6">
              <div className="flex items-center justify-between mb-3"><h3 className="font-bold text-slate-800">📖 3 步开始竞品价格管理</h3><button onClick={() => setShowGuide(false)} className="text-xs text-slate-400">收起</button></div>
              <div className="grid grid-cols-3 gap-4 text-sm">
                {[{step:'①',title:'添加竞品酒店',desc:'点击"添加竞品"，输入酒店名+选择OTA平台。建议添加同商圈同星级的3-5个竞品。'},
                  {step:'②',title:'定期录价',desc:'在OTA App搜索竞品→查看价格→回系统点✏️录价输入。每2-3天更新一次。'},
                  {step:'③',title:'AI自动引用',desc:'录价后AI定价引擎自动读取最新竞品价格，在定价页看到影响。点击🔗可快速跳转OTA页面。'}].map((s,i) => (
                  <div key={i} className="bg-white rounded-xl p-4"><p className="text-2xl mb-2">{s.step}</p><p className="font-semibold mb-1">{s.title}</p><p className="text-xs text-slate-400">{s.desc}</p></div>
                ))}
              </div>
            </div>
          )}

          {loading ? <p className="text-center py-8 text-slate-400">加载中...</p> :
           configs.length === 0 ? (
            <div className="text-center py-16"><p className="text-5xl mb-4">🔍</p><p className="text-slate-500 text-lg mb-2">还没有添加竞品酒店</p><Button onClick={() => setShowForm(true)} className="bg-blue-500 text-white">+ 添加第一个竞品</Button></div>
          ) : (
            <>
              <div className="bg-blue-50 rounded-xl px-4 py-2.5 text-xs text-blue-700">
                💡 录价技巧：手机OTA App搜索竞品看价格 → 电脑端点✏️录价输入。或点🔗跳转OTA网页版直接查看。
              </div>
              <div className="grid grid-cols-2 gap-4">
                {configs.map(cfg => (
                  <div key={cfg.id} className="bg-white rounded-3xl border border-slate-200 p-6 shadow-sm hover:shadow-lg transition-all duration-200 hover:-translate-y-0.5">
                    {/* 顶部: 酒店名+平台+链接 */}
                    <div className="flex items-center justify-between mb-4">
                      <div className="flex items-center gap-3 min-w-0 flex-1">
                        <div className="w-11 h-11 rounded-2xl bg-gradient-to-br from-blue-500 to-indigo-500 flex items-center justify-center text-white text-lg shadow-md flex-shrink-0">🏨</div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-2 whitespace-nowrap">
                            <a href={getQuickLink(cfg)} target="_blank" rel="noopener noreferrer" className="font-bold text-base text-slate-800 hover:text-blue-600 transition-colors truncate">{cfg.hotelName}</a>
                            <span className="text-xs px-2 py-0.5 bg-blue-50 text-blue-600 rounded-full font-medium flex-shrink-0">{cfg.platform}</span>
                          </div>
                          <p className="text-xs text-slate-400 truncate mt-0.5">{cfg.competitorRoomType || roomTypes.find(r => r.id === cfg.ourRoomTypeId)?.name || ''}</p>
                        </div>
                      </div>
                    </div>

                    {/* 中部: 价格显示 */}
                    <div className="bg-gradient-to-br from-slate-50 to-slate-100 rounded-2xl p-4 mb-4">
                      {cfg.lastPrice ? (
                        <div className="flex items-baseline justify-center gap-2">
                          <span className="text-sm text-slate-400">当前竞品价</span>
                          <span className="text-4xl font-bold text-slate-800">¥{cfg.lastPrice}</span>
                        </div>
                      ) : (
                        <div className="text-center py-3">
                          <p className="text-amber-500 font-medium">⏳ 待录入价格</p>
                          <p className="text-xs text-slate-400 mt-1">点击下方✏️录价开始追踪</p>
                        </div>
                      )}
                      {cfg.lastCrawledAt && <p className="text-center text-[10px] text-slate-400 mt-2">上次更新: {cfg.lastCrawledAt?.slice(0, 16)}</p>}
                    </div>

                    {/* 底部: 操作按钮 */}
                    <div className="flex gap-2">
                      <button onClick={() => { setEditPriceModal(cfg); setEditPrice(String(cfg.lastPrice || '')); }}
                        className="flex-1 py-2.5 bg-amber-50 text-amber-700 rounded-2xl hover:bg-amber-100 text-sm font-medium transition-colors">
                        ✏️ {cfg.lastPrice ? '更新价格' : '录入价格'}
                      </button>
                      <button onClick={async () => { const s = await apiGet(`/api/competitor-prices/${cfg.id}/history`) as any; setPriceHistory(s?.data || []); setHistoryModal(cfg); }}
                        className="px-4 py-2.5 text-slate-400 hover:text-slate-600 hover:bg-slate-50 rounded-2xl transition-colors text-sm">
                        📈
                      </button>
                      <button onClick={() => setDeleteModal(cfg)}
                        className="px-4 py-2.5 text-slate-300 hover:text-red-500 hover:bg-red-50 rounded-2xl transition-colors text-sm">
                        🗑️
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </>
          )}
        </div>
        <div className="w-[240px] flex-shrink-0 border-l border-slate-200 bg-white/60 p-4 space-y-3">
          <div className="bg-blue-50 rounded-xl p-3"><p className="text-xs font-semibold text-blue-700 mb-2">📖 操作指南</p><div className="space-y-2 text-xs text-blue-600">{[{s:'1',t:'OTA App搜索竞品酒店名'},{s:'2',t:'查看同类型房型价格'},{s:'3',t:'回系统点✏️录价输入'},{s:'4',t:'点🔗快速跳转OTA网页'},{s:'5',t:'定价页AI自动引用'}].map(r=><p key={r.s}><strong>{r.s}.</strong> {r.t}</p>)}</div></div>
          <div className="bg-amber-50 rounded-xl p-3"><p className="text-xs font-semibold text-amber-700 mb-2">💡 录价频率</p><p className="text-xs text-amber-600">每2-3天更新，周末/节假日前必看</p></div>
          {configs.length > 0 && <div className="bg-emerald-50 rounded-xl p-3"><p className="text-xs font-semibold text-emerald-700 mb-2">📊 统计</p><div className="text-xs text-emerald-600 space-y-1"><p>总数: {configs.length}</p><p>有价格: {configs.filter(c=>c.lastPrice).length}</p><p>均价: ¥{configs.filter(c=>c.lastPrice).length>0?Math.round(configs.filter(c=>c.lastPrice).reduce((s,c)=>s+(c.lastPrice||0),0)/configs.filter(c=>c.lastPrice).length):'—'}</p></div></div>}
        </div>
      </div>

      {/* 录价弹窗 — 大尺寸 */}
      {editPriceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setEditPriceModal(null)}>
          <div className="bg-white rounded-2xl w-[480px] p-8 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold mb-2">✏️ 录入价格</h3>
            <div className="flex items-center gap-2 mb-6">
              <span className="text-sm text-slate-500">{editPriceModal.platform} · {editPriceModal.hotelName}</span>
              <a href={getQuickLink(editPriceModal)} target="_blank" rel="noopener noreferrer" className="text-xs text-blue-500 hover:underline">🔗 去查看 →</a>
            </div>
            <div className="bg-amber-50 rounded-xl p-3 mb-5 text-xs text-amber-700">{PLATFORM_INFO[editPriceModal.platform]?.appHint}</div>
            <div className="flex items-center justify-center gap-3 mb-6">
              <span className="text-slate-400 text-xl">¥</span>
              <input autoFocus value={editPrice} onChange={e => setEditPrice(e.target.value)} type="number" placeholder="输入价格"
                className="w-48 px-5 py-4 border border-slate-200 rounded-2xl text-3xl font-bold text-center focus:outline-none focus:ring-2 focus:ring-blue-500/20"
                onKeyDown={e => { if (e.key === 'Enter') { e.currentTarget.blur(); } }} />
            </div>
            <div className="flex gap-3">
              <Button onClick={() => setEditPriceModal(null)} variant="outline" className="flex-1 py-2.5">取消</Button>
              <Button onClick={async () => {
                if (editPrice && !isNaN(Number(editPrice))) {
                  await apiPost('/api/competitor-prices/update-price', { id: editPriceModal.id, price: Number(editPrice) });
                  const d = await apiGet('/api/competitor-prices') as any; setConfigs(d?.data || []);
                }
                setEditPriceModal(null);
              }} className="flex-1 bg-blue-500 text-white py-2.5">保存价格</Button>
            </div>
          </div>
        </div>
      )}

      {/* 价格历史弹窗 — 大尺寸 14天日历 */}
      {historyModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setHistoryModal(null)}>
          <div className="bg-white rounded-2xl w-[640px] max-h-[80vh] overflow-y-auto p-8 shadow-xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-6">
              <div><h3 className="text-xl font-bold">📈 {historyModal.hotelName}</h3><p className="text-sm text-slate-400 mt-1">{historyModal.platform} · {historyModal.competitorRoomType || '价格历史'}</p></div>
              <button onClick={() => setHistoryModal(null)} className="text-slate-400 hover:text-slate-600 text-2xl">×</button>
            </div>
            {priceHistory.length === 0 ? <p className="text-center py-12 text-slate-400">暂无记录，录价后显示</p> : (
              <div>
                <div className="flex items-end gap-2 mb-6 h-40">
                  {priceHistory.slice(0, 14).reverse().map((h: any, i: number) => {
                    const maxPrice = Math.max(...priceHistory.map((p: any) => p.price), 1);
                    const hPct = (h.price / maxPrice) * 100;
                    return (
                      <div key={i} className="flex-1 flex flex-col items-center gap-1 min-w-[30px]">
                        <span className="text-xs font-bold text-slate-700">¥{h.price}</span>
                        <div className="w-full bg-blue-100 rounded-t-lg relative" style={{ height: `${Math.max(hPct, 10)}%`, minHeight: '20px' }}>
                          <div className="absolute bottom-0 left-0 right-0 bg-blue-400 rounded-t-lg" style={{ height: '100%' }} />
                        </div>
                        <span className="text-[10px] text-slate-400">{h.crawledAt?.slice(5, 10)}</span>
                      </div>
                    );
                  })}
                </div>
                <div className="space-y-2">
                  {priceHistory.map((h: any, i: number) => (
                    <div key={i} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                      <div><p className="text-xs text-slate-500">{h.crawledAt?.slice(0, 16)}</p><p className="text-[10px] text-slate-400">{h.source === 'manual' ? '✏️手动' : '🕷️爬取'}</p></div>
                      <div className="text-right flex items-center gap-2">
                        {i > 0 && priceHistory[i-1] && (
                          <span className={`text-xs ${h.price > priceHistory[i-1].price ? 'text-red-500' : h.price < priceHistory[i-1].price ? 'text-emerald-500' : 'text-slate-400'}`}>
                            {h.price > priceHistory[i-1].price ? '↑' : '↓'} {Math.abs(h.price - priceHistory[i-1].price)}
                          </span>
                        )}
                        <p className="text-lg font-bold text-slate-700">¥{h.price}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* 删除确认 */}
      {deleteModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setDeleteModal(null)}>
          <div className="bg-white rounded-2xl w-[420px] p-8 shadow-xl" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold mb-4">🗑️ 删除竞品</h3>
            <p className="text-sm text-slate-500 mb-6">确定要删除 <strong>{deleteModal.hotelName}</strong> 吗？历史价格数据将被清除。</p>
            <div className="flex gap-3">
              <Button onClick={() => setDeleteModal(null)} variant="outline" className="flex-1 py-2.5">取消</Button>
              <Button onClick={async () => {
                await apiPost('/api/competitor-prices/delete', { id: deleteModal.id });
                const d = await apiGet('/api/competitor-prices') as any; setConfigs(d?.data || []);
                setDeleteModal(null);
              }} className="flex-1 bg-red-500 text-white py-2.5 hover:bg-red-600">确认删除</Button>
            </div>
          </div>
        </div>
      )}

      {/* 添加竞品弹窗 */}
      {showForm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30" onClick={() => setShowForm(false)}>
          <div className="bg-white rounded-2xl w-[560px] p-8 shadow-xl max-h-[90vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <h3 className="text-xl font-bold mb-4">添加竞品酒店</h3>
            <div className="bg-blue-50 rounded-xl p-3 mb-5 text-xs text-blue-700">
              <p><strong>💡 提示：</strong>在OTA App搜索同商圈同星级酒店，名称+平台即可。酒店ID和URL可选填，方便后续快速跳转到OTA页面。</p>
            </div>
            <div className="space-y-4">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-500 mb-1.5 block">酒店名称 *</label>
                  <input value={form.hotelName} onChange={e => setForm({...form, hotelName: e.target.value})} placeholder="如：杭州西湖希尔顿" className="w-full px-3 py-2.5 border rounded-xl text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1.5 block">OTA平台 *</label>
                  <select value={form.platform} onChange={e => setForm({...form, platform: e.target.value})} className="w-full px-3 py-2.5 border rounded-xl text-sm">
                    <option value="">选择平台</option>
                    {activeChannels.map(ch => <option key={ch} value={ch}>{ch}</option>)}
                    {activeChannels.length === 0 && ['携程','美团','飞猪','抖音','途家'].map(ch => <option key={ch} value={ch}>{ch}</option>)}
                  </select>
                </div>
              </div>
              {form.platform && (
                <div className="bg-amber-50 rounded-xl p-3 text-xs">
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-amber-700 font-semibold">📱 {form.platform}操作提示：</span>
                    <a href={PLATFORM_INFO[form.platform]?.url} target="_blank" rel="noopener noreferrer" className="text-blue-600 hover:underline">打开{form.platform}网页版 →</a>
                  </div>
                  <p className="text-amber-600">{PLATFORM_INFO[form.platform]?.appHint}</p>
                </div>
              )}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-500 mb-1.5 block">OTA酒店ID（可选）</label>
                  <input value={form.platformHotelId} onChange={e => setForm({...form, platformHotelId: e.target.value})} placeholder="URL中的数字ID" className="w-full px-3 py-2.5 border rounded-xl text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1.5 block">酒店页面URL（可选）</label>
                  <input value={form.platformUrl} onChange={e => setForm({...form, platformUrl: e.target.value})} placeholder="完整网址，方便快速跳转" className="w-full px-3 py-2.5 border rounded-xl text-sm" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs text-slate-500 mb-1.5 block">竞品房型</label>
                  <input value={form.competitorRoomType} onChange={e => setForm({...form, competitorRoomType: e.target.value})} placeholder="如：商务大床房" className="w-full px-3 py-2.5 border rounded-xl text-sm" />
                </div>
                <div>
                  <label className="text-xs text-slate-500 mb-1.5 block">我方对标房型</label>
                  <select value={form.ourRoomTypeId} onChange={e => setForm({...form, ourRoomTypeId: e.target.value})} className="w-full px-3 py-2.5 border rounded-xl text-sm">
                    <option value="">选择房型</option>
                    {roomTypes.map((rt: any) => <option key={rt.id} value={rt.id}>{rt.name}</option>)}
                  </select>
                </div>
              </div>
            </div>
            <div className="flex gap-3 mt-6">
              <Button onClick={() => setShowForm(false)} variant="outline" className="flex-1 py-2.5">取消</Button>
              <Button onClick={handleAdd} className="flex-1 bg-blue-500 text-white py-2.5">添加竞品</Button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
