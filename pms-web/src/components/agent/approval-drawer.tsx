'use client';

import { useEffect, useState } from 'react';
import { Loader2, ShieldCheck, XCircle } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from '@/components/ui/sheet';
import { Textarea } from '@/components/ui/textarea';
import { approveRun } from '@/lib/agent-api';
import { ApiError } from '@/lib/api-client';

/* ========== payload 类型收窄工具 ========== */

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function asText(value: unknown): string | null {
  if (typeof value === 'string') return value.trim() ? value : null;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
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

/* ========== 提案解析与格式化 ========== */

export interface ParsedProposal {
  roomType: string;
  date: string;
  currentPrice: number | null;
  nextPrice: number | null;
  percent: number | null;
  reason: string | null;
  evidenceRefs: string[];
  idempotencyKey: string | null;
}

/** 从 approval_required 事件的 payload.proposal 中解析展示字段 */
export function parseProposal(proposal: Record<string, unknown> | null): ParsedProposal {
  const params = asRecord(proposal?.params);
  const before = asRecord(proposal?.before);
  const after = asRecord(proposal?.after);

  const currentPrice =
    asNumber(before?.price) ??
    asNumber(params?.expectedCurrentPrice) ??
    asNumber(params?.currentPrice);
  const nextPrice =
    asNumber(after?.price) ?? asNumber(params?.nextPrice) ?? asNumber(params?.suggestedPrice);

  const rawRefs = proposal?.evidence_refs;
  const evidenceRefs = Array.isArray(rawRefs)
    ? rawRefs.map((item) => asText(item)).filter((item): item is string => item !== null)
    : [];

  return {
    roomType: asText(params?.roomTypeId) ?? asText(proposal?.room_type) ?? '未知房型',
    date: asText(params?.date) ?? '未指定',
    currentPrice,
    nextPrice,
    percent:
      currentPrice !== null && currentPrice !== 0 && nextPrice !== null
        ? ((nextPrice - currentPrice) / currentPrice) * 100
        : null,
    reason: asText(proposal?.reason) ?? asText(params?.reason),
    evidenceRefs,
    idempotencyKey: asText(proposal?.idempotency_key),
  };
}

export function formatPrice(value: number | null): string {
  if (value === null) return '—';
  return `¥${value.toLocaleString('zh-CN', { maximumFractionDigits: 2 })}`;
}

export function formatPercent(percent: number | null): string {
  if (percent === null) return '—';
  return `${percent > 0 ? '+' : ''}${percent.toFixed(1)}%`;
}

/* ========== 组件 ========== */

interface ApprovalDrawerProps {
  open: boolean;
  onClose: () => void;
  runId: string;
  proposal: Record<string, unknown> | null;
  /** 审批成功后回调（父组件刷新运行状态） */
  onApproved?: () => void;
}

function DetailCell({
  label,
  value,
  className,
}: {
  label: string;
  value: string;
  className?: string;
}) {
  return (
    <div className={className}>
      <p className="text-[11px] text-slate-400">{label}</p>
      <p className="mt-0.5 break-words font-medium text-slate-700">{value}</p>
    </div>
  );
}

function describeError(err: unknown, decision: 'approve' | 'reject'): string {
  if (err instanceof ApiError) {
    if (err.status === 409) return '该运行已不在待审批状态';
    if (err.status === 422) {
      return decision === 'reject' ? '驳回理由不合法，请修改后重试' : '审批请求不合法，请刷新后重试';
    }
    return err.message;
  }
  return err instanceof Error ? err.message : '提交审批失败，请稍后重试';
}

/** 调价审批抽屉：记录人工决策，实际写入由执行层再次硬校验 */
export function ApprovalDrawer({
  open,
  onClose,
  runId,
  proposal,
  onApproved,
}: ApprovalDrawerProps) {
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [submitting, setSubmitting] = useState(false);

  const parsed = parseProposal(proposal);
  const trimmedReason = reason.trim();

  // 每次打开时重置本地状态，避免上一次的理由残留
  useEffect(() => {
    if (!open) return;
    setRejectOpen(false);
    setReason('');
    setSubmitting(false);
  }, [open]);

  const submit = async (decision: 'approve' | 'reject') => {
    if (submitting) return;
    if (decision === 'reject' && !trimmedReason) return;
    setSubmitting(true);
    try {
      await approveRun(runId, decision, decision === 'reject' ? trimmedReason : undefined);
      toast.success(decision === 'approve' ? '已批准，正在执行' : '已驳回');
      onClose();
      onApproved?.();
    } catch (err) {
      toast.error(describeError(err, decision));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Sheet
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <SheetContent className="w-full gap-0 sm:max-w-md">
        <SheetHeader className="border-b border-slate-100">
          <SheetTitle className="flex items-center gap-2 text-base">
            <ShieldCheck className="h-4 w-4 text-amber-600" />
            调价审批
          </SheetTitle>
          <SheetDescription className="text-xs leading-relaxed">
            审批只记录决策，真实写入由执行层再次硬校验后完成
          </SheetDescription>
        </SheetHeader>

        <div className="flex-1 space-y-4 overflow-y-auto p-4">
          <div className="grid grid-cols-2 gap-3 rounded-xl border border-slate-200 bg-slate-50/60 p-3 text-xs">
            <DetailCell label="房型" value={parsed.roomType} />
            <DetailCell label="日期" value={parsed.date} />
            <DetailCell
              label="当前价 → 建议价"
              value={`${formatPrice(parsed.currentPrice)} → ${formatPrice(parsed.nextPrice)}`}
              className="col-span-2"
            />
            <DetailCell label="变更幅度" value={formatPercent(parsed.percent)} />
            <DetailCell label="调价理由" value={parsed.reason ?? '未提供'} className="col-span-2" />
          </div>

          <div>
            <p className="text-[11px] font-medium text-slate-500">证据引用</p>
            {parsed.evidenceRefs.length > 0 ? (
              <div className="mt-1.5 flex flex-wrap gap-1.5">
                {parsed.evidenceRefs.map((ref) => (
                  <code
                    key={ref}
                    className="rounded bg-slate-100 px-1.5 py-0.5 font-mono text-[10px] text-slate-600"
                  >
                    {ref}
                  </code>
                ))}
              </div>
            ) : (
              <p className="mt-1 text-xs text-slate-400">无证据引用</p>
            )}
          </div>

          {parsed.idempotencyKey && (
            <p className="break-all text-[10px] text-slate-400">
              幂等键 <span className="font-mono">{parsed.idempotencyKey}</span>
            </p>
          )}
        </div>

        <SheetFooter className="gap-3 border-t border-slate-100">
          {rejectOpen && (
            <div className="space-y-1.5">
              <label htmlFor="approval-reject-reason" className="text-xs text-slate-500">
                驳回理由（必填）
              </label>
              <Textarea
                id="approval-reject-reason"
                value={reason}
                onChange={(event) => setReason(event.target.value)}
                rows={3}
                disabled={submitting}
                placeholder="说明驳回原因，便于后续审计"
                className="resize-none text-sm"
              />
            </div>
          )}
          <div className="flex gap-2">
            <Button
              className="flex-1 bg-emerald-600 text-white hover:bg-emerald-700"
              disabled={submitting}
              onClick={() => void submit('approve')}
            >
              {submitting ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <ShieldCheck className="h-4 w-4" />
              )}
              批准
            </Button>
            {rejectOpen ? (
              <Button
                variant="destructive"
                className="flex-1"
                disabled={submitting || trimmedReason.length === 0}
                onClick={() => void submit('reject')}
              >
                {submitting ? (
                  <Loader2 className="h-4 w-4 animate-spin" />
                ) : (
                  <XCircle className="h-4 w-4" />
                )}
                确认驳回
              </Button>
            ) : (
              <Button
                variant="outline"
                className="flex-1"
                disabled={submitting}
                onClick={() => setRejectOpen(true)}
              >
                <XCircle className="h-4 w-4" />
                驳回
              </Button>
            )}
          </div>
        </SheetFooter>
      </SheetContent>
    </Sheet>
  );
}
