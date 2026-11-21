import { ref } from 'vue'
import { ENV } from '@/config/env'

export interface IDCardInfo {
  name?: string
  sex?: string
  nation?: string
  birth?: string
  address?: string
  idCardNumber?: string
  authority?: string
  validDate?: string
  cardType?: 'front' | 'back'
}

export interface BusinessLicenseInfo {
  registrationNumber?: string
  companyName?: string
  companyType?: string
  address?: string
  registeredCapital?: string
  paidCapital?: string
  businessScope?: string
  legalPerson?: string
  establishmentDate?: string
  validityPeriod?: string
}

export interface OCRResult<T> {
  success: boolean
  data?: T
  error?: {
    code: string
    message: string
  }
}

export interface OCRError {
  code: string
  message: string
}

export type IDCardSide = 'front' | 'back'

export function useOCR() {
  const isRecognizing = ref(false)
  const error = ref<OCRError | null>(null)
  const progress = ref(0)

  const chooseImage = (): Promise<string> => {
    return new Promise((resolve, reject) => {
      uni.chooseImage({
        count: 1,
        sizeType: ['compressed'],
        sourceType: ['album', 'camera'],
        success: (res) => {
          if (res.tempFilePaths && res.tempFilePaths.length > 0) {
            resolve(res.tempFilePaths[0])
          } else {
            reject(new Error('未选择图片'))
          }
        },
        fail: (err) => {
          reject(err)
        }
      })
    })
  }

  const uploadAndRecognize = async <T>(
    imagePath: string,
    apiEndpoint: string,
    formData: Record<string, any> = {}
  ): Promise<OCRResult<T>> => {
    try {
      isRecognizing.value = true
      progress.value = 0
      error.value = null

      const token = uni.getStorageSync('token')

      const uploadResult = await new Promise<any>((resolve, reject) => {
        uni.uploadFile({
          url: `${ENV.PMS_SERVER_URL}${apiEndpoint}`,
          filePath: imagePath,
          name: 'image',
          header: {
            'Authorization': `Bearer ${token}`
          },
          formData: {
            secretId: ENV.TENCENT_SECRET_ID,
            ...formData
          },
          success: (res) => {
            progress.value = 100
            if (res.statusCode === 200) {
              try {
                const data = JSON.parse(res.data)
                resolve(data)
              } catch (e) {
                reject(new Error('解析响应失败'))
              }
            } else {
              reject(new Error(`请求失败: ${res.statusCode}`))
            }
          },
          fail: (err) => {
            reject(new Error(err.errMsg || '上传失败'))
          }
        })
      })

      if (uploadResult.code === 0 && uploadResult.data) {
        return {
          success: true,
          data: uploadResult.data as T
        }
      } else {
        error.value = {
          code: 'OCR_ERROR',
          message: uploadResult.message || '识别失败'
        }
        return {
          success: false,
          error: error.value
        }
      }
    } catch (e: any) {
      error.value = {
        code: 'NETWORK_ERROR',
        message: e.message || '网络错误'
      }
      return {
        success: false,
        error: error.value
      }
    } finally {
      isRecognizing.value = false
      progress.value = 0
    }
  }

  const recognizeIDCard = async (
    imagePath: string,
    cardSide: IDCardSide = 'front'
  ): Promise<OCRResult<IDCardInfo>> => {
    const sideMap = {
      front: 0,
      back: 1
    }

    return uploadAndRecognize<IDCardInfo>(
      imagePath,
      '/api/tencent/ocr/idcard',
      {
        cardType: sideMap[cardSide]
      }
    )
  }

  const recognizeIDCardWithChoose = async (
    cardSide: IDCardSide = 'front'
  ): Promise<OCRResult<IDCardInfo>> => {
    try {
      const imagePath = await chooseImage()
      return await recognizeIDCard(imagePath, cardSide)
    } catch (e: any) {
      if (e.errMsg?.includes('cancel')) {
        return {
          success: false,
          error: {
            code: 'USER_CANCEL',
            message: '用户取消选择'
          }
        }
      }
      error.value = {
        code: 'CHOOSE_ERROR',
        message: e.message || '选择图片失败'
      }
      return {
        success: false,
        error: error.value
      }
    }
  }

  const recognizeBusinessLicense = async (
    imagePath: string
  ): Promise<OCRResult<BusinessLicenseInfo>> => {
    return uploadAndRecognize<BusinessLicenseInfo>(
      imagePath,
      '/api/tencent/ocr/businesslicense'
    )
  }

  const recognizeBusinessLicenseWithChoose = async (): Promise<OCRResult<BusinessLicenseInfo>> => {
    try {
      const imagePath = await chooseImage()
      return await recognizeBusinessLicense(imagePath)
    } catch (e: any) {
      if (e.errMsg?.includes('cancel')) {
        return {
          success: false,
          error: {
            code: 'USER_CANCEL',
            message: '用户取消选择'
          }
        }
      }
      error.value = {
        code: 'CHOOSE_ERROR',
        message: e.message || '选择图片失败'
      }
      return {
        success: false,
        error: error.value
      }
    }
  }

  const recognizeGeneral = async (
    imagePath: string
  ): Promise<OCRResult<any>> => {
    return uploadAndRecognize<any>(
      imagePath,
      '/api/tencent/ocr/general'
    )
  }

  const recognizeWithCamera = async (
    OCRType: 'idcard' | 'businesslicense' = 'idcard',
    cardSide: IDCardSide = 'front'
  ): Promise<OCRResult<IDCardInfo | BusinessLicenseInfo>> => {
    try {
      const imagePath = await new Promise<string>((resolve, reject) => {
        uni.chooseImage({
          count: 1,
          sizeType: ['compressed'],
          sourceType: ['camera'],
          success: (res) => {
            if (res.tempFilePaths && res.tempFilePaths.length > 0) {
              resolve(res.tempFilePaths[0])
            } else {
              reject(new Error('未拍摄图片'))
            }
          },
          fail: (err) => {
            reject(err)
          }
        })
      })

      if (OCRType === 'idcard') {
        return await recognizeIDCard(imagePath, cardSide)
      } else {
        return await recognizeBusinessLicense(imagePath)
      }
    } catch (e: any) {
      if (e.errMsg?.includes('cancel')) {
        return {
          success: false,
          error: {
            code: 'USER_CANCEL',
            message: '用户取消拍摄'
          }
        }
      }
      error.value = {
        code: 'CAMERA_ERROR',
        message: e.message || '拍摄失败'
      }
      return {
        success: false,
        error: error.value
      }
    }
  }

  const clearError = () => {
    error.value = null
  }

  return {
    isRecognizing,
    error,
    progress,
    recognizeIDCard,
    recognizeIDCardWithChoose,
    recognizeBusinessLicense,
    recognizeBusinessLicenseWithChoose,
    recognizeGeneral,
    recognizeWithCamera,
    chooseImage,
    clearError
  }
}
