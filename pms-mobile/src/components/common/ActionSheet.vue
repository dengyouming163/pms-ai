<script setup lang="ts">
import { ref, watch } from 'vue'

interface Action { label: string; icon?: string; type?: 'primary' | 'danger' | 'default'; disabled?: boolean }
interface Props { visible: boolean; title?: string; actions: Action[]; showCancel?: boolean }
const props = withDefaults(defineProps<Props>(), { title: '', showCancel: true })

const emit = defineEmits<{ select: [index: number]; cancel: []; close: [] }>()
const show = ref(false)
watch(() => props.visible, (v) => { show.value = v })
function handleSelect(index: number, action: Action) { if (!action.disabled) { emit('select', index); emit('close') } }
function handleCancel() { emit('cancel'); emit('close') }
</script>

<template>
  <view v-if="show" class="mask" @click="emit('close')">
    <view class="sheet-container" @click.stop>
      <view v-if="title" class="sheet-title">{{ title }}</view>
      <view class="actions-list">
        <view v-for="(action, index) in actions" :key="index"
              :class="['action-item', action.type, { disabled: action.disabled }]"
              @click="handleSelect(index, action)">
          <text v-if="action.icon" class="action-icon">{{ action.icon }}</text>
          <text class="action-label">{{ action.label }}</text>
        </view>
      </view>
      <view v-if="showCancel" class="cancel-item" @click="handleCancel">
        <text class="cancel-label">取消</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';
.mask { position: fixed; inset: 0; background: rgba(0, 0, 0, 0.5); z-index: 2000; display: flex; align-items: flex-end; }
.sheet-container { width: 100%; background: #fff; border-radius: 48rpx 48rpx 0 0; padding: 32rpx 0; padding-bottom: env(safe-area-inset-bottom); }
.sheet-title { text-align: center; font-size: 28rpx; color: $text-tertiary; padding: 16rpx 32rpx 32rpx; }
.action-item { display: flex; align-items: center; justify-content: center; padding: 32rpx; font-size: 32rpx; border-bottom: 1rpx solid $bg-main; &.primary { color: $primary-green; font-weight: 500; } &.danger { color: $price-red; } &.disabled { opacity: 0.5; } }
.action-icon { margin-right: 16rpx; }
.cancel-item { padding: 32rpx; text-align: center; margin-top: 16rpx; }
.cancel-label { font-size: 32rpx; color: $text-secondary; }
</style>