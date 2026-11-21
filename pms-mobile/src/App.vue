<script setup lang="ts">
import { onLaunch, onShow, onHide } from '@dcloudio/uni-app'
import { useAuthStore } from '@/stores/auth'

const authStore = useAuthStore()

onLaunch(() => {
  console.log('App Launch')
  authStore.initFromStorage()
})

onShow(() => {
  console.log('App Show')
})

onHide(() => {
  console.log('App Hide')
})
</script>

<style lang="scss">
@import '@/uni.scss';

/* 全局样式已由 uni.scss 统一管理，此处仅保留 App 级样式覆盖 */
</style>