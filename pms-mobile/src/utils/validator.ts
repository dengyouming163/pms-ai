export interface ValidationRule {
  required?: boolean
  message?: string
  pattern?: RegExp
  validator?: (value: any) => boolean | string
  min?: number
  max?: number
}

export interface ValidationResult {
  valid: boolean
  message?: string
}

export const Validator = {
  isPhone: (phone: string): boolean => {
    return /^1[3-9]\d{9}$/.test(phone)
  },

  isPassword: (password: string): boolean => {
    return password && password.length >= 6
  },

  isNotEmpty: (value: any): boolean => {
    if (value === null || value === undefined) return false
    if (typeof value === 'string') return value.trim() !== ''
    if (Array.isArray(value)) return value.length > 0
    return true
  },

  validate: (value: any, rules: ValidationRule[]): ValidationResult => {
    for (const rule of rules) {
      if (rule.required && !Validator.isNotEmpty(value)) {
        return {
          valid: false,
          message: rule.message || '该项为必填项'
        }
      }

      if (rule.pattern && value && !rule.pattern.test(value)) {
        return {
          valid: false,
          message: rule.message || '格式不正确'
        }
      }

      if (rule.validator) {
        const result = rule.validator(value)
        if (typeof result === 'string') {
          return { valid: false, message: result }
        }
        if (!result) {
          return { valid: false, message: rule.message || '验证失败' }
        }
      }

      if (rule.min !== undefined && value && value.length < rule.min) {
        return {
          valid: false,
          message: rule.message || `最少${rule.min}个字符`
        }
      }

      if (rule.max !== undefined && value && value.length > rule.max) {
        return {
          valid: false,
          message: rule.message || `最多${rule.max}个字符`
        }
      }
    }

    return { valid: true }
  }
}

export const phoneRules: ValidationRule[] = [
  { required: true, message: '请输入手机号' },
  { pattern: /^1[3-9]\d{9}$/, message: '请输入正确的手机号' }
]

export const passwordRules: ValidationRule[] = [
  { required: true, message: '请输入密码' },
  { min: 6, message: '密码至少6个字符' }
]
