/**
 * 短视频脚本生产 — 接口封装
 * 全部走 @/api/request（自动注入 token + X-Store-Id，BASE_URL 指向生产网关 20002）。
 * pms-server BFF（/api/video-script/*）转发到 pms-ai-crew（生产内网 :8000；本地 dev 为 :9091）。
 */
import { get, post } from '../request'
import type {
  VideoScriptInput,
  VideoScriptResponse,
  HistoryItem,
} from '@/types/video-script'

/** 创建任务并跑阶段①，返回 confirm_1（脚本风格） */
export function startVideoScript(input: VideoScriptInput): Promise<VideoScriptResponse> {
  // showLoading:false —— 阶段①为同步阻塞，加载态交给 ProgressView 的自定义进度 UI，
  // 避免 request 的通用 uni.showLoading 遮罩盖掉去术语化进度条
  return post('/api/video-script/start', {
    store_id: input.storeName,   // 后端 brief.product_name = store_id
    highlights: input.highlights,
    goal: input.goal,
    note: input.note,
    industry: '旅游住宿',
    platform: '通用',
  }, { showLoading: false, timeout: 180000 })
}

/** 提交确认选择，触发下一阶段 */
export function confirmVideoScript(
  projectId: string,
  nodeId: string,
  choice: string,
): Promise<VideoScriptResponse> {
  return post('/api/video-script/confirm', {
    project_id: projectId,
    node_id: nodeId,
    choice,
  }, { showLoading: false, timeout: 180000 })
}

/** 查询任务状态（含已产出 output，供刷新/断点续跑） */
export function getVideoScriptStatus(projectId: string): Promise<VideoScriptResponse> {
  return get(`/api/video-script/${projectId}`)
}

/** 历史列表（只读回看） */
export function getVideoScriptHistory(): Promise<HistoryItem[]> {
  return get('/api/video-script/history/list').then((res: any) => {
    return res?.items || res || []
  })
}
