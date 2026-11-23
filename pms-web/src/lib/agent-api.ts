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
