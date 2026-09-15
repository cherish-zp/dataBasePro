<script setup lang="ts">
// 结果区 Tab 条:三个 SQL 控制台(MySQL/CH/ES)共用。每个语句结果一个 tab,
// Tab 条下方只渲染 active 对应的那张结果卡(由调用方负责)。
// label:语句前置注释文本(无注释回退「结果 N」,由调用方生成);
// status:running(发起时)/ ok / fail / none,驱动状态点配色;
// title:悬浮提示(语句单行摘要,由调用方生成)。
export interface ResultTabItem {
  label: string
  status: 'ok' | 'fail' | 'running' | 'none'
  title?: string
}

defineProps<{ tabs: ResultTabItem[]; active: number }>()

const emit = defineEmits<{
  (e: 'select', index: number): void
}>()
</script>

<template>
  <div class="result-tabs" data-test="result-tabs">
    <button
      v-for="(t, i) in tabs"
      :key="i"
      type="button"
      class="result-tab"
      :class="{ active: i === active }"
      :data-test="`result-tab-${i}`"
      :title="t.title"
      @click="emit('select', i)"
    >
      <span class="tab-dot" :class="t.status"></span>
      <span class="tab-label">{{ t.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.result-tabs {
  flex: none;
  display: flex;
  align-items: stretch;
  gap: 2px;
  padding: 4px 8px 0;
  border-bottom: 1px solid var(--border);
  overflow-x: auto;
  scrollbar-width: thin;
}
.result-tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  max-width: 220px;
  border: none;
  background: transparent;
  color: var(--text-secondary);
  font-size: 12px;
  font-family: var(--font);
  padding: 5px 10px;
  cursor: pointer;
  border-radius: 7px 7px 0 0;
  border-bottom: 2px solid transparent;
  transition: background 0.12s ease, color 0.12s ease;
  white-space: nowrap;
}
.result-tab:hover { background: var(--bg-hover); color: var(--text); }
.result-tab.active {
  background: var(--accent-soft);
  color: var(--accent);
  border-bottom-color: var(--accent);
  font-weight: 600;
}
.tab-dot {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--text-tertiary);
  opacity: 0.5;
}
.tab-dot.ok { background: var(--ok); opacity: 1; }
.tab-dot.fail { background: var(--danger); opacity: 1; }
.tab-dot.running { background: var(--info); opacity: 1; animation: tab-dot-pulse 0.9s ease-in-out infinite; }
@keyframes tab-dot-pulse {
  50% { opacity: 0.25; }
}
.tab-label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
