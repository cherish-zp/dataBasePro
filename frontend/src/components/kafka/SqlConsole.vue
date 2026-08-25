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
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.55);
  display: flex; align-items: center; justify-content: center; z-index: 900;
}
.modal {
  width: 720px; max-width: 94vw; max-height: 88vh; display: flex; flex-direction: column;
  background: #1b2430; border: 1px solid #33404f; border-radius: 10px;
  color: #d6dee8; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 14px 18px; border-bottom: 1px solid #33404f; }
.modal-title { font-weight: 600; }
.modal-close { background: none; border: none; color: #9aa7b5; font-size: 16px; cursor: pointer; }
.modal-body { padding: 16px 18px; overflow: auto; }
.engine-row { display: flex; align-items: center; gap: 10px; margin-bottom: 12px; }
.label { font-size: 12px; color: #9aa7b5; margin-bottom: 4px; display: block; }
.input { background: #121a24; border: 1px solid #2a3542; border-radius: 6px; color: #d6dee8; padding: 8px 10px; font-size: 13px; }
.engine { width: 200px; }
.textarea { width: 100%; box-sizing: border-box; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.field { margin-bottom: 10px; }
.hint { font-size: 12px; color: #7a8698; margin-bottom: 10px; }
.hint code { background: #121a24; padding: 1px 4px; border-radius: 4px; }
.msg { font-size: 13px; border-radius: 6px; padding: 8px 10px; margin-bottom: 10px; }
.msg.err { background: #f8514922; color: #ff8f8a; }
.results { border-top: 1px solid #2a3542; padding-top: 10px; }
.results-header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 8px; font-size: 13px; color: #c3ccd6; }
.btn { border-radius: 6px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn.small { padding: 4px 10px; font-size: 12px; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: #1f6feb; color: #fff; }
.table-wrap { max-height: 360px; overflow: auto; border: 1px solid #2a3542; border-radius: 6px; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { position: sticky; top: 0; background: #1b2430; text-align: left; padding: 8px 12px; color: #9aa7b5; font-weight: 600; border-bottom: 1px solid #2a3542; }
.table td { padding: 6px 12px; border-bottom: 1px solid #222c38; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.truncate { max-width: 260px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: #7a8698; padding: 18px; }
</style>
