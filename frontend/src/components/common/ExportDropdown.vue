<script setup lang="ts">
// Shared export dropdown used by the message browser and the SQL console: a
// toggle button that reveals CSV/JSONL choices and closes on outside clicks.
// The picked format is emitted upward so each caller supplies its own
// filename and content through its exportAs handler.
import { onBeforeUnmount, onMounted, ref } from 'vue'

defineProps<{ disabled?: boolean }>()

const emit = defineEmits<{ export: [format: 'csv' | 'jsonl'] }>()

const exportOpen = ref(false)
const exportRoot = ref<HTMLElement | null>(null)

// pick closes the menu and reports the chosen format.
function pick(format: 'csv' | 'jsonl'): void {
  exportOpen.value = false
  emit('export', format)
}

// onDocClick closes the menu on clicks landing outside of it.
function onDocClick(e: MouseEvent): void {
  if (exportOpen.value && exportRoot.value && !exportRoot.value.contains(e.target as Node)) {
    exportOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div ref="exportRoot" class="export-menu" data-test="export-menu">
    <button
      class="btn ghost"
      type="button"
      data-test="export-toggle"
      :disabled="disabled"
      @click="exportOpen = !exportOpen"
    >
      导出 ▾
    </button>
    <div v-if="exportOpen" class="export-pop">
      <button class="export-item" type="button" data-test="export-csv" @click="pick('csv')">CSV</button>
      <button class="export-item" type="button" data-test="export-jsonl" @click="pick('jsonl')">JSONL</button>
    </div>
  </div>
</template>

<style scoped>
/* The button look is duplicated from the callers' scoped .btn.ghost rules:
   scoped styles do not cross component boundaries, so the toggle must carry
   its own styling to render identically inside both the browser and console. */
.export-menu { position: relative; font-weight: 400; }
.export-pop {
  position: absolute; top: calc(100% + 6px); right: 0; z-index: 20; min-width: 110px;
  display: flex; flex-direction: column; padding: 4px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md);
  box-shadow: var(--shadow-md);
}
.export-item {
  text-align: left; border: none; background: transparent; cursor: pointer;
  color: var(--text); font-size: 13px; font-family: var(--font); padding: 7px 10px; border-radius: var(--radius-sm);
  transition: background 0.1s ease;
}
.export-item:hover { background: var(--bg-hover); }
.btn { border-radius: 7px; padding: 6px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
</style>
