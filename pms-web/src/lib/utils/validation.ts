export interface ValidationRule {
  required?: boolean;
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  message: string;
}

export interface ValidationErrors {
  [key: string]: string;
}

export function validateField(value: string, rules: ValidationRule[]): string {
  for (const rule of rules) {
    if (rule.required && !value.trim()) {
      return rule.message;
    }
    if (rule.minLength && value.length < rule.minLength) {
      return rule.message;
    }
    if (rule.maxLength && value.length > rule.maxLength) {
      return rule.message;
    }
    if (rule.pattern && value && !rule.pattern.test(value)) {
      return rule.message;
    }
  }
  return '';
}

export function validateForm(
  data: Record<string, string>,
  rules: Record<string, ValidationRule[]>
): ValidationErrors {
  const errors: ValidationErrors = {};
  for (const [field, fieldRules] of Object.entries(rules)) {
    const error = validateField(data[field] || '', fieldRules);
    if (error) {
      errors[field] = error;
    }
  }
  return errors;
}

// 常用规则预设
export const commonRules = {
  required: (label: string): ValidationRule => ({
    required: true,
    message: `请输入${label}`,
  }),
  phone: (): ValidationRule => ({
    pattern: /^1[3-9]\d{9}$/,
    message: '请输入正确的手机号',
  }),
  email: (): ValidationRule => ({
    pattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    message: '请输入正确的邮箱地址',
  }),
  minLength: (len: number, label: string): ValidationRule => ({
    minLength: len,
    message: `${label}至少${len}个字符`,
  }),
  maxLength: (len: number, label: string): ValidationRule => ({
    maxLength: len,
    message: `${label}最多${len}个字符`,
  }),
  number: (label: string): ValidationRule => ({
    pattern: /^\d+(\.\d+)?$/,
    message: `${label}必须为数字`,
  }),
  positiveNumber: (label: string): ValidationRule => ({
    pattern: /^[1-9]\d*(\.\d+)?$/,
    message: `${label}必须为正数`,
  }),
};

// 手机号格式校验（中国大陆 11 位，1 开头）
export function isValidPhone(phone: string): boolean {
  return /^1[3-9]\d{9}$/.test(phone);
}

// 身份证格式校验（18 位，含校验位）
export function isValidIdCard(idCard: string): boolean {
  if (!/^\d{17}[\dXx]$/.test(idCard)) return false;
  // 校验位算法
  const weights = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
  const checkMap = ['1', '0', 'X', '9', '8', '7', '6', '5', '4', '3', '2'];
  const sum = weights.reduce((acc, w, i) => acc + w * parseInt(idCard[i], 10), 0);
  return checkMap[sum % 11] === idCard[17].toUpperCase();
}

// 日期合法性校验（endDate > startDate，格式 YYYY-MM-DD）
export function isValidDateRange(startDate: string, endDate: string): { valid: boolean; error: string } {
  if (!startDate || !endDate) return { valid: false, error: '请填写完整日期' };
  const start = new Date(startDate);
  const end = new Date(endDate);
  if (isNaN(start.getTime()) || isNaN(end.getTime())) return { valid: false, error: '日期格式无效' };
  if (end <= start) return { valid: false, error: '离店日期必须晚于入住日期' };
  return { valid: true, error: '' };
}

// 表单字段必填校验
export function validateRequired(value: string, fieldName: string): { valid: boolean; error: string } {
  if (!value || !value.trim()) return { valid: false, error: `请输入${fieldName}` };
  return { valid: true, error: '' };
}
