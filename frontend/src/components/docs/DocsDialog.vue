<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { docEntries, readLastDocId, renderDoc, writeLastDocId } from '@/docs'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// 当前篇章:打开时恢复上次看过的篇(localStorage 记忆),无效或缺失回落第一篇。
const currentId = ref(docEntries[0]?.id ?? '')

watch(
  () => props.show,
  (show) => {
    if (!show) return
    const last = readLastDocId()
    currentId.value = docEntries.some((d) => d.id === last) ? last : (docEntries[0]?.id ?? '')
  },
  { immediate: true },
)

const current = computed(() => docEntries.find((d) => d.id === currentId.value) ?? docEntries[0])
// 内容为内置可信文档且渲染器已做 HTML 转义,v-html 安全。
const renderedHtml = computed(() => renderDoc(current.value?.markdown ?? ''))

function select(id: string): void {
  currentId.value = id
  writeLastDocId(id)
}

// Esc 关闭:组件级监听,仅 show 时响应,卸载时移除。
function onKeydown(e: KeyboardEvent): void {
  if (props.show && e.key === 'Escape') emit('close')
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="overlay">
      <div class="dialog" data-test="docs-dialog">
        <div class="head">
          <span class="title">使用文档</span>
          <button class="close" type="button" data-test="btn-docs-close" @click="emit('close')">✕</button>
        </div>
        <div class="body">
          <aside class="toc" data-test="docs-toc">
            <button
              v-for="d in docEntries"
              :key="d.id"
              class="toc-item"
              :class="{ active: d.id === currentId }"
              type="button"
              :data-test="`docs-toc-item-${d.id}`"
              @click="select(d.id)"
            >
              {{ d.title }}
            </button>
          </aside>
          <!-- 内置可信文档,渲染前已转义。 -->
          <!-- eslint-disable-next-line vue/no-v-html -->
          <article class="content" data-test="docs-content" v-html="renderedHtml"></article>
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.32);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1200;
  font-family: var(--font);
  color: var(--text);
}
.dialog {
  width: 760px;
  max-width: calc(100vw - 48px);
  height: 70vh;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: 12px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.22);
  padding: 16px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.head { display: flex; align-items: center; justify-content: space-between; }
.title { font-weight: 600; font-size: 15px; }
.close { background: none; border: none; color: var(--text-tertiary); cursor: pointer; border-radius: 5px; padding: 1px 6px; }
.close:hover { background: var(--bg-hover); color: var(--text); }
.body { display: flex; gap: 14px; flex: 1; min-height: 0; }
.toc {
  width: 150px;
  flex: none;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding-right: 12px;
  border-right: 1px solid var(--border);
}
.toc-item {
  text-align: left;
  border: none;
  background: transparent;
  cursor: pointer;
  color: var(--text-secondary);
  font-size: 13px;
  font-family: var(--font);
  padding: 7px 10px;
  border-radius: var(--radius-sm);
  transition: background 0.1s ease, color 0.1s ease;
}
.toc-item:hover { background: var(--bg-hover); color: var(--text); }
.toc-item.active {
  background: var(--accent-soft);
  color: var(--accent);
  font-weight: 600;
}
.content {
  flex: 1;
  min-width: 0;
  overflow: auto;
  font-size: 13px;
  line-height: 1.7;
}

/* v-html 注入的 Markdown 元素样式(scoped 需 :deep),深浅色一律走 CSS 变量。 */
.content :deep(h1) { font-size: 18px; font-weight: 600; margin: 4px 0 10px; }
.content :deep(h2) {
  font-size: 15px;
  font-weight: 600;
  margin: 18px 0 8px;
  padding-bottom: 4px;
  border-bottom: 1px solid var(--border);
}
.content :deep(h3) { font-size: 13.5px; font-weight: 600; margin: 14px 0 6px; }
.content :deep(p) { margin: 6px 0; color: var(--text); }
.content :deep(ul),
.content :deep(ol) { margin: 6px 0; padding-left: 20px; }
.content :deep(li) { margin: 3px 0; }
.content :deep(strong) { font-weight: 600; }
.content :deep(code) {
  font-family: var(--font-mono, ui-monospace, monospace);
  font-size: 12px;
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 4px;
  padding: 1px 5px;
}
.content :deep(pre) {
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px 12px;
  overflow: auto;
}
.content :deep(pre code) { background: none; border: none; padding: 0; }
.content :deep(table) {
  border-collapse: collapse;
  width: 100%;
  margin: 8px 0;
  font-size: 12.5px;
}
.content :deep(th),
.content :deep(td) {
  border: 1px solid var(--border);
  padding: 6px 10px;
  text-align: left;
}
.content :deep(th) { background: var(--bg-subtle); font-weight: 600; }
</style>
