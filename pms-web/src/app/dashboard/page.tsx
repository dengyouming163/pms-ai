'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import {
  DollarSign,
  BedDouble,
  TrendingUp,
  BarChart3,
  FileCheck,
  MessageSquare,
  AlertTriangle,
  Clock,
  Sparkles,
  ArrowRight,
  CheckCircle2,
  XCircle,
  Calendar,
  Sun,
  Moon,
  CloudSun,
  LogIn,
  LogOut,
  Home,
  DoorOpen,
} from 'lucide-react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import { apiGet } from '@/lib/api-client';
import type { DashboardStats } from '@/lib/api/types';
import { InsightList } from '@/components/ai/insight-list';

const todoIcons: Record<string, typeof FileCheck> = {
  order: FileCheck,
  review: MessageSquare,
  task: AlertTriangle,
  subscription: Clock,
};

const todoColors: Record<string, string> = {
  order: 'bg-blue-50 text-blue-600',
  review: 'bg-amber-50 text-amber-600',
  task: 'bg-red-50 text-red-600',
  subscription: 'bg-slate-50 text-slate-600',
};

const todoBorders: Record<string, string> = {
  order: 'border-l-blue-400',
  review: 'border-l-amber-400',
  task: 'border-l-red-400',
  subscription: 'border-l-slate-400',
};

interface AiSuggestion {
  id: string;
  type: string;
  title: string;
  description: string;
  confidence: number;
  roomType: string;
  currentPrice: number;
  suggestedPrice: number;
  expectedImpact: string;
  status: string;
}

function getGreeting(): { text: string; icon: typeof Sun } {
  const hour = new Date().getHours();
  if (hour < 6) return { text: '夜深了', icon: Moon };
  if (hour < 12) return { text: '早上好', icon: Sun };
  if (hour < 18) return { text: '下午好', icon: CloudSun };
  return { text: '晚上好', icon: Moon };
}

