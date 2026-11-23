'use client';

import { useEffect, useMemo, useState } from 'react';
import {
  AlertTriangle,
  Brain,
  CheckCircle2,
  CircleDot,
  Play,
  ShieldAlert,
  ShieldCheck,
  Wrench,
  XCircle,
  type LucideIcon,
} from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import { eventStreamUrl, type AgentEvent } from '@/lib/agent-api';

/** 终态事件：收到后关闭 SSE，不再重连 */
const TERMINAL_EVENT_TYPES = new Set(['run_succeeded', 'run_rejected', 'run_failed']);

/**
 * 订阅运行事件流。
 * - 按 seq 去重并保持升序；
 * - 断线后以当前最大 seq 重连，实现续传；
 * - 收到终态事件、组件卸载或 runId 变化时关闭连接。
 */
export function useAgentEventStream(runId: string | null) {
  const [events, setEvents] = useState<AgentEvent[]>([]);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    setEvents([]);
    setConnected(false);
    if (!runId) return;

    let source: EventSource | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let lastSeq = 0;
    let disposed = false;

    const connect = () => {
      source = new EventSource(eventStreamUrl(runId, lastSeq));

      source.onopen = () => {
        if (!disposed) setConnected(true);
      };

      source.onmessage = (message: MessageEvent<string>) => {
        if (disposed) return;
        let parsed: AgentEvent;
        try {
          parsed = JSON.parse(message.data) as AgentEvent;
        } catch {
          // 忽略无法解析的帧，避免单帧异常打断整条时间轴
          return;
        }
        if (!parsed || typeof parsed.seq !== 'number') return;

        lastSeq = Math.max(lastSeq, parsed.seq);
        setEvents((prev) => {
          if (prev.some((item) => item.seq === parsed.seq)) return prev;
          const next = [...prev, parsed];
          next.sort((a, b) => a.seq - b.seq);
          return next;
        });

        if (TERMINAL_EVENT_TYPES.has(parsed.type)) {
          disposed = true;
          setConnected(false);
          source?.close();
        }
      };

      source.onerror = () => {
        if (disposed) return;
        setConnected(false);
        source?.close();
        if (retryTimer) clearTimeout(retryTimer);
        // 2 秒后从当前最大 seq 续传
        retryTimer = setTimeout(connect, 2000);
      };
    };

    connect();

    return () => {
      disposed = true;
      if (retryTimer) clearTimeout(retryTimer);
      source?.close();
    };
  }, [runId]);

  return { events, connected };
}

type Tone = 'info' | 'success' | 'warning' | 'error' | 'neutral';

interface EventMeta {
  label: string;
  tone: Tone;
  icon: LucideIcon;
}

const EVENT_META: Record<string, EventMeta> = {
  run_started: { label: '运行开始', tone: 'info', icon: Play },
  node_start: { label: '节点开始', tone: 'info', icon: CircleDot },
  node_end: { label: '节点结束', tone: 'success', icon: CheckCircle2 },
  node_error: { label: '节点异常', tone: 'error', icon: XCircle },
  tool_start: { label: '工具调用', tone: 'neutral', icon: Wrench },
  tool_end: { label: '工具完成', tone: 'success', icon: Wrench },
  tool_error: { label: '工具异常', tone: 'error', icon: XCircle },
  llm_start: { label: '模型调用', tone: 'neutral', icon: Brain },
  llm_end: { label: '模型完成', tone: 'success', icon: Brain },
  llm_error: { label: '模型异常', tone: 'error', icon: Brain },
  trace_error: { label: '轨迹异常', tone: 'error', icon: AlertTriangle },
  approval_required: { label: '待审批', tone: 'warning', icon: ShieldAlert },
  approval_decided: { label: '审批已决', tone: 'warning', icon: ShieldCheck },
  run_succeeded: { label: '运行成功', tone: 'success', icon: CheckCircle2 },
  run_rejected: { label: '已驳回', tone: 'neutral', icon: XCircle },
  run_failed: { label: '运行失败', tone: 'error', icon: XCircle },
};

const TONE_BADGE: Record<Tone, string> = {
  info: 'border-blue-200 bg-blue-50 text-blue-700',
  success: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  warning: 'border-amber-300 bg-amber-50 text-amber-700',
  error: 'border-red-200 bg-red-50 text-red-700',
  neutral: 'border-slate-200 bg-slate-50 text-slate-600',
};

const TONE_ICON: Record<Tone, string> = {
  info: 'bg-blue-50 text-blue-600',
  success: 'bg-emerald-50 text-emerald-600',
  warning: 'bg-amber-100 text-amber-600',
  error: 'bg-red-50 text-red-600',
  neutral: 'bg-slate-100 text-slate-500',
};

