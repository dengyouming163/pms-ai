/** 全局共享常量 v2 — 强制刷新所有 chunk hash */

/** localStorage 中存储 JWT Token 的键名 */
export const TOKEN_KEY = 'pms_auth_token';

/** 后端 API 基础地址（HTTPS 域名下用相对路径，由 nginx 转发 /api/ → :20002） */
export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || '';

/** API 请求超时时间（毫秒） */
export const API_TIMEOUT_MS = 30_000;

/** AI 对话 SSE 端点 — 直连生产服务器，绕过 Next.js proxy 避免 Turbopack 缓冲 SSE 流 */
export const AI_CHAT_URL = process.env.NEXT_PUBLIC_AI_CHAT_URL || 'http://132.232.166.40:20002/api/ai/chat';

/** AI 洞察查询端点 */
export const AI_INSIGHTS_URL = '/api/ai/insights';

/** AI 模式配置端点 */
export const AI_MODE_URL = `${API_BASE}/api/ai/mode`;

/** pms-agent 服务地址（SSE 直连，绕过 Next.js 缓冲） */
export const AGENT_BASE = process.env.NEXT_PUBLIC_AGENT_BASE || 'http://localhost:8000';

/**
 * 演示租户（种子数据商户 demo-yunqi，即「云栖山舍」演示民宿）。
 * 真实接入时该值应改为从登录态 / 门店上下文获取的商户 ID，不可写死。
 */
export const AGENT_DEMO_MERCHANT_ID = process.env.NEXT_PUBLIC_DEMO_MERCHANT_ID || 'demo-yunqi';

/** 平台入驻注册页地址（pms-platform-web） */
export const PLATFORM_REGISTER_URL = process.env.NEXT_PUBLIC_PLATFORM_URL
  ? `${process.env.NEXT_PUBLIC_PLATFORM_URL}/register`
  : 'http://132.232.166.40:20004/register';
