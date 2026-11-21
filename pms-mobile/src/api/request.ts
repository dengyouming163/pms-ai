import config from '@/config/index'

export interface ApiResponse<T = any> {
    code: number
    show: number
    msg: string
    data: T
}

const { BASE_URL, APP_VERSION } = config

// ===== 网络请求守卫：未登录(401)统一跳转登录页 =====
let isRedirectingToLogin = false

/** 401 守卫：清除 token 并跳转登录页（防重：多个并发 401 只跳转一次） */
function handleUnauthorized() {
    if (isRedirectingToLogin) return
    isRedirectingToLogin = true
    uni.showToast({ title: '登录已过期，请重新登录', icon: 'none' })
    try { uni.removeStorageSync('token') } catch {}
    setTimeout(() => {
        isRedirectingToLogin = false
        uni.reLaunch({ url: '/pages/login/index' })
    }, 800)
}

interface RequestOptions {
    url: string
    data?: any
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE'
    header?: any
    showLoading?: boolean
    showError?: boolean
    timeout?: number // 请求超时 ms，缺省用平台默认（H5/小程序约 60s）；短视频脚本长任务传 180000
}

/**
 * URL 解析 — 统一拼接 BASE_URL
 * 生产服务器支持 CORS，H5 和 APP 均直接请求生产地址
 */
function resolveUrl(url: string): string {
    if (url.startsWith('http://') || url.startsWith('https://')) {
        return url
    }
    return BASE_URL + url
}

function getToken(): string {
    try {
        return uni.getStorageSync('token') || ''
    } catch {
        return ''
    }
}

function getStoreId(): number | string | null {
    try {
        const currentStore = uni.getStorageSync('currentStore')
        if (currentStore && currentStore.id) return currentStore.id
        const cached = uni.getStorageSync('storeId')
        if (cached) return cached
        const userInfo = uni.getStorageSync('userInfo')
        if (userInfo && userInfo.storeId) return userInfo.storeId
        return null
    } catch {
        return null
    }
}

export function request<T = any>(options: RequestOptions): Promise<T> {
    let { url, data = {}, method = 'GET', header = {}, showLoading = true, showError = true, timeout } = options

    return new Promise((resolve, reject) => {
        if (showLoading) {
            uni.showLoading({ title: 'Loading...', mask: true })
        }

        const token = getToken()
        const headers: any = {
            'Content-Type': 'application/json',
            ...header
        }

        if (token) {
            headers['Authorization'] = `Bearer ${token}`
        }

        // 注入门店上下文 — X-Store-Id Header（与 pms-web 对齐，服务端 tenantMiddleware 从此读取）
        const storeId = getStoreId()
        if (storeId && !url.includes('/api/auth/')) {
            headers['X-Store-Id'] = String(storeId)
        }

        // 同时保留 query/body 注入以兼容部分路由 handler 的自行读取
        const hasStoreId = data && (data.store_id !== undefined || data.storeId !== undefined)
        if (storeId && !hasStoreId && !url.includes('/api/auth/')) {
            if (method === 'GET') {
                const separator = url.includes('?') ? '&' : '?'
                url += `${separator}store_id=${storeId}`
            } else {
                data = { ...data, store_id: storeId }
            }
        }

        uni.request({
            url: resolveUrl(url),
            data,
            method,
            header: headers,
            timeout,
            success: (res: any) => {
                if (showLoading) {
                    uni.hideLoading()
                }

                // HTTP 状态码错误处理
                const statusCode = res.statusCode
                if (statusCode === 401) {
                    // 网络请求守卫：统一处理未登录（清除 token + 跳转登录，防重）
                    handleUnauthorized()
                    reject({ code: 401, message: 'Unauthorized' })
                    return
                }
                if (statusCode === 403) {
                    if (showError) {
                        uni.showToast({ title: '没有权限执行此操作', icon: 'none' })
                    }
                    reject({ code: 403, message: 'Forbidden' })
                    return
                }
                if (statusCode === 404) {
                    if (showError) {
                        uni.showToast({ title: '请求的资源不存在', icon: 'none' })
                    }
                    reject({ code: 404, message: 'Not Found' })
                    return
                }
                if (statusCode >= 500) {
                    if (showError) {
                        uni.showToast({ title: '服务器繁忙，请稍后重试', icon: 'none' })
                    }
                    reject({ code: statusCode, message: 'Server Error' })
                    return
                }

                const response = res.data as any

                // 业务级错误（success: false）
                if (response && response.success === false) {
                    if (showError && response.error) {
                        uni.showToast({ title: response.error, icon: 'none' })
                    }
                    reject(response)
                    return
                }

                // 兼容两种响应格式：
                //   { code, data: {...} } → 取 response.data
                //   { list, total, ... }  → 取 response 本身
                // 用 ?? 同时处理 null 和 undefined
                const result = (response && response.data != null) ? response.data : response
                resolve(result as T)
            },
            fail: (err: any) => {
                if (showLoading) {
                    uni.hideLoading()
                }

                if (showError) {
                    uni.showToast({ title: 'Network request failed', icon: 'none' })
                }
                reject(err)
            }
        })
    })
}

export function get<T = any>(url: string, data?: any, options?: Partial<RequestOptions>): Promise<T> {
    return request<T>({
        url,
        data,
        method: 'GET',
        ...options
    })
}

export function post<T = any>(url: string, data?: any, options?: Partial<RequestOptions>): Promise<T> {
    return request<T>({
        url,
        data,
        method: 'POST',
        ...options
    })
}

export function put<T = any>(url: string, data?: any, options?: Partial<RequestOptions>): Promise<T> {
    return request<T>({
        url,
        data,
        method: 'PUT',
        ...options
    })
}

export function del<T = any>(url: string, data?: any, options?: Partial<RequestOptions>): Promise<T> {
    return request<T>({
        url,
        data,
        method: 'DELETE',
        ...options
    })
}

export function uploadFile(url: string, filePath: string, name: string = 'file', formData?: any): Promise<any> {
    return new Promise((resolve, reject) => {
        uni.showLoading({ title: 'Uploading...', mask: true })

        const token = getToken()
        const storeId = getStoreId()

        uni.uploadFile({
            url: resolveUrl(url),
            filePath,
            name,
            formData: formData as any,
            header: {
                Authorization: token ? `Bearer ${token}` : '',
                ...(storeId ? { 'X-Store-Id': String(storeId) } : {}),
            },
            success: (res: any) => {
                uni.hideLoading()
                if (res.data) {
                    try {
                        const data = JSON.parse(res.data)
                        if (data && (data.code === 1 || data.success)) {
                            resolve(data.url || data.data)
                        } else {
                            uni.showToast({ title: (data && data.msg) || 'Upload failed', icon: 'none' })
                            reject(data)
                        }
                    } catch {
                        uni.showToast({ title: 'Parse failed', icon: 'none' })
                        reject(res.data)
                    }
                } else {
                    uni.showToast({ title: 'Upload failed', icon: 'none' })
                    reject(res)
                }
            },
            fail: (err: any) => {
                uni.hideLoading()
                uni.showToast({ title: 'Upload failed', icon: 'none' })
                reject(err)
            }
        })
    })
}
