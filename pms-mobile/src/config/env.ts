/**
 * 跨端安全读取构建环境变量。
 * 微信小程序/App 端运行时不存在 Node 的 process 全局，直接引用 `process.env.X`
 * 会抛 `process is not defined`，故先用 typeof 守卫，取不到时回退默认值。
 */
function readEnv(key: string): string | undefined {
  if (typeof process !== 'undefined' && process.env) {
    return (process.env as Record<string, string | undefined>)[key]
  }
  return undefined
}

export const ENV = {
  // PMS 后端服务地址（与 pms-web 生产环境一致）
  PMS_SERVER_URL: readEnv('PMS_SERVER_URL') || 'http://132.232.166.40:20002',
  PMS_AI_URL: readEnv('PMS_AI_URL') || 'http://132.232.166.40:20002',

  // 腾讯云配置
  TENCENT_SECRET_ID: readEnv('TENCENT_SECRET_ID') || '',
  TENCENT_SECRET_KEY: readEnv('TENCENT_SECRET_KEY') || '',
  TENCENT_ASR_APP_ID: readEnv('TENCENT_ASR_APP_ID') || '',
  TENCENT_OCR_APP_ID: readEnv('TENCENT_OCR_APP_ID') || '',

  // UniPush 配置（暂时禁用，有需要时改为 true 启用）
  UNIPUSH_ENABLED: false,

  /** AI 对话 SSE 端点 — 直连生产服务器 */
  AI_CHAT_URL: readEnv('NEXT_PUBLIC_AI_CHAT_URL') || 'http://132.232.166.40:20002/api/ai/chat',
}
