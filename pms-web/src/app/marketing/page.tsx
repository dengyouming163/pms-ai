'use client';

import { useEffect, useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { PageHeader } from '@/components/page-header';
import { StatusBadge } from '@/components/status-badge';
import { StatCardSkeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { Gift, Percent, TrendingUp, CalendarDays, Users, Zap, Plus, ArrowRight } from 'lucide-react';
import { apiGet } from '@/lib/api-client';

interface Promotion {
  id: string;
  name: string;
  type: string;
  description: string;
  discount: string;
  discountValue: number;
  discountUnit: string;
  condition: string;
  roomTypes: string[];
  validFrom: string;
  validTo: string;
  usageCount: number;
  usageLimit: number;
  status: string;
}

const typeLabels: Record<string, string> = {
  early_bird: '早鸟优惠',
  long_stay: '长住特惠',
  last_minute: '尾房促销',
  seasonal: '季节特价',
  member: '会员专享',
};

function StatCard({ icon, label, value, colorClass }: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
  colorClass: string;
}) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-6">
      <div className="flex items-center gap-3">
        <div className={`p-2.5 rounded-xl ${colorClass}`}>
          {icon}
        </div>
        <div>
          <p className="text-2xl font-bold text-slate-800">{value}</p>
          <p className="text-sm text-slate-500">{label}</p>
        </div>
      </div>
    </div>
  );
}

