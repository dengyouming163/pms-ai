// src/api/modules/assets.ts
import { get, post, put, del } from '@/api/request'

// ===== 素材 =====
export function fetchAssets(params?: Record<string, any>): Promise<any> {
  return get('/api/assets', params)
}
export function createAsset(data: Record<string, any>): Promise<any> {
  return post('/api/assets', data)
}
export function patchAsset(id: string | number, data: Record<string, any>): Promise<any> {
  return put(`/api/assets/${id}`, data)
}
export function deleteAsset(id: string | number): Promise<any> {
  return del(`/api/assets/${id}`)
}

// ===== 拍摄模板 =====
export function fetchTemplates(): Promise<any> {
  return get('/api/assets/templates')
}
export function createTemplate(data: Record<string, any>): Promise<any> {
  return post('/api/assets/templates', data)
}
export function updateTemplate(id: string, data: Record<string, any>): Promise<any> {
  return put(`/api/assets/templates/${id}`, data)
}
export function deleteTemplate(id: string): Promise<any> {
  return del(`/api/assets/templates/${id}`)
}

// ===== 打卡任务 =====
export function fetchTasks(params?: Record<string, any>): Promise<any> {
  return get('/api/tasks', params)
}
export function fetchTaskDetail(id: string): Promise<any> {
  return get(`/api/tasks/${id}`)
}
export function createTask(data: Record<string, any>): Promise<any> {
  return post('/api/tasks', data)
}
export function submitTask(id: string, data: Record<string, any>): Promise<any> {
  return post(`/api/tasks/${id}/submit`, data)
}
export function fetchTaskStats(id: string): Promise<any> {
  return get(`/api/tasks/${id}/statistics`)
}

// ===== 自动化任务规则 =====
export function fetchTaskRules(): Promise<any> {
  return get('/api/task-rules')
}
export function createTaskRule(data: Record<string, any>): Promise<any> {
  return post('/api/task-rules', data)
}
export function updateTaskRule(id: string, data: Record<string, any>): Promise<any> {
  return put(`/api/task-rules/${id}`, data)
}
export function setTaskRuleStatus(id: string, status: string): Promise<any> {
  return put(`/api/task-rules/${id}/status`, { status })
}
export function deleteTaskRule(id: string): Promise<any> {
  return del(`/api/task-rules/${id}`)
}

// ===== 系统模板库 =====
export function fetchSystemTemplates(): Promise<any> {
  return get('/api/assets/templates/system')
}
export function importSystemTemplate(systemTemplateId: string): Promise<any> {
  return post('/api/assets/templates/import', { systemTemplateId })
}
