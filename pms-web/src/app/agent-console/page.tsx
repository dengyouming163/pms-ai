'use client';

import Link from 'next/link';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bot,
  Building2,
  History,
  ShieldAlert,
  Sparkles,
} from 'lucide-react';
import { PageHeader } from '@/components/page-header';
import { ApprovalDrawer, formatPercent, formatPrice, parseProposal } from '@/components/agent/approval-drawer';
import { RunForm } from '@/components/agent/run-form';
import { RunStatusBadge, Timeline, useAgentEventStream } from '@/components/agent/timeline';
import { Button } from '@/components/ui/button';
import { createRun, getRun, type AgentRun } from '@/lib/agent-api';
import { AGENT_DEMO_MERCHANT_ID } from '@/lib/constants';
import { useStore } from '@/lib/context/store-context';
import { cn } from '@/lib/utils';

const RECENT_RUNS_KEY = 'agent_recent_runs';
const MAX_RECENT_RUNS = 20;

/** 最近运行记录（localStorage 持久化） */
interface RecentRun {
  run_id: string;
  goal: string;
  status: string;
  created_at: string;
}

const SCENARIO_NOTES = [
  { title: '收益调价', desc: '结合入住率、竞品与历史价格给出涨价 / 降价建议，执行前必须人工审批。' },
  { title: '晨报诊断', desc: '汇总昨日经营数据，指出异常指标与需要跟进的待办。' },
  { title: '住中客服', desc: '基于酒店政策与住客诉求，生成可直接回复的话术。' },
  { title: '渠道体检', desc: '核对各渠道价差、房量与超时风险，给出处理建议。' },
];

function loadRecentRuns(): RecentRun[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_RUNS_KEY);
    if (!raw) return [];
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const items: RecentRun[] = [];
    for (const item of parsed) {
      if (typeof item !== 'object' || item === null) continue;
      const record = item as Record<string, unknown>;
      if (typeof record.run_id !== 'string' || typeof record.goal !== 'string') continue;
      items.push({
        run_id: record.run_id,
        goal: record.goal,
        status: typeof record.status === 'string' ? record.status : 'running',
        created_at:
          typeof record.created_at === 'string' ? record.created_at : new Date().toISOString(),
      });
    }
    return items.slice(0, MAX_RECENT_RUNS);
  } catch {
    // 本地存储损坏时降级为空列表
    return [];
  }
}

function formatDateTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '—';
  return date.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
}

