/**
 * 跨平台日期选择器
 * App/小程序使用 uni.showDatePicker，H5 降级为原生 input[type=date]
 */
export function useDatePicker() {
  /**
   * 选择单个日期
   * @param defaultValue 默认日期 (YYYY-MM-DD)
   * @returns 选中的日期 (YYYY-MM-DD)，取消返回 null
   */
  function pickDate(defaultValue?: string): Promise<string | null> {
    return new Promise((resolve) => {
      // uni.showDatePicker 在 H5 不可用，使用原生 input
      // #ifdef H5
      const input = document.createElement('input')
      input.type = 'date'
      if (defaultValue) input.value = defaultValue
      input.style.position = 'fixed'
      input.style.top = '-100px'
      input.style.left = '0'
      input.style.opacity = '0'
      input.style.pointerEvents = 'none'
      document.body.appendChild(input)

      // 兼容移动端 H5
      input.addEventListener('change', () => {
        document.body.removeChild(input)
        resolve(input.value || null)
      })
      input.addEventListener('blur', () => {
        setTimeout(() => {
          if (document.body.contains(input)) {
            document.body.removeChild(input)
            resolve(null)
          }
        }, 200)
      })

      // 触发原生日期选择器
      setTimeout(() => input.click(), 100)
      // #endif

      // #ifndef H5
      uni.showDatePicker({
        value: defaultValue,
        success: (res: any) => {
          resolve(res.value || res.date || null)
        },
        fail: () => {
          resolve(null)
        }
      })
      // #endif
    })
  }

  /**
   * 选择日期范围
   * @returns { startDate, endDate } 或 null
   */
  function pickDateRange(): Promise<{ startDate: string; endDate: string } | null> {
    return new Promise((resolve) => {
      // #ifdef H5
      // H5 降级：依次选择开始和结束日期
      pickDate().then((start) => {
        if (!start) return resolve(null)
        pickDate(start).then((end) => {
          if (!end) return resolve(null)
          resolve({ startDate: start, endDate: end })
        })
      })
      // #endif

      // #ifndef H5
      uni.showDatePicker({
        mode: 'range',
        success: (res: any) => {
          if (res.startDate && res.endDate) {
            resolve({ startDate: res.startDate, endDate: res.endDate })
          } else {
            resolve(null)
          }
        },
        fail: () => {
          resolve(null)
        }
      })
      // #endif
    })
  }

  return { pickDate, pickDateRange }
}
