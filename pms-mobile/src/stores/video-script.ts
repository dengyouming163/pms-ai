/**
 * 短视频脚本向导状态机。
 * phase 驱动页面渲染；output 累积各阶段产出；finalPackage 为最终成片包。
 * 偏好（脚本风格 / 成片版本）持久化到 storage，下次默认。
 */
import { defineStore } from 'pinia'
import {
  startVideoScript,
  confirmVideoScript,
  getVideoScriptHistory,
} from '@/api/modules/video-script'
import type {
  VideoScriptInput,
  VideoScriptResponse,
  ConfirmNode,
  VideoScriptOutput,
  FinalPackage,
  HistoryItem,
} from '@/types/video-script'

/** 向导阶段 */
export type WizardPhase =
  | 'idle'        // 输入向导
  | 'starting'    // 阶段① 生成中
  | 'confirm1'    // 确认1·脚本风格
  | 'stage2'      // 阶段② 生成中
  | 'confirm2'    // 确认2·开头钩子
  | 'stage3_4'    // 阶段③④ 生成中
  | 'confirm3'    // 确认3·成片版本
  | 'finalizing'  // 打包成片
  | 'done'        // 脚本卡输出
  | 'error'       // 失败

/** 阶段 → 去术语化进度文案（各阶段要轮播的提示词） */
const STAGE_TIPS: Record<string, string[]> = {
  starting: ['正在梳理民宿的独特卖点…', '正在分析目标客群的喜好…'],
  stage2: ['正在构思抓人的开头…', '正在打磨口播文案…'],
  stage3_4: ['正在逐条核对合规红线…', '正在排布分镜画面…'],
  finalizing: ['正在打包成片…', '马上就好…'],
}

interface VideoScriptState {
  phase: WizardPhase
  projectId: string
  input: VideoScriptInput
  output: VideoScriptOutput
  finalPackage: FinalPackage | null
  confirm: ConfirmNode | null
  confirmNodeId: string
  progressText: string
  error: string
  history: HistoryItem[]
  prefStyle: string   // 上次脚本风格偏好
  prefVersion: string // 上次成片版本偏好
}

/** 安全读 storage（uni 可能未就绪时兜底） */
function readPref(key: string): string {
  try {
    return uni.getStorageSync(key) || ''
  } catch {
    return ''
  }
}

export const useVideoScriptStore = defineStore('video-script', {
  state: (): VideoScriptState => ({
    phase: 'idle',
    projectId: '',
    input: { storeName: '', highlights: [], goal: '引流订房', note: '' },
    output: {},
    finalPackage: null,
    confirm: null,
    confirmNodeId: '',
    progressText: '',
    error: '',
    history: [],
    prefStyle: readPref('vs_pref_style'),
    prefVersion: readPref('vs_pref_version'),
  }),

  getters: {
    /** 当前阶段的轮播提示文案 */
    tips: (s) => STAGE_TIPS[s.phase] || [],
  },

  actions: {
    /** 重置本次运行（保留输入与偏好，便于「再创作一次」微调） */
    reset() {
      this.phase = 'idle'
      this.projectId = ''
      this.output = {}
      this.finalPackage = null
      this.confirm = null
      this.confirmNodeId = ''
      this.progressText = ''
      this.error = ''
    },

    /** 应用一次接口响应：合并 output、更新 confirm / finalPackage / projectId */
    applyResponse(res: VideoScriptResponse) {
      if (res.project_id) this.projectId = res.project_id
      if (res.output) this.output = { ...this.output, ...res.output }
      if (res.confirm) this.confirm = res.confirm
      if (res.final_package) this.finalPackage = res.final_package
    },

    /** 由后端 status 推断当前阶段 */
    setPhaseFromStatus(status: string, nodeId: string) {
      this.confirmNodeId = nodeId
      if (status === 'CONFIRM1_WAIT') this.phase = 'confirm1'
      else if (status === 'CONFIRM2_WAIT') this.phase = 'confirm2'
      else if (status === 'CONFIRM3_WAIT') this.phase = 'confirm3'
      else if (status === 'COMPLETED') this.phase = 'done'
      else if (status === 'FAILED' || status === 'ERROR') this.phase = 'error'
      else this.phase = 'idle'
    },

    /** 记忆偏好 */
    rememberPrefs() {
      if (this.prefStyle) uni.setStorageSync('vs_pref_style', this.prefStyle)
      if (this.prefVersion) uni.setStorageSync('vs_pref_version', this.prefVersion)
    },

    /** 从失败态拉回输入态 */
    failWith(res: VideoScriptResponse) {
      this.error = res.error || res.error_code || '生成失败，请重试'
    },

    /** 开始生成：跑阶段① */
    async start(payload: VideoScriptInput) {
      this.reset()
      this.input = payload
      this.phase = 'starting'
      this.progressText = '了解民宿'
      try {
        const res = await startVideoScript(payload)
        this.applyResponse(res)
        this.setPhaseFromStatus(res.status, 'confirm_1')
        if (this.phase === 'error') this.failWith(res)
      } catch (e: any) {
        this.phase = 'error'
        this.error = e?.message || '网络异常，请重试'
      }
    },

    /** 提交确认，触发下一阶段 */
    async confirm(choice: string) {
      const nodeId = this.confirmNodeId
      // 先置 loading 阶段，再发请求
      if (nodeId === 'confirm_1') {
        this.phase = 'stage2'
        this.progressText = '构思脚本'
        this.prefStyle = choice
        this.rememberPrefs()
      } else if (nodeId === 'confirm_2') {
        this.phase = 'stage3_4'
        this.progressText = '合规审核'
      } else if (nodeId === 'confirm_3') {
        this.phase = 'finalizing'
        this.progressText = '打包成片'
        this.prefVersion = choice
        this.rememberPrefs()
      }
      try {
        const res = await confirmVideoScript(this.projectId, nodeId, choice)
        this.applyResponse(res)
        // confirm_2 连跑阶段③④返回 confirm_3；confirm_3 返回 COMPLETED
        if (res.status === 'CONFIRM2_WAIT') this.setPhaseFromStatus('CONFIRM2_WAIT', 'confirm_2')
        else if (res.status === 'CONFIRM3_WAIT') this.setPhaseFromStatus('CONFIRM3_WAIT', 'confirm_3')
        else this.setPhaseFromStatus(res.status, '')
        if (this.phase === 'error') this.failWith(res)
      } catch (e: any) {
        this.phase = 'error'
        this.error = e?.message || '网络异常，请重试'
      }
    },

    /** 加载历史 */
    async loadHistory() {
      try {
        this.history = await getVideoScriptHistory()
      } catch {
        this.history = []
      }
    },
  },
})
