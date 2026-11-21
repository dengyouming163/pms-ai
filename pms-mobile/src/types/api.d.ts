// API 响应基础结构
export interface ApiResponse<T = any> {
  code: number
  message: string
  data: T
}

// 分页参数
export interface PaginationParams {
  page: number
  pageSize: number
}

// 分页响应
export interface PaginatedResponse<T> {
  list: T[]
  total: number
  page: number
  pageSize: number
}

// API 错误处理
export class ApiError extends Error {
  code: number
  constructor(message: string, code: number = -1) {
    super(message)
    this.code = code
  }
}