export default function MarketingPage() {
  const router = useRouter();
  const [promotions, setPromotions] = useState<Promotion[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    fetchPromotions();
  }, []);

  async function fetchPromotions() {
    try {
      const data = await apiGet('/api/pricing?type=promotions');
      setPromotions(data.promotions || []);
    } catch {
      setError('加载促销数据失败');
    } finally {
      setLoading(false);
    }
  }

  const activeList = promotions.filter(p => p.status === 'active');
  const stats = {
    total: promotions.length,
    active: activeList.length,
    totalUsed: promotions.reduce((s, p) => s + (p.usageCount || 0), 0),
    avgDiscount: activeList.length > 0
      ? Math.round(activeList.reduce((s, p) => s + p.discountValue, 0) / activeList.length)
      : 0,
  };

  if (error) {
    return (
      <div className="space-y-6">
        <PageHeader title="营销中心" subtitle="管理促销活动和营销策略" />
        <div className="rounded-xl border border-red-200 bg-red-50 p-8 text-center">
          <p className="text-red-600">{error}</p>
          <button
            onClick={fetchPromotions}
            className="mt-4 px-4 py-2 text-sm font-medium rounded-lg border border-slate-200 bg-white hover:bg-slate-50"
          >
            重试
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="营销中心"
        subtitle="管理促销活动和营销策略"
        action={{
          label: '创建促销',
          onClick: () => router.push('/pricing?tab=promotions'),
          icon: <Plus className="w-4 h-4" />,
          variant: 'primary',
        }}
      />

      {/* 数据概览 */}
      <div className="grid grid-cols-4 gap-4">
        {loading ? (
          <>
            <StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton /><StatCardSkeleton />
          </>
        ) : (
          <>
            <StatCard icon={<Gift className="w-5 h-5 text-purple-600" />} label="促销总数" value={stats.total} colorClass="bg-purple-50" />
            <StatCard icon={<Zap className="w-5 h-5 text-emerald-600" />} label="进行中" value={stats.active} colorClass="bg-emerald-50" />
            <StatCard icon={<Users className="w-5 h-5 text-blue-600" />} label="累计使用人次" value={stats.totalUsed} colorClass="bg-blue-50" />
            <StatCard icon={<Percent className="w-5 h-5 text-orange-600" />} label="平均折扣力度" value={`${stats.avgDiscount}%`} colorClass="bg-orange-50" />
          </>
        )}
      </div>

      {/* 促销列表 */}
      <div className="rounded-xl border border-slate-200 bg-white">
        <div className="border-b border-slate-100 px-6 py-4">
          <h3 className="text-lg font-semibold text-slate-800">促销活动列表</h3>
        </div>
        <div className="p-6">
          {loading ? (
            <div className="space-y-3">
              {[1, 2, 3].map(i => (
                <div key={i} className="h-16 animate-pulse rounded-lg bg-slate-100" />
              ))}
            </div>
          ) : promotions.length === 0 ? (
            <div className="py-12 text-center text-slate-400">
              <Gift className="w-12 h-12 mx-auto mb-3 text-slate-300" />
              <p>暂无促销活动</p>
              <Link href="/pricing?tab=promotions" className="text-sm text-emerald-600 hover:underline mt-2 inline-block">
                去创建第一个促销
              </Link>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-slate-100 text-left">
                    <th className="pb-3 text-sm font-medium text-slate-500">活动名称</th>
                    <th className="pb-3 text-sm font-medium text-slate-500">类型</th>
                    <th className="pb-3 text-sm font-medium text-slate-500">折扣</th>
                    <th className="pb-3 text-sm font-medium text-slate-500">适用房型</th>
                    <th className="pb-3 text-sm font-medium text-slate-500">有效期</th>
                    <th className="pb-3 text-sm font-medium text-slate-500">状态</th>
                    <th className="pb-3 text-sm font-medium text-slate-500">使用/上限</th>
                  </tr>
                </thead>
                <tbody>
                  {promotions.map(promo => (
                    <tr key={promo.id} className="border-b border-slate-50 hover:bg-slate-50/50">
                      <td className="py-3 pr-4">
                        <div>
                          <p className="font-medium text-slate-700">{promo.name}</p>
                          <p className="text-xs text-slate-400 mt-0.5">{promo.description || promo.condition}</p>
                        </div>
                      </td>
                      <td className="py-3 pr-4">
                        <Badge variant="outline">{typeLabels[promo.type] || promo.type}</Badge>
                      </td>
                      <td className="py-3 pr-4">
                        <span className="font-semibold text-emerald-600">{promo.discount}</span>
                      </td>
                      <td className="py-3 pr-4">
                        <div className="flex flex-wrap gap-1">
                          {promo.roomTypes.slice(0, 3).map(rt => (
                            <Badge key={rt} variant="secondary" className="text-xs">{rt}</Badge>
                          ))}
                          {promo.roomTypes.length > 3 && (
                            <Badge variant="secondary" className="text-xs">+{promo.roomTypes.length - 3}</Badge>
                          )}
                        </div>
                      </td>
                      <td className="py-3 pr-4 text-sm text-slate-500">
                        {promo.validFrom} ~ {promo.validTo}
                      </td>
                      <td className="py-3 pr-4">
                        {promo.status === 'active' ? (
                          <StatusBadge label="进行中" type="success" />
                        ) : promo.status === 'ended' ? (
                          <StatusBadge label="已结束" type="default" />
                        ) : (
                          <StatusBadge label="草稿" type="default" />
                        )}
                      </td>
                      <td className="py-3 text-sm text-slate-500">
                        {promo.usageCount}/{promo.usageLimit}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      </div>

      {/* 快捷入口 */}
      <div className="grid grid-cols-3 gap-4">
        <Link href="/pricing?tab=promotions" className="group">
          <div className="rounded-xl border border-slate-200 bg-white p-6 hover:border-emerald-300 transition-colors cursor-pointer flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-emerald-50">
                <TrendingUp className="w-5 h-5 text-emerald-600" />
              </div>
              <div>
                <p className="font-medium text-slate-700">限时特价管理</p>
                <p className="text-sm text-slate-400">创建和管理促销活动</p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-emerald-500 transition-colors" />
          </div>
        </Link>
        <Link href="/pricing?tab=calendar" className="group">
          <div className="rounded-xl border border-slate-200 bg-white p-6 hover:border-emerald-300 transition-colors cursor-pointer flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-blue-50">
                <CalendarDays className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <p className="font-medium text-slate-700">价格日历</p>
                <p className="text-sm text-slate-400">查看和调整每日房价</p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-emerald-500 transition-colors" />
          </div>
        </Link>
        <Link href="/pricing?tab=base" className="group">
          <div className="rounded-xl border border-slate-200 bg-white p-6 hover:border-emerald-300 transition-colors cursor-pointer flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="p-2 rounded-lg bg-orange-50">
                <Gift className="w-5 h-5 text-orange-600" />
              </div>
              <div>
                <p className="font-medium text-slate-700">基础房价设置</p>
                <p className="text-sm text-slate-400">设置各房型基础价格</p>
              </div>
            </div>
            <ArrowRight className="w-5 h-5 text-slate-300 group-hover:text-emerald-500 transition-colors" />
          </div>
        </Link>
      </div>
    </div>
  );
}