/** 运行状态徽标配色 */
const RUN_STATUS_BADGE: Record<string, { label: string; className: string }> = {
  running: { label: '运行中', className: 'border-blue-200 bg-blue-50 text-blue-700' },
  awaiting_approval: { label: '待审批', className: 'border-amber-300 bg-amber-50 text-amber-700' },
  succeeded: { label: '已完成', className: 'border-emerald-200 bg-emerald-50 text-emerald-700' },
  rejected: { label: '已驳回', className: 'border-slate-200 bg-slate-100 text-slate-600' },
  conflict: { label: '价格冲突', className: 'border-red-200 bg-red-50 text-red-700' },
  guard_rejected: { label: '守卫拦截', className: 'border-red-200 bg-red-50 text-red-700' },
  failed: { label: '运行失败', className: 'border-red-200 bg-red-50 text-red-700' },
};

/** 运行状态徽标（协作台 / 详情页共用） */
export function RunStatusBadge({ status }: { status: string }) {
  const meta = RUN_STATUS_BADGE[status] ?? {
    label: status,
    className: 'border-slate-200 bg-slate-100 text-slate-600',
  };
  return <Badge className={cn('text-[11px]', meta.className)}>{meta.label}</Badge>;
}

/* ========== payload 类型收窄工具 ========== */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value !== null && typeof value === 'object') return JSON.stringify(value);
  return null;
}

function asNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/* ========== 格式化 ========== */

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '--:--:--';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '--:--:--';
  return date.toLocaleTimeString('zh-CN', { hour12: false });
}