function getToday(): string {
  const d = new Date();
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`;
}

export default function DashboardPage() {
  const [stats, setStats] = useState<DashboardStats | null>(null);
  const [aiSuggestions, setAiSuggestions] = useState<AiSuggestion[]>([]);

  useEffect(() => {
    apiGet('/api/dashboard').then(setStats).catch(() => {});
    // AI 定价建议从 /api/ai/insights 获取（非阻塞，失败不影响页面）
    apiGet('/api/ai/insights').then((data: any) => {
      if (data.insights?.length) setAiSuggestions(data.insights);
    }).catch(() => {});
  }, []);

  if (!stats) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="w-8 h-8 border-4 border-emerald-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  const greeting = getGreeting();

  return (
    <div className="space-y-6">
      <InsightList />
      {/* Hero区域：欢迎+AI提醒 */}
      <div className="bg-gradient-to-br from-emerald-600 via-emerald-500 to-teal-500 rounded-3xl p-7 text-white relative overflow-hidden shadow-lg shadow-emerald-500/20">
        {/* 装饰元素 */}
        <div className="absolute top-0 right-0 w-72 h-72 bg-white/5 rounded-full -translate-y-1/3 translate-x-1/4" />
        <div className="absolute bottom-0 left-1/3 w-48 h-48 bg-white/5 rounded-full translate-y-1/2" />
        <div className="absolute top-1/2 right-1/4 w-24 h-24 bg-white/[0.03] rounded-full" />

        <div className="relative flex items-start justify-between">
          <div className="flex-1">
            <div className="flex items-center gap-3 mb-2">
              <div className="w-11 h-11 bg-white/20 backdrop-blur rounded-xl flex items-center justify-center shadow-inner">
                <greeting.icon className="w-5 h-5" />
              </div>
              <div>
                <h1 className="text-xl font-bold">{greeting.text}，店长</h1>
                <div className="flex items-center gap-2 text-emerald-100 text-sm">
                  <Calendar className="w-3.5 h-3.5" />
                  <span>{getToday()}</span>
                </div>
              </div>
            </div>
            <div className="mt-4 flex items-center gap-3 bg-white/15 backdrop-blur-sm rounded-xl px-4 py-3 max-w-lg border border-white/10">
              <Sparkles className="w-5 h-5 flex-shrink-0" />
              <p className="text-sm">今日预订量低于预期，建议大床房降价5%以提升入住率</p>
            </div>
          </div>
          <Link
            href="/data-center"
            className="px-4 py-2.5 bg-white/20 hover:bg-white/30 backdrop-blur rounded-xl text-sm font-medium transition-colors flex items-center gap-1.5 flex-shrink-0 border border-white/10"
          >
            AI助手 <ArrowRight className="w-4 h-4" />
          </Link>
        </div>
      </div>

      {/* 房态速览：预抵/在住/预离/可售 */}
      <div className="grid grid-cols-4 gap-4">
        {/* 预抵 */}
        <Link href="/rooms?type=daily" className="group bg-white rounded-2xl border border-blue-100 p-5 shadow-sm hover:shadow-lg hover:shadow-blue-500/10 hover:-translate-y-0.5 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-blue-400 to-blue-500" />
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-lg bg-blue-50 flex items-center justify-center border border-blue-100">
                  <LogIn className="w-4 h-4 text-blue-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">预抵</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight mt-2">{stats.expectedArrivals}</div>
              <p className="text-xs text-blue-500 mt-1">今日预计到店</p>
            </div>
            <div className="w-14 h-14 rounded-2xl bg-blue-50/60 flex items-center justify-center">
              <LogIn className="w-7 h-7 text-blue-300" />
            </div>
          </div>
          <div className="absolute bottom-0 right-0 w-20 h-20 bg-blue-50/30 rounded-tl-[3rem] -mb-2 -mr-2" />
        </Link>

        {/* 在住 */}
        <Link href="/rooms?type=daily" className="group bg-white rounded-2xl border border-amber-100 p-5 shadow-sm hover:shadow-lg hover:shadow-amber-500/10 hover:-translate-y-0.5 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-amber-400 to-orange-400" />
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-lg bg-amber-50 flex items-center justify-center border border-amber-100">
                  <Home className="w-4 h-4 text-amber-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">在住</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight mt-2">{stats.inHouse}</div>
              <p className="text-xs text-amber-500 mt-1">当前在住房间</p>
            </div>
            <div className="w-14 h-14 rounded-2xl bg-amber-50/60 flex items-center justify-center">
              <Home className="w-7 h-7 text-amber-300" />
            </div>
          </div>
          <div className="absolute bottom-0 right-0 w-20 h-20 bg-amber-50/30 rounded-tl-[3rem] -mb-2 -mr-2" />
        </Link>

        {/* 预离 */}
        <Link href="/rooms?type=daily" className="group bg-white rounded-2xl border border-violet-100 p-5 shadow-sm hover:shadow-lg hover:shadow-violet-500/10 hover:-translate-y-0.5 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-violet-400 to-violet-500" />
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-lg bg-violet-50 flex items-center justify-center border border-violet-100">
                  <LogOut className="w-4 h-4 text-violet-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">预离</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight mt-2">{stats.expectedDepartures}</div>
              <p className="text-xs text-violet-500 mt-1">今日预计离店</p>
            </div>
            <div className="w-14 h-14 rounded-2xl bg-violet-50/60 flex items-center justify-center">
              <LogOut className="w-7 h-7 text-violet-300" />
            </div>
          </div>
          <div className="absolute bottom-0 right-0 w-20 h-20 bg-violet-50/30 rounded-tl-[3rem] -mb-2 -mr-2" />
        </Link>

        {/* 可售 */}
        <Link href="/rooms?type=daily" className="group bg-white rounded-2xl border border-emerald-100 p-5 shadow-sm hover:shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 transition-all duration-300 relative overflow-hidden">
          <div className="absolute top-0 left-0 right-0 h-0.5 bg-gradient-to-r from-emerald-400 to-teal-400" />
          <div className="flex items-center justify-between">
            <div>
              <div className="flex items-center gap-2 mb-1">
                <div className="w-8 h-8 rounded-lg bg-emerald-50 flex items-center justify-center border border-emerald-100">
                  <DoorOpen className="w-4 h-4 text-emerald-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">可售</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight mt-2">{stats.availableRooms}</div>
              <p className="text-xs text-emerald-500 mt-1">当前可售房间</p>
            </div>
            <div className="w-14 h-14 rounded-2xl bg-emerald-50/60 flex items-center justify-center">
              <DoorOpen className="w-7 h-7 text-emerald-300" />
            </div>
          </div>
          <div className="absolute bottom-0 right-0 w-20 h-20 bg-emerald-50/30 rounded-tl-[3rem] -mb-2 -mr-2" />
        </Link>
      </div>

      {/* KPI卡片 + AI定价建议并排 */}
      <div className="grid grid-cols-3 gap-5">
        {/* 左侧：KPI卡片2x2 */}
        <div className="col-span-2 grid grid-cols-2 gap-4">
          {/* 今日营收 */}
          <div className="relative bg-white rounded-2xl border border-emerald-100 p-5 shadow-sm hover:shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden group">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-emerald-400 to-emerald-600 rounded-l-2xl" />
            <div className="absolute top-3 right-3 opacity-[0.06] group-hover:opacity-[0.1] transition-opacity">
              <DollarSign className="w-20 h-20 text-emerald-600" />
            </div>
            <div className="relative">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-9 h-9 rounded-lg bg-emerald-50 flex items-center justify-center border border-emerald-100">
                  <DollarSign className="w-4 h-4 text-emerald-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">今日营收</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight">¥{stats.todayRevenue.toLocaleString()}</div>
              <div className={`inline-flex items-center gap-1 mt-3 px-2 py-0.5 rounded-full text-xs font-semibold ${stats.revenueChange >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                {stats.revenueChange >= 0 ? '↑' : '↓'} {Math.abs(stats.revenueChange)}%
                <span className="text-slate-400 font-normal ml-0.5">较昨日</span>
              </div>
            </div>
          </div>

          {/* 已售/总房量 */}
          <div className="relative bg-white rounded-2xl border border-sky-100 p-5 shadow-sm hover:shadow-lg hover:shadow-sky-500/10 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden group">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-sky-400 to-sky-600 rounded-l-2xl" />
            <div className="absolute top-3 right-3 opacity-[0.06] group-hover:opacity-[0.1] transition-opacity">
              <BedDouble className="w-20 h-20 text-sky-600" />
            </div>
            <div className="relative">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-9 h-9 rounded-lg bg-sky-50 flex items-center justify-center border border-sky-100">
                  <BedDouble className="w-4 h-4 text-sky-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">已售 / 总房量</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight">{stats.soldRooms}<span className="text-lg font-normal text-slate-300">/{stats.totalRooms}</span></div>
              <div className="mt-3">
                <div className="flex items-center justify-between text-xs mb-1.5">
                  <span className="text-slate-400">入住率</span>
                  <span className="font-bold text-emerald-600">{((stats.soldRooms / stats.totalRooms) * 100).toFixed(0)}%</span>
                </div>
                <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
                  <div className="h-full bg-gradient-to-r from-sky-400 to-emerald-500 rounded-full transition-all duration-500" style={{ width: `${(stats.soldRooms / stats.totalRooms) * 100}%` }} />
                </div>
              </div>
            </div>
          </div>

          {/* 平均房价ADR */}
          <div className="relative bg-white rounded-2xl border border-violet-100 p-5 shadow-sm hover:shadow-lg hover:shadow-violet-500/10 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden group">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-violet-400 to-violet-600 rounded-l-2xl" />
            <div className="absolute top-3 right-3 opacity-[0.06] group-hover:opacity-[0.1] transition-opacity">
              <TrendingUp className="w-20 h-20 text-violet-600" />
            </div>
            <div className="relative">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-9 h-9 rounded-lg bg-violet-50 flex items-center justify-center border border-violet-100">
                  <TrendingUp className="w-4 h-4 text-violet-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">平均房价 ADR</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight">¥{stats.adr}</div>
              <div className={`inline-flex items-center gap-1 mt-3 px-2 py-0.5 rounded-full text-xs font-semibold ${stats.adrChange >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                {stats.adrChange >= 0 ? '↑' : '↓'} {Math.abs(stats.adrChange)}%
                <span className="text-slate-400 font-normal ml-0.5">较昨日</span>
              </div>
            </div>
          </div>

          {/* RevPAR */}
          <div className="relative bg-white rounded-2xl border border-amber-100 p-5 shadow-sm hover:shadow-lg hover:shadow-amber-500/10 hover:-translate-y-0.5 transition-all duration-300 overflow-hidden group">
            <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-b from-amber-400 to-amber-600 rounded-l-2xl" />
            <div className="absolute top-3 right-3 opacity-[0.06] group-hover:opacity-[0.1] transition-opacity">
              <BarChart3 className="w-20 h-20 text-amber-600" />
            </div>
            <div className="relative">
              <div className="flex items-center gap-2 mb-4">
                <div className="w-9 h-9 rounded-lg bg-amber-50 flex items-center justify-center border border-amber-100">
                  <BarChart3 className="w-4 h-4 text-amber-600" />
                </div>
                <span className="text-sm text-slate-500 font-medium">RevPAR</span>
              </div>
              <div className="text-3xl font-bold text-slate-800 tracking-tight">¥{stats.revpar}</div>
              <div className={`inline-flex items-center gap-1 mt-3 px-2 py-0.5 rounded-full text-xs font-semibold ${stats.revparChange >= 0 ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-500'}`}>
                {stats.revparChange >= 0 ? '↑' : '↓'} {Math.abs(stats.revparChange)}%
                <span className="text-slate-400 font-normal ml-0.5">较昨日</span>
              </div>
            </div>
          </div>
        </div>

        {/* 右侧：AI智能定价建议 */}
        <div className="bg-white rounded-2xl p-5 relative overflow-hidden shadow-sm hover:shadow-lg hover:shadow-emerald-500/10 hover:-translate-y-0.5 transition-all duration-300 border border-emerald-100">
          {/* 顶部绿色装饰条 */}
          <div className="absolute top-0 left-0 right-0 h-1 bg-gradient-to-r from-emerald-400 via-emerald-500 to-teal-500" />
          {/* 水印图标 */}
          <div className="absolute top-3 right-3 opacity-[0.04] group-hover:opacity-[0.08] transition-opacity">
            <Sparkles className="w-20 h-20 text-emerald-500" />
          </div>
          <div className="relative">
            <div className="flex items-center justify-between mb-4">
              <div className="flex items-center gap-2">
                <div className="w-9 h-9 rounded-lg bg-gradient-to-br from-emerald-50 to-teal-50 flex items-center justify-center border border-emerald-100">
                  <Sparkles className="w-4 h-4 text-emerald-600" />
                </div>
                <div>
                  <h3 className="font-semibold text-sm text-slate-800">AI智能定价建议</h3>
                  <p className="text-[11px] text-slate-400 mt-0.5">基于市场数据实时分析</p>
                </div>
              </div>
              <Link
                href="/data-center?tab=pricing"
                className="text-xs text-emerald-600 hover:text-emerald-700 transition-colors flex items-center gap-0.5 font-medium"
              >
                更多 <ArrowRight className="w-3 h-3" />
              </Link>
            </div>
            <div className="space-y-2.5">
              {aiSuggestions.slice(0, 3).map((s) => (
                <div key={s.id} className="bg-slate-50/80 rounded-xl p-3 border border-slate-100 hover:border-emerald-200 hover:bg-emerald-50/30 transition-colors">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${s.type === 'price_up' ? 'bg-red-50 text-red-600' : s.type === 'price_down' ? 'bg-emerald-50 text-emerald-600' : 'bg-amber-50 text-amber-600'}`}>
                      {s.type === 'price_up' ? '↑ 涨价' : s.type === 'price_down' ? '↓ 降价' : '⚠ 预警'}
                    </span>
                    <span className="text-xs text-slate-400">置信度 {s.confidence}%</span>
                  </div>
                  <div className="text-xs font-medium mb-1.5 text-slate-700 line-clamp-1">{s.title}</div>
                  {s.currentPrice > 0 && (
                    <div className="flex items-center gap-1.5 text-xs mb-2">
                      <span className="text-slate-400">¥{s.currentPrice}</span>
                      <ArrowRight className="w-3 h-3 text-emerald-400" />
                      <span className="font-bold text-emerald-600">¥{s.suggestedPrice}</span>
                    </div>
                  )}
                  <div className="flex gap-1.5">
                    <button className="px-2.5 py-1 bg-emerald-500 hover:bg-emerald-600 text-white rounded-lg text-xs transition-colors flex items-center gap-0.5 font-medium shadow-sm">
                      <CheckCircle2 className="w-3 h-3" /> 采纳
                    </button>
                    <button className="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-500 rounded-lg text-xs transition-colors flex items-center gap-0.5">
                      <XCircle className="w-3 h-3" /> 忽略
                    </button>
                  </div>
                </div>
              ))}
              {aiSuggestions.length === 0 && (
                <div className="text-center py-8 text-slate-400 text-sm">
                  <Sparkles className="w-8 h-8 mx-auto mb-2 opacity-30" />
                  暂无定价建议
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {/* 经营速报 + 待办事项 */}
      <div className="grid grid-cols-3 gap-5">
        {/* 图表 */}
        <div className="col-span-2 bg-white rounded-2xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow duration-300 overflow-hidden">
          <div className="p-5 pb-3 flex items-center justify-between border-b border-slate-100">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-5 bg-gradient-to-b from-emerald-400 to-teal-500 rounded-full" />
              <h3 className="text-base font-semibold text-slate-800">经营速报</h3>
            </div>
            <span className="text-xs text-slate-400 bg-slate-50 px-2 py-1 rounded-md">近7天</span>
          </div>
          <div className="p-5">
            <ResponsiveContainer width="100%" height={240}>
              <AreaChart data={stats.weeklyTrend}>
                <defs>
                  <linearGradient id="colorOccupancy" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#10b981" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                  <linearGradient id="colorRevpar" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="5%" stopColor="#8b5cf6" stopOpacity={0.25} />
                    <stop offset="95%" stopColor="#8b5cf6" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="date" stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                <YAxis stroke="#94a3b8" fontSize={12} tickLine={false} axisLine={false} />
                <Tooltip
                  contentStyle={{
                    backgroundColor: '#fff',
                    border: '1px solid #e2e8f0',
                    borderRadius: '12px',
                    boxShadow: '0 8px 25px -5px rgba(0,0,0,0.1)',
                  }}
                />
                <Area type="monotone" dataKey="occupancyRate" stroke="#10b981" strokeWidth={2.5} fill="url(#colorOccupancy)" name="入住率(%)" />
                <Area type="monotone" dataKey="revpar" stroke="#8b5cf6" strokeWidth={2.5} fill="url(#colorRevpar)" name="RevPAR" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* 待办事项 */}
        <div className="bg-white rounded-2xl border border-slate-200/80 shadow-sm hover:shadow-md transition-shadow duration-300 p-5">
          <div className="flex items-center justify-between mb-4 border-b border-slate-100 pb-3">
            <div className="flex items-center gap-2">
              <div className="w-1.5 h-5 bg-gradient-to-b from-amber-400 to-orange-500 rounded-full" />
              <h3 className="text-base font-semibold text-slate-800">待办事项</h3>
            </div>
            <span className="text-xs px-2 py-0.5 bg-red-50 text-red-600 rounded-full font-semibold border border-red-100">
              {stats.todos.reduce((sum, t) => sum + t.count, 0)} 项
            </span>
          </div>
          <div className="space-y-2.5">
            {stats.todos.map((todo) => {
              const Icon = todoIcons[todo.type] || FileCheck;
              const color = todoColors[todo.type] || 'bg-slate-50 text-slate-600';
              const border = todoBorders[todo.type] || 'border-l-slate-400';
              return (
                <div key={todo.id} className={`flex items-center gap-3 p-3 bg-slate-50/60 rounded-xl border-l-[3px] ${border} hover:bg-slate-50 hover:shadow-sm transition-all cursor-pointer group`}>
                  <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${color}`}>
                    <Icon className="w-3.5 h-3.5" />
                  </div>
                  <div className="flex-1">
                    <p className="text-sm text-slate-700 font-medium">{todo.title}</p>
                  </div>
                  <span className="text-sm font-bold text-slate-800">{todo.count}</span>
                  <ArrowRight className="w-3.5 h-3.5 text-slate-400 opacity-0 group-hover:opacity-100 transition-opacity" />
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </div>
  );
}
