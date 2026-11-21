/**
 * OTA 直连模块 API 客户端 —— 封装客户端设备状态、抓取统计、抓取日志接口
 */

import { apiGet } from './api-client';

/** 已绑定的 OTA 客户端设备信息 */
export interface OtaClientInfo {
  id: string;
  storeId: string;
  platform: string;
  deviceId: string;
  clientVersion: string;
  sessionValid: boolean;
  lastCaptureAt: string | null;
  lastHeartbeatAt: string | null;
  status: 'online' | 'offline' | 'error';
}

/** OTA 抓取日志 */
export interface OtaCaptureLog {
  id: string;
  storeId: string;
  platform: string;
  deviceId: string;
  result: 'success' | 'no_change' | 'session_expired' | 'error';
  newCount: number;
  changeCount: number;
  errorMessage: string | null;
  capturedAt: string;
}

/** OTA 抓取统计（今日） */
export interface OtaStats {
  todayNew: number;
  todayChanged: number;
  todayCancelled: number;
}

// 获取已绑定的客户端设备状态
export async function fetchOtaClients(): Promise<OtaClientInfo[]> {
  const data = await apiGet('/api/ota/client/status');
  return data.clients || [];
}

// 获取抓取统计
export async function fetchOtaStats(): Promise<OtaStats> {
  return await apiGet('/api/ota/orders/stats');
}

// 获取抓取日志
export async function fetchOtaLogs(limit = 20): Promise<OtaCaptureLog[]> {
  const data = await apiGet(`/api/ota/client/logs?limit=${limit}`);
  return data.logs || [];
}

// 获取或生成 OTA 客户端 store_key
export async function fetchOtaStoreKey(): Promise<{ storeKey: string; storeId: string; platform: string }> {
  return await apiGet('/api/ota/client/key');
}
