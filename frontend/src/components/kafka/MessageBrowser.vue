<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useBrowseStore } from '@/store/browse'
import type { MessageQuery } from '@/store/browse'
import { OffsetEarliest, OffsetLatest } from '@/api/types'
import type { Message } from '@/api/types'
import { formatTime, displayValue } from '@/utils/format'
import MessageDetailDrawer from './MessageDetailDrawer.vue'

const props = defineProps<{ tabId: string; connectionId: string; topic: string; partitions: number[] }>()
const emit = defineEmits<{ (e: 'open-sql'): void; (e: 'open-producer'): void }>()

const store = useBrowseStore()
const st = computed(() => store.stateFor(props.tabId))

const mode = ref<'earliest' | 'latest' | 'timestamp'>('earliest')
const partition = ref(-1)
const limit = ref(500)
const timestampMs = ref<number | null>(null)
const detailOpen = ref(false)

const partitionOptions = computed(() => [
  { label: 'All', value: -1 },
  ...props.partitions.map((p) => ({ label: String(p), value: p })),
])

function buildQuery(): Partial<MessageQuery> {
  const q: Partial<MessageQuery> = { partition: partition.value, limit: limit.value }
  if (mode.value === 'earliest') {
    q.offset = OffsetEarliest
    q.timestampMs = null
  } else if (mode.value === 'latest') {
    q.offset = OffsetLatest
    q.timestampMs = null
  } else {
    q.offset = OffsetEarliest
    q.timestampMs = timestampMs.value ?? Date.now()
  }
  return q
}

async function runQuery(): Promise<void> {
  await store.fetch(props.tabId, props.connectionId, props.topic, buildQuery())
}

async function loadMore(): Promise<void> {
  await store.fetchMore(props.tabId, props.connectionId, props.topic)
}

function openDetail(m: Message): void {
  store.select(props.tabId, m)
  detailOpen.value = true
}

function closeDetail(): void {
  detailOpen.value = false
  store.select(props.tabId, null)
}

watch(
  () => [props.connectionId, props.topic],
  () => runQuery(),
)

onMounted(runQuery)
</script>

<template>
  <div class="browser" data-test="message-browser">
    <div class="filter-bar">
      <label class="filter-item">
        分区
        <select v-model="partition" data-test="filter-partition" class="input">
          <option v-for="opt in partitionOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
        </select>
      </label>
      <label class="filter-item">
        起点
        <select v-model="mode" data-test="filter-mode" class="input">
          <option value="earliest">最早 Earliest</option>
          <option value="latest">最新 Latest</option>
          <option value="timestamp">指定时间戳</option>
        </select>
      </label>
      <label v-if="mode === 'timestamp'" class="filter-item">
        时间戳(ms)
        <input v-model.number="timestampMs" data-test="filter-timestamp" type="number" class="input" placeholder="毫秒时间戳" />
      </label>
      <label class="filter-item">
        条数
        <input v-model.number="limit" data-test="filter-limit" type="number" min="1" max="10000" class="input" />
      </label>
      <button class="btn primary" type="button" data-test="btn-query" :disabled="st.loading" @click="runQuery">
        {{ st.loading ? '查询中…' : '查询' }}
      </button>
      <div class="filter-actions">
        <button class="btn ghost" type="button" data-test="btn-open-sql" @click="emit('open-sql')">查询控制台</button>
        <button class="btn ghost" type="button" data-test="btn-open-producer" @click="emit('open-producer')">生产消息</button>
      </div>
    </div>

    <div v-if="st.error" class="msg err" data-test="browse-error">{{ st.error }}</div>

    <div class="table-wrap" data-test="browse-table">
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
          <tr
            v-for="m in st.messages"
            :key="`${m.partition}:${m.offset}`"
            class="row"
            data-test="message-row"
            @click="openDetail(m)"
          >
            <td>{{ m.partition }}</td>
            <td class="mono">{{ m.offset }}</td>
            <td class="mono">{{ formatTime(m.timestamp) }}</td>
            <td class="mono truncate">{{ displayValue(m.key) }}</td>
            <td class="truncate">{{ displayValue(m.value) }}</td>
          </tr>
          <tr v-if="st.messages.length === 0 && !st.loading">
            <td colspan="5" class="empty" data-test="browse-empty">暂无消息</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div class="actions">
      <button
        v-if="st.hasMore"
        class="btn ghost"
        type="button"
        data-test="btn-load-more"
        :disabled="st.loading"
        @click="loadMore"
      >
        {{ st.loading ? '加载中…' : '加载更多' }}
      </button>
      <span class="count" data-test="message-count">{{ st.messages.length }} 条</span>
    </div>

    <MessageDetailDrawer :message="st.selected" :show="detailOpen" @close="closeDetail" />
  </div>
</template>

<style scoped>
.browser { display: flex; flex-direction: column; height: 100%; font-family: var(--font); color: var(--text); }
.filter-bar { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; padding: 12px 16px; border-bottom: 1px solid var(--border); background: var(--bg-elevated); }
.filter-item { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
.filter-actions { margin-left: auto; display: flex; gap: 8px; align-items: flex-end; }
.input {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.btn { border-radius: 7px; padding: 6px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.msg { padding: 8px 16px; font-size: 13px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.table-wrap { flex: 1; overflow: auto; background: var(--bg-elevated); }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { position: sticky; top: 0; background: var(--bg-subtle); text-align: left; padding: 8px 12px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border); z-index: 1; }
.table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.row { cursor: pointer; transition: background 0.1s ease; }
.row:hover { background: var(--bg-hover); }
.mono { font-family: var(--mono); }
.truncate { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--text-tertiary); padding: 24px; }
.actions { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border); background: var(--bg-elevated); }
.count { font-size: 12px; color: var(--text-tertiary); }
</style>
