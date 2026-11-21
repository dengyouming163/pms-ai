/**
 * 短视频脚本生产 — 前端类型契约（对齐 pms-ai-crew /api/video-script 接口返回）
 * 注意：后端产出为 LLM 生成的嵌套 JSON，结构偶有抖动，凡不直接渲染的嵌套对象
 * 一律用 Record<string, any> 兜底，仅对「需要渲染」的字段做强类型。
 */

/** 确认节点选项 */
export interface ConfirmOption {
  id: string
  label: string
  desc?: string
}

/** 确认节点（脚本风格 / 开头钩子 / 成片版本） */
export interface ConfirmNode {
  label: string
  options: ConfirmOption[]
  default: string
}

/** 锁定版口播脚本 */
export interface ApprovedScript {
  title: string
  script: string
  selling_points?: string[] | string
  text_hook?: string
}

/** 分镜镜头（11 字段，含人读 visual_description 与机器读 prompt） */
export interface StoryboardShot {
  shot_id?: string | number
  duration?: string | number
  purpose?: string
  character_id?: string
  scene_id?: string
  visual_description?: string
  action?: string
  camera?: string
  dialogue?: string
  prompt?: string
  negative_prompt?: string
  [key: string]: any
}

/** 分镜提示词（08 导演翻译产出） */
export interface StoryboardPrompts {
  video_style?: Record<string, any>
  character_reference?: Record<string, any>
  scene_reference?: Record<string, any>
  storyboard?: StoryboardShot[]
  generation_report?: Record<string, any>
}

/** 阶段累积产出对象（字段随阶段推进逐步补齐） */
export interface VideoScriptOutput {
  product_insight?: Record<string, any>
  user_persona?: Record<string, any>
  decision_map?: Record<string, any>
  visual_plan?: Record<string, any>
  marketing_script?: Record<string, any>
  compliance_report?: Record<string, any>
  approved_script?: ApprovedScript
  character_assets?: Array<Record<string, any>>
  scene_assets?: Array<Record<string, any>>
  storyboard_prompts?: StoryboardPrompts
  industry?: string
  platform?: string
  [key: string]: any
}

/** 最终成片包（confirm_3 返回，10 键） */
export interface FinalPackage {
  project_info?: { project_id: string; version: string }
  product_insight?: Record<string, any>
  user_persona?: Record<string, any>
  decision_map?: Record<string, any>
  visual_plan?: Record<string, any>
  approved_script?: ApprovedScript
  character_assets?: Array<Record<string, any>>
  scene_assets?: Array<Record<string, any>>
  storyboard_prompts?: StoryboardPrompts
  generation_params?: { version: string }
}

/** start / confirm 通用响应 */
export interface VideoScriptResponse {
  status: string
  project_id?: string
  confirm?: ConfirmNode
  output?: VideoScriptOutput
  final_package?: FinalPackage
  error?: string
  error_code?: string
}

/** 向导输入 */
export interface VideoScriptInput {
  storeName: string    // 民宿/门店名（后端当作 product_name 使用）
  highlights: string[] // 亮点标签
  goal: string         // 引流订房 / 涨粉种草 / 卖套餐
  note: string         // 一句卖点（选填）
}

/** 历史记录（history/list 返回项） */
export interface HistoryItem {
  status: string
  output?: VideoScriptOutput
  [key: string]: any
}
