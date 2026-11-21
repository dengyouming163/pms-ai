<script setup lang="ts">
import { computed } from 'vue'
import { useAIStore } from '@/stores/ai'
import type { CapabilityCard } from '@/types/ai'
import CapabilityGroup from './CapabilityGroup.vue'

const aiStore = useAIStore()

const currentGroup = computed(() =>
  aiStore.capabilityGroups.find(g => g.id === aiStore.currentScene)
)

const emit = defineEmits<{
  selectCard: [card: CapabilityCard]
}>()

function handleSelectCard(card: CapabilityCard) {
  if (card.url) {
    // 跳转型卡片：不切到对话视图，交由父组件 navigateTo
    emit('selectCard', card)
    return
  }
  aiStore.setActiveCard(card)
  emit('selectCard', card)
}
</script>

<template>
  <view class="workbench">
    <view v-if="currentGroup" class="workbench-content">
      <view class="welcome-header">
        <text class="welcome-icon">✨</text>
        <text class="welcome-text">你好，我是 {{ currentGroup.title.replace(/^[^\s]+\s/, '') }}</text>
        <text class="welcome-sub">{{ currentGroup.description }}</text>
      </view>
      <CapabilityGroup
        :group="currentGroup"
        @select="handleSelectCard"
      />
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.workbench { padding: 0; }
.welcome-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  padding: 24rpx 28rpx;
  background: linear-gradient(135deg, rgba(7,193,96,0.08) 0%, rgba(200,169,126,0.08) 100%);
  border-radius: $radius-xl;
  margin-bottom: 20rpx;
}
.welcome-icon { font-size: 48rpx; margin-bottom: 8rpx; }
.welcome-text { font-size: 30rpx; font-weight: 600; color: $text-primary; margin-bottom: 4rpx; }
.welcome-sub { font-size: 26rpx; color: $text-secondary; }
</style>