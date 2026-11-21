import { ENV } from './env'

export default {
  BASE_URL: ENV.PMS_SERVER_URL,
  APP_VERSION: '1.0.0',
  ...ENV
}
