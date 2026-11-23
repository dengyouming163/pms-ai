/**
 * pms-agent 后端接口封装。
 * 端点挂在根路径（无 /api 前缀、无鉴权），SSE 与 REST 均直连 AGENT_BASE。
 */

import { apiGet, apiPost } from '@/lib/api-client';
import { AGENT_BASE } from '@/lib/constants';

/** 租户信息：商户必填，门店可选 */
export interface AgentTenant {
  merchant_id: string;
  store_id?: string;
}

/** 运行状态 */
export type AgentRunStatus =
  | 'running'
  | 'awaiting_approval'
  | 'succeeded'
  | 'rejected'
  | 'conflict'
  | 'guard_rejected'
  | 'failed';

/** 运行详情（GET /runs/{run_id}） */
export interface AgentRun {
  id: string;
  tenant: AgentTenant;
  goal: string;
  route: string | null;
  status: AgentRunStatus;
  started_at: string | null;
  ended_at: string | null;
  total_tokens: number | null;
  cost: number | null;
  trace_id: string | null;
}

/** 运行事件（SSE data 帧） */
export interface AgentEvent {
  seq: number;
  node: string | null;
  type: string;
  payload: Record<string, unknown>;
  started_at: string | null;
  ended_at: string | null;
  tokens_in: number | null;
  tokens_out: number | null;
  trace_id: string | null;
  created_at: string;
}

/** 创建运行的返回体 */
export interface AgentRunCreated {
  run_id: string;
  status: string;
}

/** 创建运行，立即返回 running（图在服务端后台执行） */
export function createRun(goal: string, tenant?: AgentTenant) {
  return apiPost<AgentRunCreated>(`${AGENT_BASE}/runs`, { goal, tenant });
}

/** 查询运行详情 */
export function getRun(runId: string) {
  return apiGet<AgentRun>(`${AGENT_BASE}/runs/${runId}`);
}

/** 提交审批决策（审批 UI 由后续任务接入，这里仅封装接口） */
export function approveRun(
  runId: string,
  decision: 'approve' | 'reject',
  reason?: string,
) {
  return apiPost<{ run_id: string; status: string }>(
    `${AGENT_BASE}/runs/${runId}/approve`,
    { decision, reason },
  );
}

/** 事件流地址：after 之后的事件会先回放，再持续推送新事件 */
export function eventStreamUrl(runId: string, afterSeq = 0): string {
  return `${AGENT_BASE}/runs/${runId}/events?after=${afterSeq}`;
}

/** 采纳归因记录（GET /insights 的 items） */
export interface AgentInsightItem {
  id: number;
  run_id: string;
  proposal_ref: string;
  room_type_id: string | null;
  target_date: string | null;
  baseline_price: number | string | null;
  adopted_price: number | string | null;
  baseline_rooms: number;
  baseline_revenue: number | string;
  observed_revenue: number | string | null;
  attribution_note: string | null;
  adopted_at: string;
  observed_at: string | null;
}

/** 采纳归因汇总 */
export interface AgentInsightsSummary {
  adopted_count: number;
  decided_count: number;
  adoption_rate: number;
  observed_count: number;
  pending_backfill_count: number;
  attribution_gain: number;
  attribution_note: string;
}

/** 查询采纳归因（归因非因果，由 attribution_note 明确标注） */
export function getInsights(merchantId?: string) {
  const query = merchantId ? `?merchant_id=${encodeURIComponent(merchantId)}` : '';
  return apiGet<{ summary: AgentInsightsSummary; items: AgentInsightItem[] }>(
    `${AGENT_BASE}/insights${query}`,
  );
}

/** 触发 T+7 归因回填（用当日实际营收回填 observed_revenue） */
export function backfillInsights(merchantId?: string) {
  const query = merchantId ? `?merchant_id=${encodeURIComponent(merchantId)}` : '';
  return apiPost<{ checked: number; filled: number; skipped: number; errors: number }>(
    `${AGENT_BASE}/insights/backfill${query}`,
    {},
  );
}
