<script setup lang="ts">
import { ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { Message } from '@/api/types'
import { OffsetEarliest } from '@/api/types'
import { parseSelect, matchesWhere } from '@/utils/sql'
import { formatTime, displayValue } from '@/utils/format'

const props = defineProps<{
  show: boolean
  tabId: string
  connectionId: string
  topic: string
  partitions: number[]
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

type Engine = 'kafka' | 'mysql' | 'es'
const engine = ref<Engine>('kafka')
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
  if (engine.value !== 'kafka') {
    error.value = `${engine.value.toUpperCase()} 引擎暂未支持，请选择 Kafka`
    return
  }
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

function close(): void {
  emit('close')
}
</script>

<template>
  <div v-if="show" class="modal-backdrop" data-test="sql-console" @click.self="close">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">查询控制台</span>
        <button class="modal-close" type="button" data-test="modal-close" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="engine-row">
          <label class="label">执行引擎</label>
          <select v-model="engine" data-test="select-engine" class="input engine">
            <option value="kafka">Kafka</option>
            <option value="mysql">MySQL（预留）</option>
            <option value="es">Elasticsearch（预留）</option>
          </select>
        </div>
        <div class="field">
          <label class="label">SQL</label>
          <textarea v-model="sql" data-test="input-sql" class="input textarea" rows="3" spellcheck="false"></textarea>
        </div>
        <div class="hint">支持：<code>SELECT * FROM &lt;topic&gt;</code>，<code>WHERE key='x' / value LIKE '%x%'</code>，<code>LIMIT n</code>。</div>
        <div v-if="error" class="msg err" data-test="sql-error">{{ error }}</div>

        <div class="results" data-test="sql-results">
          <div class="results-header">
            <span>查询结果（{{ results.length }} 条）</span>
            <button class="btn primary small" type="button" data-test="btn-run" :disabled="running" @click="run">
              {{ running ? '执行中…' : '执行' }}
            </button>
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
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.22);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center; z-index: 900;
}
.modal {
  width: 720px; max-width: 94vw; max-height: 88vh; display: flex; flex-direction: column;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  color: var(--text); font-family: var(--font);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.modal-title { font-weight: 600; font-size: 15px; }
.modal-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 6px; padding: 1px 6px; }
.modal-close:hover { background: var(--bg-hover); color: var(--text); }
.modal-body { padding: 16px 18px; overflow: auto; }
.engine-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.label { font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; display: block; }
.input { background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 7px; color: var(--text); padding: 8px 10px; font-size: 13px; transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.engine { width: 200px; }
.textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: var(--mono); }
.field { margin-bottom: 10px; }
.hint { font-size: 12px; color: var(--text-tertiary); margin-bottom: 10px; }
.hint code { background: var(--bg-subtle); padding: 1px 5px; border-radius: 5px; }
.msg { font-size: 13px; border-radius: 7px; padding: 8px 10px; margin-bottom: 10px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.results { border-top: 1px solid var(--border); padding-top: 10px; }
.results-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; color: var(--text); }
.btn { border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.table-wrap { max-height: 360px; overflow: auto; border: 1px solid var(--border); border-radius: 8px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { position: sticky; top: 0; background: var(--bg-subtle); text-align: left; padding: 8px 12px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border); }
.table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.truncate { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--text-tertiary); padding: 18px; }
</style>
