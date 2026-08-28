<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { Message } from '@/api/types'
import { OffsetEarliest } from '@/api/types'
import { parseSelect, matchesWhere } from '@/utils/sql'
import { formatTime, displayValue } from '@/utils/format'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, downloadFile, exportCsv, exportJsonl } from '@/utils/export'

const props = defineProps<{
  tabId: string
  connectionId: string
  topic: string
  partitions: number[]
}>()

const sql = ref(`SELECT * FROM ${props.topic} LIMIT 100`)
const running = ref(false)
const error = ref<string | null>(null)
const results = ref<Message[]>([])

watch(
  () => props.topic,
  (t) => {
    sql.value = `SELECT * FROM ${t} LIMIT 100`
    results.value = []
  },
)

async function run(): Promise<void> {
  error.value = null
  results.value = []
  const parsed = parseSelect(sql.value)
  if (parsed.error) {
    error.value = parsed.error
    return
  }
  const topic = parsed.topic ?? props.topic
  running.value = true
  try {
    const fetched = await getApi().consumeMessages({
      connection_id: props.connectionId,
      topic,
      partition: -1,
      offset: OffsetEarliest,
      limit: parsed.limit ?? 500,
    })
    let out = fetched.filter((m) => matchesWhere(m, parsed.where))
    if (parsed.limit != null) out = out.slice(0, parsed.limit)
    results.value = out
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    running.value = false
  }
}

// Export dropdown: disabled until a query produced rows.
const exportOpen = ref(false)
const exportRoot = ref<HTMLElement | null>(null)

// exportAs downloads the current result rows in the picked format and closes
// the menu.
function exportAs(format: 'csv' | 'jsonl'): void {
  exportOpen.value = false
  if (format === 'csv') {
    downloadFile('query-results', exportCsv(results.value, MESSAGE_EXPORT_COLUMNS), CSV_MIME)
  } else {
    downloadFile('query-results', exportJsonl(results.value), JSONL_MIME)
  }
}

// onDocClick closes the export menu on clicks landing outside of it.
function onDocClick(e: MouseEvent): void {
  if (exportOpen.value && exportRoot.value && !exportRoot.value.contains(e.target as Node)) {
    exportOpen.value = false
  }
}

onMounted(() => document.addEventListener('click', onDocClick))
onBeforeUnmount(() => document.removeEventListener('click', onDocClick))
</script>

<template>
  <div class="sql-console" data-test="sql-console">
    <div class="sql-toolbar" data-test="sql-toolbar">
      <label class="sql-field grow" data-test="sql-field">
        <span class="label">SQL</span>
        <textarea v-model="sql" data-test="input-sql" class="editor" rows="3" spellcheck="false"></textarea>
      </label>
      <button class="btn primary" type="button" data-test="btn-run" :disabled="running" @click="run">
        {{ running ? '执行中…' : '执行' }}
      </button>
    </div>

    <div class="hint">支持：<code>SELECT * FROM &lt;topic&gt;</code>，<code>WHERE key='x' / value LIKE '%x%'</code>，<code>LIMIT n</code>。</div>

    <div v-if="error" class="msg err" data-test="sql-error">{{ error }}</div>

    <div class="results-panel" data-test="sql-results">
      <div class="results-header">
        <span>查询结果（{{ results.length }} 条）</span>
        <div ref="exportRoot" class="export-menu" data-test="export-menu">
          <button
            class="btn ghost"
            type="button"
            data-test="export-toggle"
            :disabled="results.length === 0"
            @click="exportOpen = !exportOpen"
          >
            导出 ▾
          </button>
          <div v-if="exportOpen" class="export-pop">
            <button class="export-item" type="button" data-test="export-csv" @click="exportAs('csv')">CSV</button>
            <button class="export-item" type="button" data-test="export-jsonl" @click="exportAs('jsonl')">JSONL</button>
          </div>
        </div>
      </div>
      <div v-if="results.length" class="table-wrap">
        <table class="table">
          <thead>
            <tr>
              <th>Partition</th>
              <th>Offset</th>
              <th>Timestamp</th>
              <th>Key</th>
              <th>Value</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="m in results" :key="`${m.partition}:${m.offset}`" data-test="sql-row">
              <td>{{ m.partition }}</td>
              <td class="mono">{{ m.offset }}</td>
              <td class="mono">{{ formatTime(m.timestamp) }}</td>
              <td class="mono truncate">{{ displayValue(m.key) }}</td>
              <td class="truncate">{{ displayValue(m.value) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
      <div v-else class="empty" data-test="sql-empty">暂无结果</div>
    </div>
  </div>
</template>

<style scoped>
.sql-console {
  height: 100%;
  display: flex;
  flex-direction: column;
  font-family: var(--font);
  color: var(--text);
  background: var(--bg-elevated);
}
.sql-toolbar {
  display: flex;
  align-items: flex-end;
  gap: 12px;
  padding: 14px 16px;
  border-bottom: 1px solid var(--border);
  background: rgba(255, 255, 255, 0.72);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
}
.sql-field { display: flex; flex-direction: column; gap: 5px; }
.sql-field.grow { flex: 1; min-width: 0; }
.label { font-size: 11px; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.02em; }
.editor {
  width: 100%;
  box-sizing: border-box;
  resize: vertical;
  font-family: var(--mono);
  font-size: 13px;
  line-height: 1.55;
  color: var(--text);
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 9px 12px;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.editor:focus {
  outline: none;
  border-color: var(--accent);
  background: var(--bg-elevated);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.hint { font-size: 12px; color: var(--text-tertiary); padding: 7px 16px 0; }
.hint code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 5px; font-family: var(--mono); }
.msg { font-size: 13px; border-radius: 9px; padding: 8px 12px; margin: 8px 16px 0; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.results-panel { flex: 1; min-height: 0; display: flex; flex-direction: column; padding: 10px 16px 16px; }
.results-header { display: flex; align-items: center; gap: 12px; justify-content: space-between; font-size: 13px; font-weight: 600; padding: 6px 0 10px; }
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
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.table-wrap { flex: 1; min-height: 0; overflow: auto; border: 1px solid var(--border); border-radius: 10px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { position: sticky; top: 0; background: var(--bg-subtle); text-align: left; padding: 8px 12px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border); z-index: 1; }
.table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.truncate { max-width: 420px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--text-tertiary); padding: 24px; }
.btn { border-radius: 9px; padding: 9px 20px; font-size: 13px; font-weight: 500; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease, box-shadow 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; box-shadow: 0 1px 2px rgba(0, 113, 227, 0.3); }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
</style>
