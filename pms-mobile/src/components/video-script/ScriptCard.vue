<script setup lang="ts">
import { computed, ref } from 'vue'
import { useVideoScriptStore } from '@/stores/video-script'
import { useVoice } from '@/composables/useVoice'

const store = useVideoScriptStore()
const { playVoice, stopVoice, isPlaying } = useVoice()

const pkg = computed(() => store.finalPackage)
const script = computed(() => pkg.value?.approved_script)
const storyboard = computed(() => pkg.value?.storyboard_prompts?.storyboard || [])
const characters = computed(() => pkg.value?.character_assets || [])
const scenes = computed(() => pkg.value?.scene_assets || [])
const compliance = computed(() => store.output.compliance_report)
const riskItems = computed(() => compliance.value?.risk_items || [])
const version = computed(() => pkg.value?.generation_params?.version || 'all')

const VERSION_LABEL: Record<string, string> = {
  '15s': '15 秒投流',
  '60s': '60 秒种草',
  '90s': '90 秒深度',
  all: '完整生产包',
}

/** 卖点可能是数组或字符串，统一成数组 */
const sellingPoints = computed(() => {
  const sp = script.value?.selling_points
  if (!sp) return []
  if (Array.isArray(sp)) return sp as string[]
  return [sp as string]
})

const showAssets = ref(false)
const showCompliance = ref(false)

/** 资产卡渲染辅助：字段可能是对象/长文，只取短字符串做一行展示 */
function short(v: unknown): string {
  return typeof v === 'string' ? v : ''
}
/** 人物名：后端 asset_package 用 character_name（人物卡核心标识，含角色人设） */
function charName(c: any, i: number): string {
  return short(c.character_name) || short(c.name) || `人物${i + 1}`
}
function charDesc(c: any): string {
  const d = short(c.appearance) || short(c.clothing)
  return d && d.length <= 80 ? d : ''
}
/** 场景名：后端 scene_assets 用 location（场景定位） */
function sceneName(s: any, i: number): string {
  return short(s.location) || short(s.name) || short(s.scene_name) || `场景${i + 1}`
}
function sceneDesc(s: any): string {
  const d = short(s.environment) || short(s.style)
  return d && d.length <= 80 ? d : ''
}

function copy(text: string, label = '内容') {
  uni.setClipboardData({
    data: text,
    success: () => uni.showToast({ title: `${label}已复制`, icon: 'success' }),
  })
}

function copyFull() {
  const s = script.value
  if (!s) return
  const shots = storyboard.value
    .map((sh, i) => `镜头${i + 1}（${sh.duration || ''}）：${sh.visual_description || ''}｜${sh.camera || ''}｜台词：${sh.dialogue || ''}`)
    .join('\n')
  copy(`${s.title || '短视频脚本'}\n\n【口播】\n${s.script}\n\n【分镜】\n${shots}`, '全文')
}

function readScript() {
  const s = script.value
  if (!s?.script) return
  if (isPlaying.value) {
    stopVoice()
    return
  }
  playVoice(s.script, `vs_${store.projectId}`).catch(() => {})
}

function restart() {
  stopVoice()
  store.reset()
}
</script>

<template>
  <view class="sc-page">
    <!-- 头部：标题 + 版本徽章 -->
    <view class="sc-header">
      <text class="sc-title">{{ script?.title || '短视频脚本' }}</text>
      <text class="sc-version">{{ VERSION_LABEL[version] || version }}</text>
    </view>

    <!-- 开头钩子 -->
    <view v-if="script?.text_hook" class="sc-hook">
      <text class="sc-hook-label">🎯 开头钩子</text>
      <text class="sc-hook-text">{{ script.text_hook }}</text>
    </view>

    <!-- 逐句口播 -->
    <view class="sc-card">
      <view class="sc-card-head">
        <text class="sc-card-title">🎙️ 逐句口播</text>
        <view class="sc-head-actions">
          <text class="sc-head-btn" @click="readScript">{{ isPlaying ? '⏹ 停止' : '🔊 试听' }}</text>
          <text class="sc-head-btn" @click="copy(script?.script || '', '口播')">📋 复制</text>
        </view>
      </view>
      <text class="sc-script">{{ script?.script }}</text>
    </view>

    <!-- 卖点 -->
    <view v-if="sellingPoints.length" class="sc-card">
      <text class="sc-card-title">💡 核心卖点</text>
      <view class="sc-sellpoints">
        <text v-for="(sp, i) in sellingPoints" :key="i" class="sc-sellpoint">{{ sp }}</text>
      </view>
    </view>

    <!-- 分镜 -->
    <view v-if="storyboard.length" class="sc-card">
      <text class="sc-card-title">🎬 分镜脚本</text>
      <view v-for="(sh, i) in storyboard" :key="i" class="sc-shot">
        <view class="sc-shot-head">
          <text class="sc-shot-index">{{ i + 1 }}</text>
          <text class="sc-shot-duration">{{ sh.duration || '' }}</text>
        </view>
        <text v-if="sh.visual_description" class="sc-shot-line">画面：{{ sh.visual_description }}</text>
        <text v-if="sh.camera" class="sc-shot-line">运镜：{{ sh.camera }}</text>
        <text v-if="sh.dialogue" class="sc-shot-line sc-shot-dialogue">台词：{{ sh.dialogue }}</text>
      </view>
    </view>

    <!-- 人物/场景资产（折叠） -->
    <view v-if="characters.length || scenes.length" class="sc-card">
      <view class="sc-fold-head" @click="showAssets = !showAssets">
        <text class="sc-card-title">🧩 拍摄资产（{{ characters.length + scenes.length }}）</text>
        <text class="sc-fold-arrow">{{ showAssets ? '▾' : '▸' }}</text>
      </view>
      <view v-if="showAssets" class="sc-fold-body">
        <text v-if="characters.length" class="sc-fold-sub">人物</text>
        <text v-for="(c, i) in characters" :key="'c' + i" class="sc-asset-line">{{ charName(c, i) }}{{ charDesc(c) ? '：' + charDesc(c) : '' }}</text>
        <text v-if="scenes.length" class="sc-fold-sub">场景</text>
        <text v-for="(s, i) in scenes" :key="'s' + i" class="sc-asset-line">{{ sceneName(s, i) }}{{ sceneDesc(s) ? '：' + sceneDesc(s) : '' }}</text>
      </view>
    </view>

    <!-- 合规提示（折叠） -->
    <view v-if="riskItems.length" class="sc-card">
      <view class="sc-fold-head" @click="showCompliance = !showCompliance">
        <text class="sc-card-title">🛡️ 合规提示（{{ riskItems.length }}）</text>
        <text class="sc-fold-arrow">{{ showCompliance ? '▾' : '▸' }}</text>
      </view>
      <view v-if="showCompliance" class="sc-fold-body">
        <view v-for="(r, i) in riskItems" :key="i" class="sc-risk">
          <text class="sc-risk-expr">{{ r.expr || '' }}</text>
          <text class="sc-risk-sug">{{ r.suggestion || r.replacement || '' }}</text>
        </view>
      </view>
    </view>

    <!-- 底部操作 -->
    <view class="sc-bottom">
      <view class="sc-btn sc-btn-primary" @click="copyFull">
        <text>📋 复制全文</text>
      </view>
      <view class="sc-btn" @click="restart">
        <text>🔄 再创作一次</text>
      </view>
    </view>
  </view>
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.sc-page {
  min-height: 100vh;
  padding: 24rpx 24rpx 60rpx;
  box-sizing: border-box;
  display: flex; flex-direction: column; gap: 20rpx;
}

