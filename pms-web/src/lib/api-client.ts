/**
 * 统一 API 客户端 —— 自动注入 JWT Bearer Token，统一错误处理，支持网络错误自动重试
 */

import { TOKEN_KEY, API_TIMEOUT_MS, API_BASE } from '@/lib/constants';

function getToken(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem(TOKEN_KEY);
}

function getStoreId(): string | null {
  if (typeof window === 'undefined') return null;
  return localStorage.getItem('currentStoreId');
}

function buildHeaders(init?: RequestInit): HeadersInit {
  const headers: Record<string, string> = {};
  if (!(init?.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const token = getToken();
  if (token) {
    headers['Authorization'] = `Bearer ${token}`;
  }
  // 注入当前门店ID
  const sid = getStoreId();
  if (sid) {
    headers['X-Store-Id'] = sid;
  }
  return { ...headers, ...(init?.headers as Record<string, string> || {}) };
}

function withTimeout(ms: number): { controller: AbortController; signal: AbortSignal } {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), ms);
  return { controller, signal: controller.signal };
}

/** API 错误类 —— 包含 HTTP 状态码和响应体 */
export class ApiError extends Error {
  status: number;
  body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
  }
}

async function handleResponse(res: Response): Promise<any> {
  if (res.status === 401) {
    localStorage.removeItem(TOKEN_KEY);
    // 避免死循环：如果当前已在登录页，不再跳转
    if (typeof window !== 'undefined' && !window.location.pathname.startsWith('/login')) {
      window.location.href = '/login';
    }
    throw new Error('未登录');
  }
  if (!res.ok) {
    const errorBody = await res.json().catch(() => ({}));
    throw new ApiError(
      res.status,
      errorBody.error || errorBody.message || `请求失败 (${res.status})`,
      errorBody,
    );
  }
  return res.json();
}

/**
 * 带自动重试的 fetch 封装
 * 仅对网络错误（TypeError）和超时（AbortError）进行重试
 * HTTP 状态码错误（4xx/5xx）不会触发重试
 * 重试间隔采用指数退避策略：1s → 2s → ...
 */
async function fetchWithRetry(
  url: string,
  options: RequestInit,
  maxRetries: number = 2,
): Promise<Response> {
  let lastError: Error;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      // 每次尝试使用独立的超时控制器，避免复用已中止的 signal
      const { controller, signal } = withTimeout(API_TIMEOUT_MS);
      const res = await fetch(url, { ...options, signal });
      return res;
    } catch (err) {
      lastError = err as Error;
      // 仅对网络错误进行重试（TypeError 对应 fetch 失败，AbortError 对应超时）
      const isNetworkError =
        err instanceof TypeError || (err as Error).name === 'AbortError';

      if (!isNetworkError || attempt >= maxRetries) {
        throw err;
      }

      // 指数退避等待：1s, 2s, 4s ...
      const delay = 1000 * Math.pow(2, attempt);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  throw lastError!;
}

function resolveUrl(url: string): string {
  if (url.startsWith('/api/')) {
    return `${API_BASE}${url}`;
  }
  return url;
}

export async function apiGet<T = any>(url: string): Promise<T> {
  try {
    const res = await fetchWithRetry(resolveUrl(url), { headers: buildHeaders() });
    return handleResponse(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, '请求超时，请稍后重试');
    }
    throw err;
  }
}

export async function apiPost<T = any>(url: string, body?: any): Promise<T> {
  try {
    const res = await fetchWithRetry(resolveUrl(url), {
      method: 'POST',
      headers: buildHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, '请求超时，请稍后重试');
    }
    throw err;
  }
}

export async function apiPut<T = any>(url: string, body?: any): Promise<T> {
  try {
    const res = await fetchWithRetry(resolveUrl(url), {
      method: 'PUT',
      headers: buildHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, '请求超时，请稍后重试');
    }
    throw err;
  }
}

export async function apiDelete<T = any>(url: string, body?: any): Promise<T> {
  try {
    const res = await fetchWithRetry(resolveUrl(url), {
      method: 'DELETE',
      headers: buildHeaders(),
      body: body ? JSON.stringify(body) : undefined,
    });
    return handleResponse(res);
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if ((err as Error).name === 'AbortError') {
      throw new ApiError(0, '请求超时，请稍后重试');
    }
    throw err;
  }
}
