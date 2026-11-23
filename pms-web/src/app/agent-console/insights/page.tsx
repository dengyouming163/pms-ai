'use client';

import Link from 'next/link';
import { useCallback, useEffect, useState } from 'react';
import { ArrowLeft, BarChart3, RefreshCw } from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { Button } from '@/components/ui/button';
import {
  backfillInsights,
  getInsights,
  type AgentInsightItem,
  type AgentInsightsSummary,
} from '@/lib/agent-api';
import { AGENT_DEMO_MERCHANT_ID } from '@/lib/constants';

function money(value: number | string | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const n = Number(value);
  return Number.isFinite(n) ? `¥${n.toLocaleString('zh-CN')}` : '—';
}

function percent(value: number | null | undefined): string {
  if (value === null || value === undefined) return '—';
  return `${(Number(value) * 100).toFixed(1)}%`;
}

function gainText(item: AgentInsightItem): string {
  if (item.observed_revenue === null || item.observed_revenue === undefined) return '待回填';
  const gain = Number(item.observed_revenue) - Number(item.baseline_revenue);
  const sign = gain >= 0 ? '+' : '';
  return `${sign}${money(gain)}`;
}

export default function AgentInsightsPage() {
  const [summary, setSummary] = useState<AgentInsightsSummary | null>(null);
  const [items, setItems] = useState<AgentInsightItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [backfilling, setBackfilling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const data = await getInsights(AGENT_DEMO_MERCHANT_ID);
      setSummary(data.summary);
      setItems(data.items);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : '加载归因数据失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const handleBackfill = async () => {
    if (backfilling) return;
    setBackfilling(true);
    try {
      await backfillInsights(AGENT_DEMO_MERCHANT_ID);
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : '回填失败');
    } finally {
      setBackfilling(false);
    }
  };

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<BarChart3 className="h-5 w-5" />}
        title="收益归因"
        subtitle="采纳建议后的营收对比；归因非因果，仅用于复盘参考"
        actions={[
          {
            label: backfilling ? '回填中…' : '回填 T+7 数据',
            icon: <RefreshCw className="h-4 w-4" />,
            onClick: () => void handleBackfill(),
          },
        ]}
      />

      <Link
        href="/agent-console"
        className="inline-flex items-center gap-1.5 text-sm text-slate-500 hover:text-emerald-600"
      >
        <ArrowLeft className="h-4 w-4" />
        返回协作台
      </Link>

      {error && (
        <p className="rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-400">采纳率</p>
          <p className="mt-1 text-2xl font-semibold text-slate-800">
            {summary ? percent(summary.adoption_rate) : '—'}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            已采纳 {summary?.adopted_count ?? 0} / 已决策 {summary?.decided_count ?? 0}
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-400">归因增益</p>
          <p className="mt-1 text-2xl font-semibold text-emerald-600">
            {summary ? money(summary.attribution_gain) : '—'}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">
            已回填 {summary?.observed_count ?? 0} 条
          </p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-400">待回填</p>
          <p className="mt-1 text-2xl font-semibold text-amber-600">
            {summary?.pending_backfill_count ?? 0}
          </p>
          <p className="mt-1 text-[11px] text-slate-400">目标日期满 T+7 后可回填</p>
        </div>
        <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-xs text-slate-400">口径说明</p>
          <p className="mt-1 text-xs leading-relaxed text-slate-500">
            {summary?.attribution_note || '归因非因果：仅比较调价前后同口径营收'}
          </p>
        </div>
      </div>

      <div className="overflow-hidden rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-700">采纳记录</h3>
          <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
            刷新
          </Button>
        </div>
        {loading ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400">加载中…</p>
        ) : items.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-slate-400">
            暂无采纳记录。在协作台批准一条调价建议后会在这里出现。
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-400">
                <tr>
                  <th className="px-4 py-2 font-medium">采纳时间</th>
                  <th className="px-4 py-2 font-medium">房型</th>
                  <th className="px-4 py-2 font-medium">目标日</th>
                  <th className="px-4 py-2 font-medium">价格</th>
                  <th className="px-4 py-2 font-medium">基线营收</th>
                  <th className="px-4 py-2 font-medium">实际营收</th>
                  <th className="px-4 py-2 font-medium">增益</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {items.map((item) => (
                  <tr key={item.id} className="text-slate-600">
                    <td className="px-4 py-2.5 font-mono text-xs">
                      {item.adopted_at ? item.adopted_at.slice(0, 16).replace('T', ' ') : '—'}
                    </td>
                    <td className="px-4 py-2.5">{item.room_type_id || '—'}</td>
                    <td className="px-4 py-2.5 font-mono text-xs">{item.target_date || '—'}</td>
                    <td className="px-4 py-2.5">
                      {money(item.baseline_price)} → {money(item.adopted_price)}
                    </td>
                    <td className="px-4 py-2.5">
                      {money(item.baseline_revenue)}
                      <span className="ml-1 text-[11px] text-slate-400">
                        （{item.baseline_rooms} 间夜）
                      </span>
                    </td>
                    <td className="px-4 py-2.5">{money(item.observed_revenue)}</td>
                    <td className="px-4 py-2.5">{gainText(item)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <p className="text-[11px] leading-relaxed text-slate-400">
        基线营收 = 目标日入住率 × 门店房量 × 调价前价格；实际营收取目标日订单成交额。
        两者口径不同，且无对照实验，因此增益只能作为复盘参考，不能证明因果。
      </p>
    </div>
  );
}