export default function AgentConsolePage() {
  const { currentStore } = useStore();
  const [recentRuns, setRecentRuns] = useState<RecentRun[]>([]);
  const [recentLoaded, setRecentLoaded] = useState(false);
  const [currentRunId, setCurrentRunId] = useState<string | null>(null);
  const [run, setRun] = useState<AgentRun | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawerOpen, setDrawerOpen] = useState(false);
  // 记录已自动打开过抽屉的 runId，避免用户关闭后被反复弹出
  const autoOpenedRunId = useRef<string | null>(null);

  const { events, connected } = useAgentEventStream(currentRunId);

  // 最近一条待审批提案
  const pendingProposal = useMemo<Record<string, unknown> | null>(() => {
    for (let index = events.length - 1; index >= 0; index -= 1) {
      const event = events[index];
      if (event.type !== 'approval_required') continue;
      const proposal = event.payload?.proposal;
      if (typeof proposal === 'object' && proposal !== null && !Array.isArray(proposal)) {
        return proposal as Record<string, unknown>;
      }
    }
    return null;
  }, [events]);

  // 初始化：读取最近运行记录
  useEffect(() => {
    setRecentRuns(loadRecentRuns());
    setRecentLoaded(true);
  }, []);

  // 最近运行记录持久化（读取完成后再写，避免覆盖历史）
  useEffect(() => {
    if (!recentLoaded) return;
    try {
      window.localStorage.setItem(RECENT_RUNS_KEY, JSON.stringify(recentRuns));
    } catch {
      // 隐私模式 / 配额不足时忽略
    }
  }, [recentRuns, recentLoaded]);

  // 轮询当前运行状态，直到终态
  useEffect(() => {
    if (!currentRunId) {
      setRun(null);
      return;
    }

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const poll = async () => {
      try {
        const data = await getRun(currentRunId);
        if (cancelled) return;
        setRun(data);
        setRecentRuns((prev) =>
          prev.some((item) => item.run_id === data.id && item.status !== data.status)
            ? prev.map((item) =>
                item.run_id === data.id ? { ...item, status: data.status } : item,
              )
            : prev,
        );
        if (data.status === 'running' || data.status === 'awaiting_approval') {
          timer = setTimeout(poll, 2000);
        }
      } catch {
        if (!cancelled) timer = setTimeout(poll, 2000);
      }
    };

    void poll();

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [currentRunId]);

  // 进入待审批且提案到达时自动打开一次抽屉
  useEffect(() => {
    if (run?.status !== 'awaiting_approval' || !pendingProposal || !currentRunId) return;
    if (autoOpenedRunId.current === currentRunId) return;
    autoOpenedRunId.current = currentRunId;
    setDrawerOpen(true);
  }, [run?.status, pendingProposal, currentRunId]);

  // 审批后立即刷新运行状态（后续事件仍由 SSE 推送）
  const refreshRun = useCallback(async () => {
    if (!currentRunId) return;
    try {
      const data = await getRun(currentRunId);
      setRun(data);
      setRecentRuns((prev) =>
        prev.map((item) => (item.run_id === data.id ? { ...item, status: data.status } : item)),
      );
    } catch {
      // 刷新失败时交给轮询兜底，不打断主流程
    }
  }, [currentRunId]);

  const handleSubmit = async (goal: string) => {
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const created = await createRun(goal, {
        merchant_id: AGENT_DEMO_MERCHANT_ID,
        store_id: currentStore?.id,
      });
      const entry: RecentRun = {
        run_id: created.run_id,
        goal,
        status: created.status || 'running',
        created_at: new Date().toISOString(),
      };
      setRecentRuns((prev) =>
        [entry, ...prev.filter((item) => item.run_id !== entry.run_id)].slice(0, MAX_RECENT_RUNS),
      );
      setRun(null);
      setCurrentRunId(created.run_id);
    } catch (err) {
      setError(err instanceof Error ? err.message : '创建运行失败，请稍后重试');
    } finally {
      setSubmitting(false);
    }
  };

  const selectRun = (runId: string) => {
    setRun(null);
    setError(null);
    setCurrentRunId(runId);
  };

  const running = submitting || run?.status === 'running';
  const awaitingApproval = run?.status === 'awaiting_approval';
  const pendingDetail = awaitingApproval && pendingProposal ? parseProposal(pendingProposal) : null;

  return (
    <div className="space-y-5">
      <PageHeader
        icon={<Bot className="h-5 w-5" />}
        title="AI 协作台"
        subtitle="用一句话交代经营目标，AI 自主拆解任务、调用工具并实时汇报每一步"
        actions={[
          {
            label: '历史运行',
            icon: <History className="h-4 w-4" />,
            onClick: () => {
              document
                .getElementById('recent-runs')
                ?.scrollIntoView({ behavior: 'smooth', block: 'start' });
            },
          },
        ]}
      />

      <div className="grid grid-cols-1 gap-5 lg:grid-cols-12">
        {/* 左栏：场景说明 + 当前门店 */}
        <aside className="space-y-4 lg:col-span-3">
          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-700">
              <Sparkles className="h-4 w-4 text-emerald-600" />
              可以交给 AI 的场景
            </h3>
            <ul className="mt-3 space-y-3">
              {SCENARIO_NOTES.map((note) => (
                <li key={note.title}>
                  <p className="text-xs font-medium text-slate-700">{note.title}</p>
                  <p className="mt-0.5 text-[11px] leading-relaxed text-slate-400">{note.desc}</p>
                </li>
              ))}
            </ul>
          </div>

          <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700">当前门店</h3>
            <div className="mt-3 flex items-start gap-3">
              <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-emerald-50 text-emerald-600">
                <Building2 className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-slate-700">
                  {currentStore?.fullName || '尚未选择门店'}
                </p>
                <p className="mt-0.5 text-xs text-slate-400">商户 {AGENT_DEMO_MERCHANT_ID}</p>
                {currentStore?.id && (
                  <p className="mt-0.5 truncate text-[11px] text-slate-400">
                    门店 ID {currentStore.id}
                  </p>
                )}
              </div>
            </div>
            <p className="mt-3 text-[11px] leading-relaxed text-slate-400">
              当前使用云栖山舍演示租户，真实接入后将改为从登录态获取商户信息。
            </p>
          </div>
        </aside>

        {/* 中栏：运行表单 + 实时时间轴 */}
        <section className="space-y-4 lg:col-span-6">
          <RunForm onSubmit={handleSubmit} running={running} />

          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex flex-wrap items-center gap-2 border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-700">运行时间轴</h3>
              {run && <RunStatusBadge status={run.status} />}
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
              {currentRunId && (
                <Link
                  href={`/agent-console/${currentRunId}`}
                  className="ml-auto text-xs text-emerald-600 hover:underline"
                >
                  查看运行详情
                </Link>
              )}
            </div>
            <div className="p-4">
              {error && (
                <p className="mb-3 rounded-lg bg-red-50 px-3 py-2 text-xs text-red-600">{error}</p>
              )}
              {currentRunId ? (
                <Timeline events={events} />
              ) : (
                <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center text-sm text-slate-400">
                  选择上方场景或直接描述目标，点击「开始运行」后时间轴会实时滚动
                </div>
              )}
            </div>
          </div>
        </section>

        {/* 右栏：最近运行 + 待审批提示 */}
        <aside id="recent-runs" className="space-y-4 lg:col-span-3">
          <div className="rounded-xl border border-slate-200 bg-white shadow-sm">
            <div className="flex items-center justify-between border-b border-slate-100 px-4 py-3">
              <h3 className="text-sm font-semibold text-slate-700">最近运行</h3>
              <span className="text-[11px] text-slate-400">最多 20 条</span>
            </div>
            <div className="max-h-[420px] overflow-y-auto p-2">
              {recentRuns.length === 0 ? (
                <p className="px-2 py-6 text-center text-xs text-slate-400">暂无运行记录</p>
              ) : (
                <div className="space-y-1">
                  {recentRuns.map((item) => (
                    <div
                      key={item.run_id}
                      className={cn(
                        'rounded-lg border p-2.5 transition-colors',
                        item.run_id === currentRunId
                          ? 'border-emerald-300 bg-emerald-50/60'
                          : 'border-transparent hover:bg-slate-50',
                      )}
                    >
                      <button
                        type="button"
                        onClick={() => selectRun(item.run_id)}
                        className="w-full text-left"
                      >
                        <p className="line-clamp-2 text-xs font-medium text-slate-700">
                          {item.goal}
                        </p>
                        <div className="mt-1.5 flex flex-wrap items-center gap-2">
                          <RunStatusBadge status={item.status} />
                          <span className="text-[11px] text-slate-400">
                            {formatDateTime(item.created_at)}
                          </span>
                        </div>
                      </button>
                      <Link
                        href={`/agent-console/${item.run_id}`}
                        className="mt-1 inline-flex items-center gap-0.5 text-[11px] text-emerald-600 hover:underline"
                      >
                        查看详情
                        <ArrowRight className="h-3 w-3" />
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div
            className={cn(
              'rounded-xl border p-4',
              pendingDetail
                ? 'border-amber-300 bg-amber-50'
                : 'border-dashed border-slate-200 bg-white',
            )}
          >
            <div className="flex items-center gap-2">
              <ShieldAlert
                className={cn('h-4 w-4', pendingDetail ? 'text-amber-600' : 'text-slate-400')}
              />
              <h3
                className={cn(
                  'text-sm font-semibold',
                  pendingDetail ? 'text-amber-700' : 'text-slate-600',
                )}
              >
                待审批提示
              </h3>
            </div>
            {pendingDetail ? (
              <>
                <div className="mt-2 space-y-1 text-xs text-amber-700">
                  <p className="font-medium">
                    {pendingDetail.roomType} · {pendingDetail.date}
                  </p>
                  <p className="tabular-nums">
                    {formatPrice(pendingDetail.currentPrice)} →{' '}
                    {formatPrice(pendingDetail.nextPrice)}
                    <span className="ml-1.5 text-amber-600">
                      （{formatPercent(pendingDetail.percent)}）
                    </span>
                  </p>
                </div>
                <Button
                  size="sm"
                  className="mt-3 w-full bg-amber-600 text-white hover:bg-amber-700"
                  onClick={() => setDrawerOpen(true)}
                >
                  立即审批
                </Button>
              </>
            ) : (
              <p className="mt-2 text-xs leading-relaxed text-slate-400">暂无待审批提案</p>
            )}
          </div>
        </aside>
      </div>

      {currentRunId && (
        <ApprovalDrawer
          open={drawerOpen}
          onClose={() => setDrawerOpen(false)}
          runId={currentRunId}
          proposal={pendingProposal}
          onApproved={refreshRun}
        />
      )}
    </div>
  );
}
