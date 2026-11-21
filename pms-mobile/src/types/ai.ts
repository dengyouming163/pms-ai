export type AIScene = 'general' | 'operation' | 'customer'

export interface AIMessage {
  id: string
  role: 'user' | 'assistant'
  content: string
  createdAt: string
  scene: AIScene
  actions?: AIAction[]
}

export interface AIAction {
  type: 'navigate' | 'confirm'
  title: string
  payload: any
}

export interface AIPrompt {
  id: string
  scene: AIScene
  label: string
  icon?: string
  prompt: string
}

export interface CapabilityCard {
  id: string
  groupKey: 'general' | 'operation' | 'customer'
  sectionKey?: 'query' | 'action'
  label: string
  icon: string
  description: string
  prompt: string
  /** 存在时点击卡片跳转页面（如短视频脚本向导），否则发送 prompt */
  url?: string
}

export interface CapabilitySection {
  title: string
  items: CapabilityCard[]
}

export interface CapabilityGroup {
  id: 'general' | 'operation' | 'customer'
  title: string
  description: string
  sections: CapabilitySection[]
}
