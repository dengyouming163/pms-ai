import { defineStore } from 'pinia'
import type { AIMessage, AIScene, AIPrompt, CapabilityCard, CapabilityGroup } from '@/types/ai'

export const useAIStore = defineStore('ai', {
  state: () => ({
    viewMode: 'workbench' as 'workbench' | 'chat',
    currentScene: 'operation' as AIScene,
    sessions: {
      general: [] as AIMessage[],
      operation: [] as AIMessage[],
      customer: [] as AIMessage[]
    },
    loading: false,
    streaming: false,
    progressHint: '',
    activeCardId: '' as string,
    currentModel: 'deepseek' as string,
    currentModelLabel: 'DeepSeek V4' as string,
    modelLoading: false,
    capabilityGroups: [
      {
        id: 'general',
        title: '💬 通用助手',
        description: '经营数据分析与决策支持',
        sections: [{
          title: '分析能力',
          items: [
            { id: 'g1', groupKey: 'general', label: '经营日报', icon: '📊', description: '今日经营数据汇总分析', prompt: '今天整体经营怎么样？入住率、RevPAR、收入这些关键数据帮我汇总一下' },
            { id: 'g2', groupKey: 'general', label: '收益趋势', icon: '📈', description: '最近一周收益分析', prompt: '最近一周收益有什么变化？帮我分析趋势，看看哪里有增长空间' },
            { id: 'g3', groupKey: 'general', label: '入住率诊断', icon: '🏨', description: '入住率偏低诊断', prompt: '当前入住率偏低，帮我诊断一下是什么原因，有什么改善建议' },
            { id: 'g4', groupKey: 'general', label: '异常预警', icon: '⚠️', description: '异常指标扫描', prompt: '帮我扫描一下，最近有没有哪些指标异常？超时订单、空置率、价格倒挂都帮我看看' },
            { id: 'g5', groupKey: 'general', label: '多店对比', icon: '📋', description: '各门店表现对比', prompt: '各门店最近表现怎么样？帮我对比一下，看哪家做得好、哪家需要关注' }
          ]
        }]
      },
      {
        id: 'operation',
        title: '🔧 运营管家',
        description: '日常房态管理和执行操作',
        sections: [
          {
            title: ' 查状态',
            items: [
              { id: 'o1', groupKey: 'operation', sectionKey: 'query', label: '状态概览', icon: '📊', description: '房态全量统计', prompt: '给我一个完整的房态概览：可售、在住、脏房、维修、锁房各多少间' },
              { id: 'o2', groupKey: 'operation', sectionKey: 'query', label: '今日到店', icon: '🛎️', description: '今日入住客人列表', prompt: '今天有哪些客人要入住？帮我列出来，有没有特殊需求的' },
              { id: 'o3', groupKey: 'operation', sectionKey: 'query', label: '今日离店', icon: '🚪', description: '今日退房客人列表', prompt: '今天哪些房间要退房？按时间排序帮我列一下，方便安排清洁' },
              { id: 'o4', groupKey: 'operation', sectionKey: 'query', label: '在住房间', icon: '🛏️', description: '在住房间详情', prompt: '现在有多少间在住的？分别在哪些楼层？有没有快到退房时间还没退的' },
              { id: 'o5', groupKey: 'operation', sectionKey: 'query', label: '脏房列表', icon: '🧹', description: '脏房清洁优先级', prompt: '目前有多少间脏房？分布在哪些楼层？帮我按退房时间排清洁优先级' },
              { id: 'o6', groupKey: 'operation', sectionKey: 'query', label: '锁房列表', icon: '🔒', description: '锁房原因分析', prompt: '当前锁了哪些房间？什么原因锁的？锁了多久了？' },
              { id: 'o7', groupKey: 'operation', sectionKey: 'query', label: '维修列表', icon: '🔧', description: '维修中房间详情', prompt: '哪些房间在维修中？分别什么问题？预计什么时候能恢复？' },
              { id: 'o8', groupKey: 'operation', sectionKey: 'query', label: '预订查询', icon: '📅', description: '最近预订趋势', prompt: '最近一周有哪些预订？帮我看看预订趋势和空房率' },
              { id: 'o9', groupKey: 'operation', sectionKey: 'query', label: '超时订单', icon: '⚡', description: 'OTA超时订单处理', prompt: 'OTA渠道有没有超时未确认的订单？哪些最紧急需要马上处理？' }
            ]
          },
          {
            title: ' 执行操作',
            items: [
              { id: 'o10', groupKey: 'operation', sectionKey: 'action', label: '办理入住', icon: '✅', description: '客人快速入住', prompt: '帮我办理入住，需要告诉我房号和客人姓名' },
              { id: 'o11', groupKey: 'operation', sectionKey: 'action', label: '办理退房', icon: '👋', description: '客人快速退房', prompt: '帮我办理退房，告诉我哪个房间需要退' },
              { id: 'o12', groupKey: 'operation', sectionKey: 'action', label: '换房', icon: '🔄', description: '房间互换操作', prompt: '客人需要换房，帮我把客人从当前房间换到新房间' },
              { id: 'o13', groupKey: 'operation', sectionKey: 'action', label: '续住', icon: '⏰', description: '延长离店日期', prompt: '这个房间的客人要续住，帮我把离店日期往后延' },
              { id: 'o14', groupKey: 'operation', sectionKey: 'action', label: '预订新房', icon: '📝', description: '新客预订登记', prompt: '有新客人要预订，帮我登记一下房号、客人姓名和入住日期' },
              { id: 'o15', groupKey: 'operation', sectionKey: 'action', label: '取消预订', icon: '❌', description: '预订取消处理', prompt: '这个预订需要取消，帮我处理一下' },
              { id: 'o16', groupKey: 'operation', sectionKey: 'action', label: '修改预订', icon: '✏️', description: '预订信息变更', prompt: '这个预订信息有变动，帮我修改一下' },
              { id: 'o17', groupKey: 'operation', sectionKey: 'action', label: '锁房', icon: '🔒', description: '暂停房间售卖', prompt: '这个房间需要锁起来暂停售卖，帮我锁一下' },
              { id: 'o18', groupKey: 'operation', sectionKey: 'action', label: '开房', icon: '🔓', description: '恢复房间售卖', prompt: '这个锁着的房间可以重新卖了，帮我解锁恢复' },
              { id: 'o19', groupKey: 'operation', sectionKey: 'action', label: '标记干净', icon: '🧹', description: '清洁完成标记', prompt: '这个房间打扫完了，帮我标记为干净可入住' },
              { id: 'o20', groupKey: 'operation', sectionKey: 'action', label: '标记脏房', icon: '🗑️', description: '退房待清洁标记', prompt: '这个房间退房了需要打扫，帮我标记为脏房' },
              { id: 'o21', groupKey: 'operation', sectionKey: 'action', label: '维修挂起', icon: '🔧', description: '房间维修标记', prompt: '这个房间出问题了需要维修，帮我标记为维修中' }
            ]
          }
        ]
      },
      {
        id: 'customer',
        title: ' 客户管家',
        description: '客户关系管理和精准营销',
        sections: [{
          title: '客户管理',
          items: [
            { id: 'c1', groupKey: 'customer', label: '客户总览', icon: '👤', description: '客户库整体分析', prompt: '帮我看看客户库的整体情况，VIP占比、复购率怎么样' },
            { id: 'c2', groupKey: 'customer', label: '沉睡客户', icon: '😴', description: '90天未入住客户', prompt: '哪些客户很久没来了？帮我找出超过90天的，看看怎么激活他们' },
            { id: 'c3', groupKey: 'customer', label: 'VIP管理', icon: '⭐', description: 'VIP客户分析', prompt: 'VIP客户最近入住情况怎么样？有没有快流失的？有没有可以升级的？' },
            { id: 'c4', groupKey: 'customer', label: '客户关怀', icon: '💌', description: '关怀方案推荐', prompt: '帮我看看本周应该重点关怀哪些客户，给个具体方案' },
            { id: 'c5', groupKey: 'customer', label: '营销策略', icon: '📢', description: '分层营销方案', prompt: '下个月营销怎么做？帮我按客户分层出个方案' }
          ]
        }, {
          title: '营销工具',
          items: [
            { id: 'v1', groupKey: 'customer', label: '短视频脚本', icon: '🎬', description: '一键生成高转化短视频脚本', prompt: '', url: '/pages/video-script/index' }
          ]
        }]
      }
    ] as CapabilityGroup[],
    prompts: [
      { id: 'g1', scene: 'general', label: '今日营业', icon: '📊', prompt: '帮我看看今天的营业情况' },
      { id: 'g2', scene: 'general', label: '房态总览', icon: '🏨', prompt: '当前房态怎么样' },
      { id: 'g3', scene: 'general', label: '订单汇总', icon: '📋', prompt: '统计最近的订单' },
      { id: 'o1', scene: 'operation', label: '办理入住', icon: '🛎️', prompt: '办理入住' },
      { id: 'o2', scene: 'operation', label: '办理退房', icon: '👋', prompt: '办理退房' },
      { id: 'o3', scene: 'operation', label: '换房', icon: '🔄', prompt: '换房' },
      { id: 'o4', scene: 'operation', label: '锁房', icon: '🔒', prompt: '锁定房间' },
      { id: 'c1', scene: 'customer', label: '搜索客户', icon: '🔍', prompt: '查找客户信息' },
      { id: 'c2', scene: 'customer', label: '客户画像', icon: '👥', prompt: '分析客户群体' },
      { id: 'c3', scene: 'customer', label: 'VIP 管理', icon: '💎', prompt: '显示 VIP 客户' }
    ] as AIPrompt[]
  }),
  getters: {
    currentMessages: (s) => s.sessions[s.currentScene],
    scenePrompts: (s) => s.prompts.filter(p => p.scene === s.currentScene),
    availableScenes: () => [
      { key: 'operation' as AIScene, label: '🔧 运营管家' },
      { key: 'general' as AIScene, label: '💬 通用助手' },
      { key: 'customer' as AIScene, label: '👥 客户管家' }
    ],
    currentGroup: (s) => s.capabilityGroups.find(g => g.id === s.currentScene),
    getActiveCards: (s) => {
      const group = s.capabilityGroups.find(g => g.id === s.currentScene)
      if (!group) return []
      return group.sections.flatMap(sec => sec.items)
    }
  },
  actions: {
    setViewMode(mode: 'workbench' | 'chat') { this.viewMode = mode },
    setScene(scene: AIScene) { this.currentScene = scene },
    setActiveCard(card: CapabilityCard) {
      this.activeCardId = card.id
      this.currentScene = card.groupKey
      this.viewMode = 'chat'
    },
    backToWorkbench() {
      this.viewMode = 'workbench'
      this.activeCardId = ''
    },
    addMessage(message: AIMessage) { this.sessions[this.currentScene].push(message) },
    appendContent(id: string, content: string) {
      const msg = this.sessions[this.currentScene].find(m => m.id === id)
      if (msg) msg.content += content
    },
    clearCurrentSession() { this.sessions[this.currentScene] = [] },
    setLoading(v: boolean) { this.loading = v },
    setStreaming(v: boolean) { this.streaming = v },
    setProgressHint(v: string) { this.progressHint = v },
    setModel(model: string, label: string) {
      this.currentModel = model
      this.currentModelLabel = label
    },
    setModelLoading(v: boolean) { this.modelLoading = v }
  }
})
