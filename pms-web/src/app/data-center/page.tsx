'use client';

import { useState, useEffect, useRef, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';
import {
  TrendingUp, BarChart3, Brain, Send, Sparkles, ArrowUpRight, ArrowDownRight,
  DollarSign, Users, BedDouble, Target, CheckCircle2, XCircle, Star,
  ChevronLeft, ChevronRight, AlertTriangle, Lightbulb, Zap, Activity, Shield
} from 'lucide-react';
import {
  ResponsiveContainer, BarChart, Bar, PieChart, Pie, Cell,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Tooltip as RechartsTooltip,
  Legend
} from 'recharts';
import { PageHeader } from '@/components/page-header';
import { TabBar } from '@/components/tab-bar';
import { streamAIChat } from '@/lib/ai/chat-client';
import { apiGet, apiPost } from '@/lib/api-client';
import { ChatMarkdown } from '@/components/ai/chat-markdown';

const COLORS = ['#10b981', '#6366f1', '#f97316', '#ec4899', '#8b5cf6'];

/* ============ 类型定义 ============ */
interface KPI {
  todayRevenue: number; monthRevenue: number; revenueChange: number; monthRevenueChange: number;
  occupancyRate: number; occupancyChange: number; adr: number; adrChange: number;
  revpar: number; revparChange: number; todayCheckins: number; todayCheckouts: number;
  tomorrowReservations: number;
}

interface DashboardData {
  kpi: KPI;
  weekComparison: { thisWeek: { revenue: number; occupancy: number; orders: number }; lastWeek: { revenue: number; occupancy: number; orders: number } };
  revenueTrend: { date: string; revenue: number; cost: number; profit: number }[];
  channelDistribution: { name: string; value: number }[];
  storeComparison: { name: string; revenue: number; occupancy: number; adr: number; revpar: number }[];
  roomTypeRanking: { name: string; revenue: number }[];
  occupancyTrend: { month: string; rate: number; adr: number; revpar: number }[];
}

interface RevenueData {
  aiSuggestions: { id: string; type: string; title: string; description: string; currentPrice: number; suggestedPrice: number; confidence: number }[];
  pricingCalendar: { date: string; currentPrice: number; suggestedPrice: number; isWeekend: boolean; isHoliday: boolean; occupancy: number }[];
  competitorMonitor: { name: string; platform: string; rating: number; distance: string; todayPrice: number; priceDiff: number; occupancy: number }[];
  priceHistory: { date: string; roomType: string; before: number; after: number; reason: string; result: string }[];
}

interface ChannelPricing {
  id: string; channelName: string; channelIcon: string; status: 'connected' | 'disconnected' | 'syncing';
  commissionRate: number; adjustType: 'fixed' | 'percentage'; adjustValue: number; autoSync: boolean;
  priceMatrix: Record<string, number>;
  todayOrders: number; monthOrders: number; syncInterval: string; lastSync: string; roomTypes: string[];
}

interface AiPricingData {
  suggestions: { id: string; roomType: string; currentPrice: number; suggestedPrice: number; reason: string; confidence: number; status: string }[];
  channelPricing: ChannelPricing[];
  history: { id: string; date: string; roomType: string; before: number; after: number; reason: string; operator: string }[];
}

interface ChatMessage { role: 'user' | 'assistant'; content: string; }

/* ============ 主页面 ============ */
import { Suspense } from 'react';

function DataCenterContent() {
  const searchParams = useSearchParams();
  const [activeTab, setActiveTab] = useState('dashboard');
  const [dashboardData, setDashboardData] = useState<DashboardData | null>(null);
  const [revenueData, setRevenueData] = useState<RevenueData | null>(null);
  const [aiPricing, setAiPricing] = useState<AiPricingData>({ suggestions: [], channelPricing: [], history: [] });
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'assistant', content: '你好！我是你的AI经营助手，可以帮你分析经营数据、提供定价建议、回答运营问题。请问有什么可以帮你的？' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [isStreaming, setIsStreaming] = useState(false);
  const chatEndRef = useRef<HTMLDivElement | null>(null);

  const tabs = [
    { key: 'dashboard', label: '经营概览' },
    { key: 'pricing', label: 'AI定价' },
    { key: 'analysis', label: 'AI分析' },
    { key: 'chat', label: 'AI对话' },
  ];

  useEffect(() => {
    const tab = searchParams.get('tab');
    if (tab && tabs.some(t => t.key === tab)) setActiveTab(tab);
  }, [searchParams]);

  useEffect(() => {
    apiGet('/api/data-center?type=dashboard').then(d => {
      setDashboardData(d);
    }).catch(() => {});
    apiGet('/api/data-center?type=revenue').then(d => {
      setRevenueData(d);
    }).catch(() => {});
    apiGet('/api/data-center?type=diagnosis').then(() => {
    }).catch(() => {});
    apiGet('/api/pricing?type=ai').then(d => {
      setAiPricing({ suggestions: d.suggestions || [], channelPricing: d.channelPricing || [], history: d.history || [] });
    }).catch(() => {});
  }, []);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [chatMessages]);

  const handleChatSend = async () => {
    if (!chatInput.trim() || isStreaming) return;
    const userMsg = chatInput.trim();
    setChatInput('');
    const newMessages = [...chatMessages, { role: 'user' as const, content: userMsg }];
    setChatMessages(newMessages);
    setIsStreaming(true);
    setChatMessages(prev => [...prev, { role: 'assistant', content: '⏳ 正在思考...' }]);

    try {
      const history = newMessages.map(m => ({ role: m.role, content: m.content }));
      await streamAIChat(userMsg, history, {
        onAgentStart: (_agent: string, action: string) => {
          setChatMessages(prev => { const m = [...prev]; m[m.length - 1] = { role: 'assistant', content: `⏳ ${action}` }; return m; });
        },
        onToken: (text: string) => {
          setChatMessages(prev => { const m = [...prev]; m[m.length - 1] = { role: 'assistant', content: prev[prev.length - 1].content + text }; return m; });
        },
        onDone: (summary: string) => {
          setChatMessages(prev => { const m = [...prev]; m[m.length - 1] = { role: 'assistant', content: summary }; return m; });
        },
        onError: () => {
          setChatMessages(prev => { const m = [...prev]; m[m.length - 1] = { role: 'assistant', content: '抱歉，请求失败，请重试。' }; return m; });
        },
      });
    } catch {
      setChatMessages(prev => { const m = [...prev]; m[m.length - 1] = { role: 'assistant', content: '抱歉，请求失败，请重试。' }; return m; });
    }
    setIsStreaming(false);
  };

  const refreshAiPricing = () => {
    apiGet('/api/pricing?type=ai').then(d => {
      setAiPricing({ suggestions: d.suggestions || [], channelPricing: d.channelPricing || [], history: d.history || [] });
    }).catch(() => {});
  };

  const handleAdopt = async (id: string) => {
    // Optimistic update
    setAiPricing(prev => ({
      ...prev,
      suggestions: prev.suggestions.map(s => s.id === id ? { ...s, status: 'adopted' } : s),
    }));
    try {
      await apiPost('/api/pricing', { action: 'adoptSuggestion', suggestionId: id });
      // Refresh from server to get updated history
      refreshAiPricing();
    } catch {
      // Revert on failure
      setAiPricing(prev => ({
        ...prev,
        suggestions: prev.suggestions.map(s => s.id === id ? { ...s, status: 'pending' } : s),
      }));
    }
  };

  const handleIgnore = async (id: string) => {
    // Optimistic update
    setAiPricing(prev => ({
      ...prev,
      suggestions: prev.suggestions.map(s => s.id === id ? { ...s, status: 'ignored' } : s),
    }));
    try {
      await apiPost('/api/pricing', { action: 'ignoreSuggestion', suggestionId: id });
      // Refresh from server
      refreshAiPricing();
    } catch {
      // Revert on failure
      setAiPricing(prev => ({
        ...prev,
        suggestions: prev.suggestions.map(s => s.id === id ? { ...s, status: 'pending' } : s),
      }));
    }
  };

  const pendingCount = aiPricing.suggestions.filter(s => s.status === 'pending').length;
  const adoptedCount = aiPricing.suggestions.filter(s => s.status === 'adopted').length;

  return (
    <div className="space-y-5">
      <PageHeader title="AI助手" subtitle="数据驱动决策，AI赋能经营" icon={<Brain className="w-5 h-5" />} />
      <div className="flex items-center justify-between">
        <TabBar tabs={tabs} activeKey={activeTab} onChange={setActiveTab} />
      </div>

      {activeTab === 'dashboard' && dashboardData && <DashboardTab data={dashboardData} />}
      {activeTab === 'pricing' && (
        <PricingTab
          suggestions={aiPricing.suggestions}
          channelPricing={aiPricing.channelPricing}
          history={aiPricing.history}
          pendingCount={pendingCount}
          adoptedCount={adoptedCount}
          onAdopt={handleAdopt}
          onIgnore={handleIgnore}
        />
      )}
      {activeTab === 'analysis' && revenueData && <AnalysisTab data={revenueData} />}
      {activeTab === 'chat' && (
        <ChatTab messages={chatMessages} input={chatInput} setInput={setChatInput} onSend={handleChatSend} isStreaming={isStreaming} chatEndRef={chatEndRef} />
      )}
    </div>
  );
}