.sc-header { display: flex; align-items: center; justify-content: space-between; padding: 8rpx 8rpx 4rpx; }
.sc-title { font-size: 36rpx; font-weight: 700; color: $text-primary; flex: 1; margin-right: 16rpx; }
.sc-version {
  flex-shrink: 0; padding: 8rpx 20rpx; border-radius: 999rpx;
  background: $gradient-gold; color: #fff; font-size: 22rpx; font-weight: 600;
}

.sc-hook {
  background: rgba(200, 169, 126, 0.1);
  border-radius: $radius-lg; padding: 24rpx;
  display: flex; flex-direction: column; gap: 10rpx;
}
.sc-hook-label { font-size: 24rpx; font-weight: 600; color: $gold; }
.sc-hook-text { font-size: 30rpx; color: $text-primary; font-weight: 600; line-height: 1.5; }

.sc-card { background: $bg-card; border-radius: $radius-lg; padding: 28rpx 24rpx; box-shadow: $shadow-card; }
.sc-card-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 16rpx; }
.sc-card-title { font-size: 28rpx; font-weight: 700; color: $text-primary; }
.sc-head-actions { display: flex; gap: 20rpx; }
.sc-head-btn { font-size: 24rpx; color: $primary-green; font-weight: 500; }
.sc-script {
  font-size: 28rpx; color: $text-primary; line-height: 1.8;
  white-space: pre-wrap; word-break: break-all;
}

.sc-sellpoints { display: flex; flex-wrap: wrap; gap: 12rpx; margin-top: 16rpx; }
.sc-sellpoint {
  padding: 10rpx 22rpx; border-radius: 999rpx;
  background: rgba(7, 193, 96, 0.08); color: $primary-green;
  font-size: 24rpx; font-weight: 500;
}

.sc-shot { padding: 20rpx 0; & + & { border-top: 1rpx solid rgba(0,0,0,0.05); } }
.sc-shot-head { display: flex; align-items: center; gap: 12rpx; margin-bottom: 8rpx; }
.sc-shot-index {
  width: 40rpx; height: 40rpx; border-radius: 50%;
  background: $primary-green; color: #fff; font-size: 22rpx; font-weight: 700;
  display: flex; align-items: center; justify-content: center;
}
.sc-shot-duration {
  padding: 2rpx 14rpx; border-radius: 999rpx;
  background: $bg-main; color: $text-secondary; font-size: 22rpx;
}
.sc-shot-line { display: block; font-size: 24rpx; color: $text-secondary; line-height: 1.6; margin-top: 4rpx; }
.sc-shot-dialogue { color: $text-primary; }

.sc-fold-head { display: flex; align-items: center; justify-content: space-between; }
.sc-fold-arrow { font-size: 28rpx; color: $text-tertiary; }
.sc-fold-body { margin-top: 16rpx; display: flex; flex-direction: column; gap: 8rpx; }
.sc-fold-sub { font-size: 24rpx; font-weight: 600; color: $text-secondary; margin-top: 8rpx; }
.sc-asset-line { font-size: 24rpx; color: $text-secondary; line-height: 1.5; }
.sc-risk { display: flex; flex-direction: column; gap: 4rpx; padding: 8rpx 0; & + & { border-top: 1rpx dashed #eee; } }
.sc-risk-expr { font-size: 24rpx; color: $warning-orange; font-weight: 500; }
.sc-risk-sug { font-size: 22rpx; color: $text-tertiary; }

.sc-bottom { display: flex; gap: 20rpx; margin-top: 8rpx; }
.sc-btn {
  flex: 1; padding: 24rpx 0; border-radius: $radius-lg;
  border: 2rpx solid $primary-green; background: #fff;
  display: flex; justify-content: center;
  text { font-size: 28rpx; font-weight: 600; color: $primary-green; }
}
.sc-btn-primary {
  background: $gradient-primary; border-color: transparent;
  text { color: #fff; }
}
</style>
