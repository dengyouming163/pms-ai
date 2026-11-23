'use client';

import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useEffect, useState } from 'react';
import { ArrowLeft, ChevronLeft, ChevronRight } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { RunStatusBadge, Timeline, useAgentEventStream } from '@/components/agent/timeline';
import { getRun, type AgentRun } from '@/lib/agent-api';
import { cn } from '@/lib/utils';

const TERMINAL_STATUSES = new Set([
  'succeeded',
  'rejected',
  'conflict',
  'guard_rejected',
  'failed',
]);

function formatDuration(startIso: string | null, endIso: string | null): string {
  if (!startIso) return '—';
  const started = Date.parse(startIso);
  if (!Number.isFinite(started)) return '—';
  const ended = endIso ? Date.parse(endIso) : Date.now();
  if (!Number.isFinite(ended)) return '—';
  const seconds = Math.max(0, (ended - started) / 1000);
  return endIso ? `${seconds.toFixed(1)}s` : `${seconds.toFixed(1)}s（进行中）`;
}

function Meta({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2">
      <p className="text-[11px] text-slate-400">{label}</p>
      <p
        className={cn('mt-0.5 truncate text-sm text-slate-700', mono && 'font-mono text-xs')}
        title={value}
      >
        {value}
      </p>
    </div>
  );
}

export default function AgentRunDetailPage() {
  const params = useParams();
  const rawRunId = params?.runId;
  const runId = Array.isArray(rawRunId) ? rawRunId[0] ?? null : rawRunId ?? null;

  const [run, setRun] = useState<AgentRun | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [visibleCount, setVisibleCount] = useState<number | undefined>(undefined);

  const { events, connected } = useAgentEventStream(runId);

  // 拉取运行元信息；未到终态时每 2 秒刷新一次
  useEffect(() => {
    if (!runId) {
      setLoading(false);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const load = async () => {
      try {
        const data = await getRun(runId);
        if (cancelled) return;
        setRun(data);
        setError(null);
        setLoading(false);
        if (!TERMINAL_STATUSES.has(data.status)) {
          timer = setTimeout(load, 2000);
        }
      } catch (err) {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : '加载运行详情失败');
        setLoading(false);
      }
    };

    void load();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);

  const total = events.length;
  const shownCount = visibleCount ?? total;
  const canPrev = total > 0 && shownCount > 1;
  const canNext = total > 0 && shownCount < total;

  return (
    <div className="space-y-4">
      <Link
        href="/agent-console"
        className="inline-flex items-center gap-1 text-sm text-slate-500 transition-colors hover:text-emerald-600"
      >
        <ArrowLeft className="h-4 w-4" />
        返回协作台
      </Link>

      {/* 运行元信息 */}
      <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              {run ? (
                <RunStatusBadge status={run.status} />
              ) : (
                <RunStatusBadge status="running" />
              )}
              <span className="text-[11px] text-slate-400">运行 ID {runId ?? '—'}</span>
            </div>
            <p className="mt-2 text-base font-semibold text-slate-800">
              {run?.goal || (loading ? '加载运行信息…' : '—')}
            </p>
            {error && <p className="mt-2 text-xs text-red-600">{error}</p>}
          </div>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
          <Meta label="路由" value={run?.route || '—'} />
          <Meta
            label="Token 合计"
            value={run?.total_tokens != null ? String(run.total_tokens) : '—'}
          />
          <Meta
            label="耗时"
            value={formatDuration(run?.started_at ?? null, run?.ended_at ?? null)}
          />
          <Meta label="Trace ID" value={run?.trace_id || '—'} mono />
        </div>
      </div>

      {/* 事件时间轴 + 步进 */}
      <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
        <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
          <h3 className="text-sm font-semibold text-slate-700">事件时间轴</h3>
          <span
            className={cn(
              'flex items-center gap-1 text-[11px]',
              connected ? 'text-emerald-600' : 'text-slate-400',
            )}
          >
            <span
              className={cn(
                'h-1.5 w-1.5 rounded-full',
                connected ? 'bg-emerald-500' : 'bg-slate-300',
              )}
            />
            {connected ? '实时连接中' : '未连接'}
          </span>

          <div className="ml-auto flex flex-wrap items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVisibleCount(Math.max(1, shownCount - 1))}
              disabled={!canPrev}
            >
              <ChevronLeft className="h-3.5 w-3.5" />
              上一条
            </Button>
            <span className="text-xs tabular-nums text-slate-500">
              第 {shownCount} / {total} 条
            </span>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setVisibleCount(Math.min(total, shownCount + 1))}
              disabled={!canNext}
            >
              下一条
              <ChevronRight className="h-3.5 w-3.5" />
            </Button>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setVisibleCount(undefined)}
              disabled={visibleCount === undefined}
            >
              回到实时
            </Button>
          </div>
        </div>

        <div className="p-4">
          <Timeline events={events} visibleCount={visibleCount} />
        </div>
      </div>
    </div>
  );
}