/* ============ 经营概览 ============ */
function DashboardTab({ data }: { data: DashboardData }) {
  const { kpi, weekComparison: wc } = data;
  const kpiCards = [
    { label: '今日营收', value: `¥${kpi.todayRevenue.toLocaleString()}`, change: kpi.revenueChange, icon: DollarSign, color: 'emerald' },
    { label: '月度营收', value: `¥${kpi.monthRevenue.toLocaleString()}`, change: kpi.monthRevenueChange, icon: TrendingUp, color: 'teal' },
    { label: '出租率', value: `${kpi.occupancyRate}%`, change: kpi.occupancyChange, icon: BedDouble, color: 'blue' },
    { label: 'ADR', value: `¥${kpi.adr}`, change: kpi.adrChange, icon: BarChart3, color: 'violet' },
    { label: 'RevPAR', value: `¥${kpi.revpar}`, change: kpi.revparChange, icon: Target, color: 'amber' },
    { label: '今日入住/退房', value: `${kpi.todayCheckins}/${kpi.todayCheckouts}`, change: 0, icon: Users, color: 'rose', suffix: `明预${kpi.tomorrowReservations}` },
  ];

  const colorMap: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600', teal: 'bg-teal-50 text-teal-600',
    blue: 'bg-blue-50 text-blue-600', violet: 'bg-violet-50 text-violet-600',
    amber: 'bg-amber-50 text-amber-600', rose: 'bg-rose-50 text-rose-600',
  };

  return (
    <div className="space-y-5">
      <div className="grid grid-cols-3 lg:grid-cols-6 gap-4">
        {kpiCards.map((card) => (
          <div key={card.label} className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-500">{card.label}</span>
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${colorMap[card.color]}`}>
                <card.icon className="w-3.5 h-3.5" />
              </div>
            </div>
            <div className="text-xl font-bold text-slate-800">{card.value}</div>
            {card.change !== 0 && (
              <div className={`flex items-center gap-1 text-xs mt-1 ${card.change > 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                {card.change > 0 ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {Math.abs(card.change)}%
              </div>
            )}
            {card.suffix && <div className="text-xs text-slate-400 mt-1">{card.suffix}</div>}
          </div>
        ))}
      </div>

      <div className="grid grid-cols-3 gap-4">
        {[
          { label: '本周营收', current: wc.thisWeek.revenue, prev: wc.lastWeek.revenue, prefix: '¥' },
          { label: '本周出租率', current: wc.thisWeek.occupancy, prev: wc.lastWeek.occupancy, suffix: '%' },
          { label: '本周订单', current: wc.thisWeek.orders, prev: wc.lastWeek.orders },
        ].map((item) => {
          const change = ((item.current - item.prev) / item.prev * 100).toFixed(1);
          const isUp = Number(change) > 0;
          return (
            <div key={item.label} className="bg-white rounded-2xl p-4 shadow-sm border border-slate-100">
              <div className="text-xs text-slate-500 mb-1">{item.label}</div>
              <div className="text-lg font-bold text-slate-800">{item.prefix}{item.current.toLocaleString()}{item.suffix}</div>
              <div className={`text-xs mt-1 ${isUp ? 'text-emerald-500' : 'text-red-500'}`}>
                环比{isUp ? '↑' : '↓'}{Math.abs(Number(change))}%
                <span className="text-slate-400 ml-1">上周{item.prefix}{item.prev.toLocaleString()}{item.suffix}</span>
              </div>
            </div>
          );
        })}
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">近7天收支趋势</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.revenueTrend}>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis dataKey="date" tick={{ fontSize: 12 }} />
              <YAxis tick={{ fontSize: 12 }} />
              <RechartsTooltip />
              <Bar dataKey="revenue" name="收入" fill="#10b981" radius={[4, 4, 0, 0]} />
              <Bar dataKey="cost" name="支出" fill="#f97316" radius={[4, 4, 0, 0]} />
              <Bar dataKey="profit" name="利润" fill="#6366f1" radius={[4, 4, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>

        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">渠道收入分布</h3>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie data={data.channelDistribution} cx="50%" cy="50%" innerRadius={55} outerRadius={85} dataKey="value" label={({ name, value }) => `${name} ${value}%`}>
                {data.channelDistribution.map((_, i) => <Cell key={i} fill={COLORS[i % COLORS.length]} />)}
              </Pie>
              <RechartsTooltip />
            </PieChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-5">
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">门店经营对比</h3>
          <div className="space-y-3">
            {data.storeComparison.map((s) => (
              <div key={s.name} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                <div>
                  <div className="font-medium text-sm text-slate-800">{s.name}</div>
                  <div className="text-xs text-slate-500 mt-0.5">ADR ¥{s.adr} · RevPAR ¥{s.revpar}</div>
                </div>
                <div className="text-right">
                  <div className="font-bold text-sm text-emerald-600">¥{s.revenue.toLocaleString()}</div>
                  <div className="text-xs text-slate-500">出租率 {s.occupancy}%</div>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">房型收入排行</h3>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.roomTypeRanking} layout="vertical">
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis type="number" tick={{ fontSize: 12 }} />
              <YAxis dataKey="name" type="category" tick={{ fontSize: 12 }} width={80} />
              <RechartsTooltip />
              <Bar dataKey="revenue" name="收入" fill="#10b981" radius={[0, 4, 4, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">月度经营趋势</h3>
        <ResponsiveContainer width="100%" height={240}>
          <LineChart data={data.occupancyTrend}>
            <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
            <XAxis dataKey="month" tick={{ fontSize: 12 }} />
            <YAxis tick={{ fontSize: 12 }} />
            <RechartsTooltip />
            <Legend />
            <Line type="monotone" dataKey="rate" name="出租率%" stroke="#10b981" strokeWidth={2} dot={{ fill: '#10b981' }} />
            <Line type="monotone" dataKey="adr" name="ADR" stroke="#6366f1" strokeWidth={2} dot={{ fill: '#6366f1' }} />
            <Line type="monotone" dataKey="revpar" name="RevPAR" stroke="#f97316" strokeWidth={2} dot={{ fill: '#f97316' }} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

/* ============ AI定价（操作中心） ============ */
function PricingTab({ suggestions, channelPricing, history, pendingCount, adoptedCount, onAdopt, onIgnore }: {
  suggestions: AiPricingData['suggestions'];
  channelPricing: ChannelPricing[];
  history: AiPricingData['history'];
  pendingCount: number;
  adoptedCount: number;
  onAdopt: (id: string) => void;
  onIgnore: (id: string) => void;
}) {
  const upCount = suggestions.filter(s => s.status === 'pending' && s.suggestedPrice > s.currentPrice).length;
  const downCount = suggestions.filter(s => s.status === 'pending' && s.suggestedPrice < s.currentPrice).length;

  return (
    <div className="space-y-5">
      {/* 统计卡片 */}
      <div className="grid grid-cols-4 gap-4">
        {[
          { label: '待处理建议', value: pendingCount, icon: AlertTriangle, color: 'bg-orange-50 text-orange-600', border: 'border-l-4 border-l-orange-400' },
          { label: '建议涨价', value: upCount, icon: ArrowUpRight, color: 'bg-red-50 text-red-600', border: 'border-l-4 border-l-red-400' },
          { label: '建议降价', value: downCount, icon: ArrowDownRight, color: 'bg-blue-50 text-blue-600', border: 'border-l-4 border-l-blue-400' },
          { label: '近7日已采纳', value: adoptedCount, icon: CheckCircle2, color: 'bg-emerald-50 text-emerald-600', border: 'border-l-4 border-l-emerald-400' },
        ].map(card => (
          <div key={card.label} className={`bg-white rounded-2xl p-4 shadow-sm border border-slate-100 ${card.border}`}>
            <div className="flex items-center justify-between mb-2">
              <span className="text-xs text-slate-500">{card.label}</span>
              <div className={`w-7 h-7 rounded-lg flex items-center justify-center ${card.color}`}>
                <card.icon className="w-3.5 h-3.5" />
              </div>
            </div>
            <div className="text-2xl font-bold text-slate-800">{card.value}</div>
          </div>
        ))}
      </div>

      {/* AI调价建议 */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2">
            <Sparkles className="w-5 h-5 text-violet-500" /> AI调价建议
          </h3>
          {pendingCount > 0 && <span className="text-xs px-2.5 py-1 bg-orange-50 text-orange-600 rounded-full">{pendingCount}条待处理</span>}
        </div>
        <div className="space-y-3">
          {suggestions.map(s => {
            const isUp = s.suggestedPrice > s.currentPrice;
            const diff = s.suggestedPrice - s.currentPrice;
            const isPending = s.status === 'pending';
            return (
              <div key={s.id} className={`p-4 rounded-xl border ${isPending ? 'border-slate-200 bg-slate-50' : s.status === 'adopted' ? 'border-emerald-200 bg-emerald-50' : 'border-slate-100 bg-slate-50 opacity-60'}`}>
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1">
                    <div className="flex items-center gap-2 mb-1">
                      <span className="font-medium text-sm text-slate-800">{s.roomType}</span>
                      <span className={`text-xs px-2 py-0.5 rounded-full ${isUp ? 'bg-red-50 text-red-600' : 'bg-blue-50 text-blue-600'}`}>
                        {isUp ? '↑ 涨价' : '↓ 降价'}
                      </span>
                      <span className="text-xs text-slate-400">置信度 {s.confidence > 1 ? s.confidence : Math.round(s.confidence * 100)}%</span>
                    </div>
                    <div className="flex items-center gap-3 mb-2">
                      <span className="text-sm text-slate-500">当前 <span className="font-bold text-slate-700">¥{s.currentPrice}</span></span>
                      <span className="text-slate-300">→</span>
                      <span className={`text-sm font-bold ${isUp ? 'text-red-600' : 'text-blue-600'}`}>¥{s.suggestedPrice}</span>
                      <span className={`text-xs ${isUp ? 'text-red-500' : 'text-blue-500'}`}>
                        {diff > 0 ? '+' : ''}¥{diff}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500">{s.reason}</p>
                  </div>
                  {isPending && (
                    <div className="flex gap-2 flex-shrink-0">
                      <button onClick={() => onAdopt(s.id)} className="px-3 py-1.5 bg-emerald-600 text-white rounded-lg text-xs font-medium hover:bg-emerald-700 transition-colors flex items-center gap-1">
                        <CheckCircle2 className="w-3 h-3" /> 采纳
                      </button>
                      <button onClick={() => onIgnore(s.id)} className="px-3 py-1.5 bg-slate-100 text-slate-600 rounded-lg text-xs font-medium hover:bg-slate-200 transition-colors flex items-center gap-1">
                        <XCircle className="w-3 h-3" /> 忽略
                      </button>
                    </div>
                  )}
                  {s.status === 'adopted' && (
                    <span className="text-xs px-2.5 py-1 bg-emerald-100 text-emerald-600 rounded-full flex items-center gap-1 flex-shrink-0"><CheckCircle2 className="w-3 h-3" /> 已采纳</span>
                  )}
                  {s.status === 'ignored' && (
                    <span className="text-xs px-2.5 py-1 bg-slate-100 text-slate-500 rounded-full flex-shrink-0">已忽略</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* 渠道定价参考 */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2 mb-4">
          <Shield className="w-5 h-5 text-blue-500" /> 渠道定价参考
        </h3>
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {channelPricing.map(c => (
            <div key={c.id} className="p-4 rounded-xl border border-blue-100 bg-blue-50/30">
              <div className="flex items-center justify-between mb-3">
                <div className="flex items-center gap-2">
                  <span className="text-lg">{c.channelIcon}</span>
                  <span className="font-medium text-sm text-slate-800">{c.channelName}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full ${c.status === 'connected' ? 'bg-emerald-100 text-emerald-600' : c.status === 'syncing' ? 'bg-amber-100 text-amber-600' : 'bg-slate-100 text-slate-500'}`}>
                    {c.status === 'connected' ? '已连接' : c.status === 'syncing' ? '同步中' : '未连接'}
                  </span>
                </div>
                <span className="text-xs text-slate-400">佣金 {c.commissionRate}%</span>
              </div>
              <div className="space-y-2">
                {Object.entries(c.priceMatrix).map(([rt, channelPrice]) => (
                  <div key={rt} className="flex items-center justify-between text-sm">
                    <span className="text-slate-600">{rt}</span>
                    <span className="font-bold text-emerald-600">¥{channelPrice}</span>
                  </div>
                ))}
              </div>
              <div className="mt-2 flex items-center justify-between text-xs text-slate-400">
                <span>订单 {c.todayOrders}/{c.monthOrders}</span>
                <span>适用: {c.roomTypes.join('、')}</span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* 近期调价记录 */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <h3 className="text-base font-semibold text-slate-800 flex items-center gap-2 mb-4">
          <Activity className="w-5 h-5 text-amber-500" /> 近期调价记录
        </h3>
        <div className="space-y-2">
          {history.map(h => (
            <div key={h.id} className="flex items-center gap-4 p-3 bg-slate-50 rounded-xl text-sm">
              <span className="text-xs text-slate-400 w-20 flex-shrink-0">{h.date}</span>
              <span className="font-medium text-slate-700 w-24 flex-shrink-0">{h.roomType}</span>
              <div className="flex items-center gap-2">
                <span className="text-slate-500">¥{h.before}</span>
                <span className="text-slate-300">→</span>
                <span className="font-bold text-emerald-600">¥{h.after}</span>
              </div>
              <span className="text-xs text-slate-500 flex-1">{h.reason}</span>
              <span className="text-xs text-slate-400">{h.operator}</span>
            </div>
          ))}
        </div>
      </div>

      {/* 定价说明 */}
      <div className="bg-gradient-to-r from-amber-50 to-orange-50 rounded-2xl border border-amber-100 p-5">
        <h3 className="text-base font-semibold text-amber-800 flex items-center gap-2 mb-3">
          <AlertTriangle className="w-5 h-5" /> AI定价说明
        </h3>
        <ul className="space-y-2 text-sm text-amber-700">
          <li className="flex items-start gap-2"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" /> AI建议基于市场行情、竞品价格、历史入住率等数据综合分析生成</li>
          <li className="flex items-start gap-2"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" /> 置信度越高表示建议越可靠，建议优先处理高置信度建议</li>
          <li className="flex items-start gap-2"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" /> 采纳建议后将自动更新价格日历中的对应价格</li>
          <li className="flex items-start gap-2"><span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-amber-400 flex-shrink-0" /> 价格调整可能影响渠道排名和曝光量，请谨慎评估</li>
        </ul>
      </div>
    </div>
  );
}

/* ============ AI分析（经营洞察） ============ */
function AnalysisTab({ data }: { data: RevenueData }) {
  const nowDate = new Date();
  const [calendarMonth, setCalendarMonth] = useState(nowDate.getMonth() + 1);

  const insights = useMemo(() => [
    { icon: TrendingUp, color: 'emerald', title: '入住率趋势', desc: `本周出租率${data.pricingCalendar.filter(d => d.occupancy > 70).length > 10 ? '整体偏高' : '有提升空间'}，周末入住率达${Math.max(...data.pricingCalendar.map(d => d.occupancy))}%`, tag: '数据洞察' },
    { icon: Lightbulb, color: 'amber', title: '定价优化机会', desc: `${data.competitorMonitor.filter(c => c.priceDiff > 0).length}个竞品价格低于我们，建议关注竞品动态调整策略`, tag: '策略建议' },
    { icon: Zap, color: 'violet', title: '收益提升空间', desc: '工作日入住率偏低，建议推出工作日特价或连住优惠提升入住率', tag: '收益优化' },
    { icon: Star, color: 'blue', title: '渠道表现分析', desc: '携程渠道订单占比最高，建议重点维护；直营渠道利润率最优', tag: '渠道洞察' },
  ], [data]);

  const colorMap: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600', amber: 'bg-amber-50 text-amber-600',
    violet: 'bg-violet-50 text-violet-600', blue: 'bg-blue-50 text-blue-600',
  };

  return (
    <div className="space-y-5">
      {/* AI洞察卡片 */}
      <div className="grid grid-cols-2 gap-4">
        {insights.map(item => (
          <div key={item.title} className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
            <div className="flex items-center gap-3 mb-3">
              <div className={`w-9 h-9 rounded-xl flex items-center justify-center ${colorMap[item.color]}`}>
                <item.icon className="w-4.5 h-4.5" />
              </div>
              <div>
                <div className="font-medium text-sm text-slate-800">{item.title}</div>
                <span className="text-xs text-slate-400">{item.tag}</span>
              </div>
            </div>
            <p className="text-sm text-slate-600 leading-relaxed">{item.desc}</p>
          </div>
        ))}
      </div>

      <div className="grid grid-cols-2 gap-5">
        {/* AI定价日历 */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-semibold text-slate-700">AI定价日历</h3>
            <div className="flex items-center gap-2">
              <button onClick={() => setCalendarMonth(Math.max(1, calendarMonth - 1))} className="p-1 hover:bg-slate-100 rounded"><ChevronLeft className="w-4 h-4" /></button>
              <span className="text-sm text-slate-600">{nowDate.getFullYear()}年{calendarMonth}月</span>
              <button onClick={() => setCalendarMonth(Math.min(12, calendarMonth + 1))} className="p-1 hover:bg-slate-100 rounded"><ChevronRight className="w-4 h-4" /></button>
            </div>
          </div>
          <div className="grid grid-cols-7 gap-1 text-center text-xs">
            {['一', '二', '三', '四', '五', '六', '日'].map(d => <div key={d} className="text-slate-400 py-1">{d}</div>)}
            {data.pricingCalendar.slice(0, 28).map((d) => {
              const day = new Date(d.date).getDate();
              const isOverpriced = d.currentPrice > d.suggestedPrice;
              const isUnderpriced = d.currentPrice < d.suggestedPrice;
              return (
                <div key={d.date} className={`p-1.5 rounded-lg text-xs ${d.isHoliday ? 'bg-red-50' : d.isWeekend ? 'bg-amber-50' : 'bg-slate-50'}`}>
                  <div className={`font-medium ${d.isWeekend ? 'text-red-500' : 'text-slate-700'}`}>{day}</div>
                  <div className={`font-bold ${isOverpriced ? 'text-red-500' : isUnderpriced ? 'text-blue-500' : 'text-emerald-600'}`}>¥{d.currentPrice}</div>
                  <div className="text-slate-400 text-[10px]">建议¥{d.suggestedPrice}</div>
                  <div className="text-slate-400 text-[10px]">{d.occupancy}%</div>
                </div>
              );
            })}
          </div>
          <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-red-500" /> 高于建议价</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-blue-500" /> 低于建议价</span>
            <span className="flex items-center gap-1"><span className="w-2 h-2 rounded-full bg-emerald-500" /> 合理区间</span>
          </div>
        </div>

        {/* 竞品监控 */}
        <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">竞品价格监控</h3>
          <div className="space-y-3">
            {data.competitorMonitor.map((c) => (
              <div key={c.name} className="flex items-center justify-between p-3 bg-slate-50 rounded-xl">
                <div>
                  <div className="flex items-center gap-2">
                    <span className="font-medium text-sm text-slate-800">{c.name}</span>
                    <span className="text-xs text-slate-400">{c.distance}</span>
                  </div>
                  <div className="flex items-center gap-2 mt-1">
                    <span className="text-xs text-slate-500">{c.platform}</span>
                    <span className="text-xs text-amber-500 flex items-center gap-0.5"><Star className="w-3 h-3" />{c.rating}</span>
                    <span className="text-xs text-slate-500">入住率{c.occupancy}%</span>
                  </div>
                </div>
                <div className="text-right">
                  <div className="text-sm font-bold text-slate-800">¥{c.todayPrice}</div>
                  <div className={`text-xs ${c.priceDiff > 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                    {c.priceDiff > 0 ? '我们贵' : '我们便宜'} ¥{Math.abs(c.priceDiff)}
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 调价效果分析 */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-slate-100">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">历史调价效果</h3>
        <div className="space-y-3">
          {data.priceHistory.map((h, i) => (
            <div key={i} className="flex items-center gap-4 p-3 bg-slate-50 rounded-xl">
              <div className="text-xs text-slate-400 w-20">{h.date}</div>
              <div className="text-sm font-medium text-slate-700 w-20">{h.roomType}</div>
              <div className="flex items-center gap-2 text-sm">
                <span className="text-red-500">¥{h.before}</span>
                <ArrowUpRight className="w-3 h-3 text-slate-400" />
                <span className="text-emerald-600 font-bold">¥{h.after}</span>
              </div>
              <div className="text-xs text-slate-500 flex-1">{h.reason}</div>
              <div className="text-xs text-emerald-600 font-medium">{h.result}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export default function DataCenterPage() {
  return (
    <Suspense>
      <DataCenterContent />
    </Suspense>
  );
}

/* ============ AI对话助手 ============ */
function ChatTab({ messages, input, setInput, onSend, isStreaming, chatEndRef }: {
  messages: ChatMessage[];
  input: string;
  setInput: (v: string) => void;
  onSend: () => void;
  isStreaming: boolean;
  chatEndRef: React.RefObject<HTMLDivElement | null>;
}) {
  const quickQuestions = [
    '本周入住率趋势如何？',
    '周末价格应该怎么调？',
    '携程渠道表现怎么样？',
    '提升RevPAR的建议？',
    '近期差评主要问题是什么？',
    '工作日入住率怎么提升？',
  ];

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-100 flex flex-col" style={{ height: 'calc(100vh - 260px)', minHeight: 500 }}>
      <div className="flex-1 overflow-y-auto p-5 space-y-4">
        {messages.map((msg, i) => (
          <div key={i} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
            <div className={`max-w-[80%] ${msg.role === 'user'
              ? 'bg-emerald-600 text-white rounded-2xl rounded-br-md'
              : 'bg-slate-100 text-slate-800 rounded-2xl rounded-bl-md'
            } px-4 py-3`}>
              {msg.role === 'assistant' && i === 0 && <Brain className="w-4 h-4 text-emerald-500 mb-2" />}
              {msg.role === 'assistant'
                ? <ChatMarkdown content={msg.content} />
                : <div className="text-sm whitespace-pre-wrap leading-relaxed">{msg.content}</div>
              }
              {isStreaming && i === messages.length - 1 && msg.role === 'assistant' && (
                <span className="inline-block w-1.5 h-4 bg-emerald-500 animate-pulse ml-0.5" />
              )}
            </div>
          </div>
        ))}
        <div ref={chatEndRef} />
      </div>

      {messages.length <= 2 && (
        <div className="px-5 pb-3">
          <div className="flex flex-wrap gap-2">
            {quickQuestions.map((q) => (
              <button key={q} onClick={() => { setInput(q); }} className="text-xs px-3 py-1.5 bg-emerald-50 text-emerald-700 rounded-full hover:bg-emerald-100 transition-colors">
                {q}
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="border-t border-slate-100 p-4">
        <div className="flex items-center gap-3">
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); onSend(); } }}
            placeholder="输入你的问题，如：本周入住率怎么样？"
            className="flex-1 px-4 py-2.5 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-emerald-500/20 focus:border-emerald-500"
            disabled={isStreaming}
          />
          <button
            onClick={onSend}
            disabled={!input.trim() || isStreaming}
            className="px-4 py-2.5 bg-emerald-600 text-white rounded-xl text-sm font-medium hover:bg-emerald-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
          >
            <Send className="w-3.5 h-3.5" />
            发送
          </button>
        </div>
      </div>
    </div>
  );
}
