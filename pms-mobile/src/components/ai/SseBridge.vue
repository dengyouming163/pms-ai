<template>
  <view
    class="sse-bridge"
    :prop="bridgeData"
    :change:prop="sseRender.handleProp"
  />
</template>

<script>
export default {
  name: 'SseBridge',
  props: {
    bridgeData: {
      type: Object,
      default: () => ({})
    }
  },
  emits: ['chunk', 'done', 'error'],
  methods: {
    onChunk(payload) {
      this.$emit('chunk', payload || {})
    },
    onDone(payload) {
      this.$emit('done', payload || {})
    },
    onError(payload) {
      this.$emit('error', payload || {})
    }
  },
}
</script>

<script module="sseRender" lang="renderjs">
export default {
  data() {
    return {
      _xhr: null,
      _buffer: '',
      _cursor: 0,
      _stopped: false,
      _latestSeq: 0
    }
  },
  methods: {
    handleProp(newVal, oldVal, ownerInstance) {
      const payload = newVal || {}
      const seq = Number(payload.seq || 0)
      if (seq <= this._latestSeq) return
      this._latestSeq = seq

      if (payload.type === 'disconnect') {
        this.closeConnection()
        return
      }
      if (payload.type !== 'connect') return

      this.setupSSEConnection(payload, ownerInstance || this.$ownerInstance)
    },

    setupSSEConnection(payload, ownerInstance) {
      this.closeConnection()
      this._stopped = false
      this._buffer = ''
      this._cursor = 0
      this._requestId = payload.requestId || ''

      const xhr = new XMLHttpRequest()
      this._xhr = xhr

      xhr.open(payload.method || 'POST', payload.url, true)
      xhr.responseType = 'text'
      xhr.timeout = Number(payload.timeout || 180000)

      const headers = payload.headers || {}
      Object.keys(headers).forEach(key => {
        const val = headers[key]
        if (val !== undefined && val !== null && val !== '') {
          xhr.setRequestHeader(key, val)
        }
      })

      xhr.onprogress = () => {
        if (this._stopped) return

        const responseText = xhr.responseText || ''
        const chunkText = responseText.slice(this._cursor)
        this._cursor = responseText.length

        if (!chunkText) return

        this._buffer += chunkText
        const lines = this._buffer.split(/\r?\n/)
        this._buffer = lines.pop() || ''

        lines.forEach(line => this.parseSSELine(line, ownerInstance))
      }

      xhr.onreadystatechange = () => {
        if (xhr.readyState !== 4 || this._stopped) return
        this._xhr = null
        if (ownerInstance && typeof ownerInstance.callMethod === 'function') {
          ownerInstance.callMethod('onDone', { statusCode: xhr.status, requestId: this._requestId })
        }
      }

      xhr.onerror = () => {
        if (this._stopped) return
        this._xhr = null
        if (ownerInstance && typeof ownerInstance.callMethod === 'function') {
          ownerInstance.callMethod('onError', { message: 'APP renderjs 请求失败', requestId: this._requestId })
        }
      }

      xhr.ontimeout = () => {
        if (this._stopped) return
        this._xhr = null
        if (ownerInstance && typeof ownerInstance.callMethod === 'function') {
          ownerInstance.callMethod('onError', { message: 'APP renderjs 请求超时', requestId: this._requestId })
        }
      }

      const body = payload.body
      if (typeof body === 'object') {
        xhr.send(JSON.stringify(body))
      } else if (typeof body === 'string') {
        xhr.send(body)
      } else {
        xhr.send()
      }
    },

    parseSSELine(line, ownerInstance) {
      const text = String(line || '').trim()
      if (!text || !text.startsWith('data:')) return

      const raw = text.slice(5).trim()
      if (!raw || raw === '[DONE]') return

      try {
        const data = JSON.parse(raw)
        data._requestId = this._requestId
        if (ownerInstance && typeof ownerInstance.callMethod === 'function') {
          ownerInstance.callMethod('onChunk', data)
        }
      } catch {
        // JSON 解析失败，跳过
      }
    },

    closeConnection() {
      this._stopped = true
      if (this._xhr) {
        try { this._xhr.abort() } catch {}
        this._xhr = null
      }
    }
  }
}
</script>

<style scoped>
.sse-bridge {
  width: 0;
  height: 0;
  overflow: hidden;
  position: fixed;
  left: -9999px;
  top: -9999px;
}
</style>