function fmtDuration(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

function fmtPrice(value: number | null): string {
  if (value === null) return '—';
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

/** 节点开始/结束、工具/模型调用等成对事件耗时（优先用 started_at + ended_at） */
function computeDurations(events: AgentEvent[]): Record<number, number> {
  const result: Record<number, number> = {};
  const nodeStarts: Record<string, number> = {};

  for (const event of events) {
    const started = event.started_at ? Date.parse(event.started_at) : Number.NaN;
    const ended = event.ended_at ? Date.parse(event.ended_at) : Number.NaN;

    if (Number.isFinite(started) && Number.isFinite(ended) && ended >= started) {
      result[event.seq] = ended - started;
    } else if (
      event.type === 'node_end' &&
      event.node &&
      Number.isFinite(nodeStarts[event.node]) &&
      Number.isFinite(ended)
    ) {
      result[event.seq] = Math.max(0, ended - nodeStarts[event.node]);
    }

    if (event.type === 'node_start' && event.node && Number.isFinite(started)) {
      nodeStarts[event.node] = started;
    }
  }

  return result;
}

/** 事件摘要文案；未知类型返回 null，由调用方降级展示 */
function eventSummary(event: AgentEvent): string | null {
  const payload = event.payload ?? {};

  switch (event.type) {
    case 'run_started':
      return asText(payload.goal);
    case 'llm_end': {
      const tokensIn = event.tokens_in ?? asNumber(payload.tokens_in) ?? 0;
      const tokensOut = event.tokens_out ?? asNumber(payload.tokens_out) ?? 0;
      return `输入 ${tokensIn} tokens · 输出 ${tokensOut} tokens`;
    }
    case 'tool_start':
    case 'tool_end': {
      const tool = asText(payload.tool) ?? asText(payload.tool_name) ?? asText(payload.name);
      if (event.type === 'tool_start') return tool;
      return tool ? `${tool} 执行完成` : '工具执行完成';
    }
    case 'node_error':
    case 'tool_error':
    case 'llm_error':
    case 'trace_error':
      return asText(payload.error) ?? asText(payload.message);
    case 'approval_decided': {
      const decision = asText(payload.decision);
      const reason = asText(payload.reason);
      const label =
        decision === 'approve' ? '已通过' : decision === 'reject' ? '已驳回' : decision ?? '已决';
      return reason ? `${label}：${reason}` : label;
    }
    case 'run_succeeded':
    case 'run_rejected':
    case 'run_failed': {
      const parts: string[] = [];
      const route = asText(payload.route);
      const error = asText(payload.error);
      const final = asText(payload.final);
      if (route) parts.push(`路由 ${route}`);
      if (error) parts.push(`错误 ${error}`);
      if (final) parts.push(`结果 ${final}`);
      return parts.length > 0 ? parts.join(' · ') : null;
    }
    default:
      return asText(payload.message) ?? asText(payload.summary) ?? asText(payload.detail);
  }
}

/* ========== 组件 ========== */

function InfoCell({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span className="text-slate-400">{label}：</span>
      <span className="font-medium text-slate-700">
        {value}
      </span>
    </div>
  );
}

/** 待审批卡片详情：房型 / 日期 / 当前价→建议价 / 幅度 / 理由 */
function ApprovalDetail({ payload }: { payload: Record<string, unknown> }) {
  const proposal = asRecord(payload.proposal);
  const params = asRecord(proposal?.params);
  const before = asRecord(proposal?.before);
  const after = asRecord(proposal?.after);

  const roomType = asText(params?.roomTypeId) ?? asText(proposal?.room_type) ?? '未知房型';
  const date = asText(params?.date) ?? '未指定';
  const currentPrice =
    asNumber(before?.price) ?? asNumber(params?.expectedCurrentPrice) ?? asNumber(params?.currentPrice);
  const nextPrice = asNumber(after?.price) ?? asNumber(params?.nextPrice) ?? asNumber(params?.suggestedPrice);
  const reason = asText(proposal?.reason) ?? asText(params?.reason);
  const percent =
    currentPrice !== null && currentPrice !== 0 && nextPrice !== null
      ? ((nextPrice - currentPrice) / currentPrice) * 100
      : null;

  return (
    <div className="mt-2 grid gap-2 rounded-lg border border-amber-200 bg-white/80 p-3 text-xs sm:grid-cols-2">
      <InfoCell label="房型" value={roomType} />
      <InfoCell label="日期" value={date} />
      <InfoCell
        label="价格"
        value={`${fmtPrice(currentPrice)} → ${fmtPrice(nextPrice)}`}
      />
      <InfoCell
        label="幅度"
        value={percent === null ? '—' : `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`}
      />
      {reason && (
        <div className="sm:col-span-2">
          <span className="text-slate-400">理由：</span>
          <span className="text-slate-600">{reason}</span>
        </div>
      )}
      <div className="sm:col-span-2 text-[11px] font-medium text-amber-700">
        该提案需人工审批后方可执行
      </div>
    </div>
  );
}

function TimelineCard({ event, durationMs }: { event: AgentEvent; durationMs?: number }) {
  const meta = EVENT_META[event.type] ?? {
    label: event.type,
    tone: 'neutral' as Tone,
    icon: CircleDot,
  };
  const Icon = meta.icon;
  const isApproval = event.type === 'approval_required';
  const summary = isApproval ? null : eventSummary(event);

  return (
    <div
      className={cn(
        'rounded-xl border bg-white p-3.5 shadow-sm',
        isApproval
          ? 'border-amber-300 bg-amber-50/50 ring-1 ring-amber-200'
          : 'border-slate-200',
      )}
    >
      <div className="flex items-start gap-3">
        <span
          className={cn(
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center rounded-full',
            TONE_ICON[meta.tone],
          )}
        >
          <Icon className="h-4 w-4" />
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
            <Badge className={cn('text-[11px]', TONE_BADGE[meta.tone])}>{meta.label}</Badge>
            {event.node && <span className="text-xs text-slate-500">{event.node}</span>}
            {typeof durationMs === 'number' && (
              <span className="text-[11px] text-slate-400">耗时 {fmtDuration(durationMs)}</span>
            )}
            <span className="ml-auto text-[11px] tabular-nums text-slate-400">
              {fmtTime(event.created_at)}
            </span>
          </div>
          {summary && <p className="mt-1.5 break-words text-sm text-slate-600">{summary}</p>}
          {isApproval && <ApprovalDetail payload={event.payload ?? {}} />}
        </div>
      </div>
    </div>
  );
}

interface TimelineProps {
  events: AgentEvent[];
  /** 只渲染前 N 条（详情页步进用） */
  visibleCount?: number;
}

/** 运行时间轴 */
export function Timeline({ events, visibleCount }: TimelineProps) {
  const durations = useMemo(() => computeDurations(events), [events]);
  const shown =
    typeof visibleCount === 'number' ? events.slice(0, Math.max(0, visibleCount)) : events;

  if (shown.length === 0) {
    return (
      <div className="rounded-xl border border-dashed border-slate-200 bg-slate-50/60 px-4 py-10 text-center text-sm text-slate-400">
        尚无事件，运行后时间轴会实时出现
      </div>
    );
  }

  return (
    <div className="space-y-2.5">
      {shown.map((event) => (
        <TimelineCard key={event.seq} event={event} durationMs={durations[event.seq]} />
      ))}
    </div>
  );
}
