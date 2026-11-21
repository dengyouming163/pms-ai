import { ref, onUnmounted } from 'vue'

export interface VoiceResult { text: string; confidence?: number }
export interface VoiceError { code: string; message: string }

export function useVoice() {
  const isRecording = ref(false)
  const isPlaying = ref(false)
  const audioText = ref('')
  const error = ref<VoiceError | null>(null)
  // 音频缓存：消息ID -> 本地文件路径
  const audioCache = new Map<string, string>()
  let _currentMsgId = ''

  let _recorderManager: any = null
  let _audioCtx: any = null
  let _stopFn: (() => void) | null = null
  let recordingTimer: ReturnType<typeof setTimeout> | null = null

  function isH5(): boolean { if (typeof plus !== 'undefined') return false; return typeof window !== 'undefined' }
  function isAppPlus(): boolean { return typeof plus !== 'undefined' && typeof (plus as any).speech !== 'undefined' }
  function getRecorder(): any { if (!_recorderManager && !isH5()) { try { _recorderManager = uni.getRecorderManager() } catch { _recorderManager = null } }; return _recorderManager }
  function getAudioCtx(): any { if (!_audioCtx) { try { _audioCtx = uni.createInnerAudioContext() } catch { _audioCtx = null } }; return _audioCtx }

  // ===== H5 ASR =====
  function getRecognition(): any {
    if (!isH5()) return null
    const SR = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition
    if (!SR) return null
    try { if ((window as any).__sr) (window as any).__sr.abort() } catch {}
    const rec = new SR(); rec.lang = 'zh-CN'; rec.interimResults = true; rec.continuous = false; rec.maxAlternatives = 1
    ;(window as any).__sr = rec; return rec
  }

  function startWebASR(onInterim: (text: string) => void) {
    const rec = getRecognition()
    if (!rec) return { promise: Promise.reject(new Error('浏览器不支持语音识别')), stop: () => {} }
    let finalText = '', resolved = false, _resolve: any, _reject: any
    const promise = new Promise<string>((resolve, reject) => {
      _resolve = resolve; _reject = reject; isRecording.value = true
      rec.onresult = (e: any) => {
        let interim = ''
        for (let i = e.resultIndex; i < e.results.length; i++) { const r = e.results[i]; if (r.isFinal) finalText += r[0].transcript; else interim += r[0].transcript }
        onInterim(finalText + interim)
      }
      rec.onerror = (e: any) => { if (resolved) return; resolved = true; isRecording.value = false; _reject(new Error(e.error === 'no-speech' ? '未检测到语音' : `识别失败: ${e.error}`)) }
      rec.onend = () => { isRecording.value = false; if (resolved) return; resolved = true; if (finalText.trim()) _resolve(finalText.trim()); else _reject(new Error('未检测到语音')) }
      try { rec.start() } catch (e: any) { _reject(e) }
    })
    return { promise, stop: () => { try { rec.stop() } catch {} } }
  }

  // ===== APP ASR =====
  function startAppASR(onInterim: (text: string) => void) {
    if (!isAppPlus()) return { promise: Promise.reject(new Error('plus.speech不可用')), stop: () => {} }
    let finalText = '', _done = false, _resolve: any, _reject: any
    const ps = (plus as any).speech
    ps.addEventListener('start', () => { isRecording.value = true; audioText.value = ''; finalText = '' })
    ps.addEventListener('recognizing', (e: any) => { const t = e.partialResult || ''; if (t) onInterim(t) })
    ps.addEventListener('recognition', (e: any) => { const t = e.result || ''; if (t) { finalText += t; onInterim(finalText) } })
    ps.addEventListener('end', () => { isRecording.value = false })
    const promise = new Promise<string>((resolve, reject) => {
      _resolve = resolve; _reject = reject; isRecording.value = true
      ps.startRecognize({ engine: 'baidu', lang: 'zh-cn', 'userInterface': false, 'continue': true }, () => {}, (err: any) => { isRecording.value = false; if (!finalText.trim()) _reject(new Error(err?.message || '识别失败')) })
    })
    return { promise, stop: () => { try { ps.stopRecognize() } catch {}; let cnt = 0; const iv = setInterval(() => { cnt++; if ((finalText.trim() && cnt > 3) || cnt > 20) { clearInterval(iv); if (_done) return; _done = true; isRecording.value = false; const t = finalText.trim(); if (t) _resolve(t); else _reject(new Error('未检测到语音')) } }, 100) } }
  }

  // ===== Unified Recording =====
  async function startRecording(onInterim?: (text: string) => void): Promise<string> {
    const interim = onInterim || (() => {})
    if (isH5()) { const r = startWebASR(interim); _stopFn = r.stop; return r.promise }
    if (isAppPlus()) { const r = startAppASR(interim); _stopFn = r.stop; return r.promise }
    _stopFn = () => { if (isRecording.value && getRecorder()) getRecorder().stop() }
    ensureRecorder(); return ''
  }

  function stopRecording() { if (_stopFn) { _stopFn(); _stopFn = null } }
  function cancelRecording() { stopRecording(); audioText.value = ''; error.value = null }

  function ensureRecorder() {
    const done = (window as any).__recorderReady; if (done || isH5() || isAppPlus()) return; (window as any).__recorderReady = true
    getAudioCtx().onError(() => { isPlaying.value = false })
    getAudioCtx().onEnded(() => { isPlaying.value = false })
    getRecorder().onStop(() => { if (recordingTimer) { clearTimeout(recordingTimer); recordingTimer = null }; isRecording.value = false })
    getRecorder().onError((err: any) => { isRecording.value = false })
    getRecorder().onStart(() => { isRecording.value = true; recordingTimer = setTimeout(() => { if (isRecording.value) stopRecording() }, 60000) })
  }

  // ===== APP TTS：百炼TTS -> 下载 -> 播放 + 缓存 =====
  function speakApp(text: string, msgId?: string): Promise<void> {
    // 缓存命中直接播
    if (msgId && audioCache.has(msgId)) {
      return new Promise((resolve, reject) => {
        isPlaying.value = true
        const ctx = getAudioCtx()
        ctx.src = audioCache.get(msgId)!
        ctx.play()
        ctx.onEnded(() => { isPlaying.value = false; resolve() })
        ctx.onError(() => { isPlaying.value = false; audioCache.delete(msgId); reject(new Error('播放失败')) })
      })
    }

    return new Promise((resolve, reject) => {
      const token = uni.getStorageSync('token')
      if (!token) { reject(new Error('未登录')); return }
      isPlaying.value = true
      uni.request({
        url: 'http://132.232.166.40:20002/api/voice/read', method: 'POST',
        header: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        data: { text },
        success: (res: any) => {
          const d = res.data as any
          const audioUrl = d?.audioUrl
          if (!audioUrl) { isPlaying.value = false; reject(new Error(d?.error || '无音频URL')); return }
          uni.downloadFile({
            url: audioUrl,
            success: (df: any) => {
              if (df.statusCode === 200) {
                // 缓存
                if (msgId) audioCache.set(msgId, df.tempFilePath)
                const ctx = getAudioCtx()
                ctx.src = df.tempFilePath
                ctx.play()
                ctx.onEnded(() => { isPlaying.value = false; resolve() })
                ctx.onError(() => { isPlaying.value = false; reject(new Error('播放失败')) })
              } else { isPlaying.value = false; reject(new Error('下载音频失败')) }
            },
            fail: () => { isPlaying.value = false; reject(new Error('下载音频失败')) }
          })
        },
        fail: () => { isPlaying.value = false; reject(new Error('网络请求失败')) }
      })
    })
  }

  async function playVoice(text: string, msgId?: string): Promise<void> {
    try { await speakApp(text, msgId) } catch (e: any) { error.value = { code: 'TTS_ERROR', message: e.message || '播放失败' }; throw e }
  }

  function stopVoice() {
    try { (window as any).speechSynthesis?.cancel() } catch {}
    if (typeof plus !== 'undefined' && plus.speech) { try { (plus.speech as any).stop?.() } catch {} }
    if (isPlaying.value) { try { getAudioCtx().stop() } catch {}; isPlaying.value = false }
  }

  onUnmounted(() => { if (recordingTimer) clearTimeout(recordingTimer); stopRecording(); stopVoice(); try { getAudioCtx().destroy() } catch {} })

  return { isRecording, isPlaying, audioText, error, startRecording, stopRecording, cancelRecording, playVoice, stopVoice }
}
