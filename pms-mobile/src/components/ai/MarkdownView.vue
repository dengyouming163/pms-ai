<script setup lang="ts">
import { computed } from 'vue'

const props = defineProps<{ content: string }>()

/* ============ 轻量级 Markdown → HTML 转换器 ============ */

function parseMarkdown(md: string): string {
  if (!md) return ''
  let html = md

  // 1. 代码块（必须先处理，避免内部语法被误解析）
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, lang: string, code: string) => {
    const escaped = escapeHtml(code.trimEnd())
    return `<pre class="md-pre"><code class="md-code-block${lang ? ' md-lang-' + lang : ''}">${escaped}</code></pre>`
  })

  // 2. 分割线
  html = html.replace(/^---+$/gm, '<hr class="md-hr">')

  // 3. 标题 h1-h6
  html = html.replace(/^###### (.*$)/gm, '<h6 class="md-h6">$1</h6>')
  html = html.replace(/^##### (.*$)/gm, '<h5 class="md-h5">$1</h5>')
  html = html.replace(/^#### (.*$)/gm, '<h4 class="md-h4">$1</h4>')
  html = html.replace(/^### (.*$)/gm, '<h3 class="md-h3">$1</h3>')
  html = html.replace(/^## (.*$)/gm, '<h2 class="md-h2">$1</h2>')
  html = html.replace(/^# (.*$)/gm, '<h1 class="md-h1">$1</h1>')

  // 4. 引用块 (多行)
  html = html.replace(/((?:^>.*\n?)+)/g, (m) => {
    const lines = m.split('\n').filter(Boolean)
    const content = lines.map((l: string) => l.replace(/^>\s?/, '')).join('<br>')
    return `<blockquote class="md-blockquote">${content}</blockquote>`
  })

  // 5. 无序列表
  html = html.replace(/^[\s]*[-*+]\s+(.+)$/gm, '<li class="md-li">$1</li>')
  html = html.replace(/(<li class="md-li">.*<\/li>\n?)+/g, (m) => `<ul class="md-ul">${m}</ul>`)

  // 6. 有序列表
  html = html.replace(/^[\s]*\d+\.\s+(.+)$/gm, '<li class="md-li">$1</li>')
  html = html.replace(/(<li class="md-li">.*<\/li>\n?)+/g, (m) => `<ol class="md-ol">${m}</ol>`)

  // 7. 行内格式：先处理行内代码（避免其中的 * 被误解析）
  html = html.replace(/`([^`]+)`/g, '<code class="md-code-inline">$1</code>')

  // 8. 粗体 **text** 或 __text__
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong class="md-strong">$1</strong>')
  html = html.replace(/__(.+?)__/g, '<strong class="md-strong">$1</strong>')

  // 9. 斜体 *text* 或 _text_
  html = html.replace(/\*(.+?)\*/g, '<em class="md-em">$1</em>')
  html = html.replace(/_([^_]+)_/g, '<em class="md-em">$1</em>')

  // 10. 表格
  html = html.replace(
    /^\|(.+)\|[\s]*\n^\|[\s|:\-]+\|[\s]*\n([\s\S]*?)(?=\n\n|\n#|\n\*|\n>|\n```|$)/gm,
    (match: string) => {
      const lines = match.split('\n').filter((l: string) => l.trim())
      if (lines.length < 2) return match
      const headerCells = lines[0].split('|').slice(1, -1).map((c: string) => c.trim())
      const bodyRows = lines.slice(2)
      let thead = '<thead class="md-thead"><tr>'
      headerCells.forEach((c: string) => { thead += `<th class="md-th">${c}</th>` })
      thead += '</tr></thead>'
      let tbody = '<tbody>'
      bodyRows.forEach((row: string) => {
        const cells = row.split('|').slice(1, -1).map((c: string) => c.trim())
        tbody += '<tr>'
        cells.forEach((c: string) => { tbody += `<td class="md-td">${c}</td>` })
        tbody += '</tr>'
      })
      tbody += '</tbody>'
      return `<div class="md-table-wrap"><table class="md-table">${thead}${tbody}</table></div>`
    }
  )

  // 11. 链接 [text](url)
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a class="md-link" href="$2" target="_blank" rel="noopener">$1</a>')

  // 12. 图片 ![alt](url)
  html = html.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img class="md-img" alt="$1" src="$2">')

  // 13. 剩余的段落：将每行未处理的文本包裹为 <p>
  html = html.replace(/^(?!<[a-z])((?!\n).+)$/gm, '<p class="md-p">$1</p>')

  // 14. 清理空行
  html = html.replace(/\n{2,}/g, '\n')
  html = html.replace(/<\/(p|div|blockquote|ul|ol|table)>\n*(?=<(p|div|blockquote|ul|ol|table|h[1-6]|pre|hr))/g, '</$1>')

  return html
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

const html = computed(() => parseMarkdown(props.content || ''))
</script>

<template>
  <!-- #ifdef H5 -->
  <view class="md-wrapper" v-html="html" />
  <!-- #endif -->

  <!-- #ifndef H5 -->
  <rich-text class="md-wrapper" :nodes="html" />
  <!-- #endif -->
</template>

<style lang="scss" scoped>
@import '@/styles/variables.scss';

.md-wrapper {
  font-size: 28rpx;
  line-height: 1.7;
  color: inherit;
  word-break: break-word;

  // 标题
  :deep(.md-h1) { font-size: 40rpx; font-weight: 700; margin: 32rpx 0 16rpx; }
  :deep(.md-h2) { font-size: 36rpx; font-weight: 700; margin: 28rpx 0 14rpx; }
  :deep(.md-h3) { font-size: 32rpx; font-weight: 600; margin: 24rpx 0 12rpx; }
  :deep(.md-h4) { font-size: 30rpx; font-weight: 600; margin: 20rpx 0 10rpx; }
  :deep(.md-h5), :deep(.md-h6) { font-size: 28rpx; font-weight: 600; margin: 16rpx 0 8rpx; }

  // 段落
  :deep(.md-p) { margin: 12rpx 0; }

  // 粗体/斜体
  :deep(.md-strong) { font-weight: 700; color: inherit; }
  :deep(.md-em) { font-style: italic; }

  // 行内代码
  :deep(.md-code-inline) {
    background: rgba(0,0,0,0.06);
    color: #d6336c;
    padding: 4rpx 12rpx;
    border-radius: 6rpx;
    font-size: 24rpx;
    font-family: 'Courier New', monospace;
  }

  // 代码块
  :deep(.md-pre) {
    background: #1e293b;
    border-radius: 16rpx;
    padding: 24rpx;
    margin: 20rpx 0;
    overflow-x: auto;
    font-size: 24rpx;
    line-height: 1.6;
  }
  :deep(.md-code-block) {
    color: #4ade80;
    font-family: 'Courier New', monospace;
    white-space: pre;
  }

  // 列表
  :deep(.md-ul) {
    list-style: disc;
    padding-left: 40rpx;
    margin: 16rpx 0;
  }
  :deep(.md-ol) {
    list-style: decimal;
    padding-left: 40rpx;
    margin: 16rpx 0;
  }
  :deep(.md-li) { margin: 6rpx 0; }

  // 引用
  :deep(.md-blockquote) {
    border-left: 6rpx solid #10b981;
    padding-left: 24rpx;
    margin: 16rpx 0;
    color: #64748b;
    font-style: italic;
  }

  // 链接
  :deep(.md-link) {
    color: #059669;
    text-decoration: underline;
  }

  // 分割线
  :deep(.md-hr) {
    border: none;
    border-top: 2rpx solid #e2e8f0;
    margin: 24rpx 0;
  }

  // 表格
  :deep(.md-table-wrap) {
    overflow-x: auto;
    margin: 20rpx 0;
  }
  :deep(.md-table) {
    width: 100%;
    border-collapse: collapse;
    font-size: 24rpx;
  }
  :deep(.md-th) {
    background: #f1f5f9;
    border: 2rpx solid #e2e8f0;
    padding: 12rpx 16rpx;
    text-align: left;
    font-weight: 600;
  }
  :deep(.md-td) {
    border: 2rpx solid #e2e8f0;
    padding: 12rpx 16rpx;
  }

  // 图片
  :deep(.md-img) {
    max-width: 100%;
    border-radius: 12rpx;
    margin: 16rpx 0;
  }
}
</style>