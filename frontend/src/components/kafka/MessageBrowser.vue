<script setup lang="ts">
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import { useBrowseStore } from '@/store/browse'
import type { MessageQuery } from '@/store/browse'
import { OffsetEarliest, OffsetLatest } from '@/api/types'
import type { Message } from '@/api/types'
import { formatTime, displayValue } from '@/utils/format'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, exportCsv, exportJsonl, saveFile } from '@/utils/export'
import ExportDropdown from '@/components/common/ExportDropdown.vue'
import MessageDetailDrawer from './MessageDetailDrawer.vue'

const props = withDefaults(
  defineProps<{
    tabId: string
    connectionId: string
    topic: string
    partitions: number[]
    refreshRequest?: number
  }>(),
  { refreshRequest: 0 },
)
const emit = defineEmits<{ (e: 'open-producer'): void }>()

const store = useBrowseStore()
const st = computed(() => store.stateFor(props.tabId))

const mode = ref<'earliest' | 'latest' | 'timestamp'>('earliest')
const partition = ref(-1)
const limit = ref(500)
const timestampMs = ref<number | null>(null)
const startTime = ref('')
const endTime = ref('')
const detailOpen = ref(false)

const partitionOptions = computed(() => [
  { label: 'All', value: -1 },
  ...props.partitions.map((p) => ({ label: String(p), value: p })),
])

// dtToMs converts a datetime-local value ('') to unix ms; empty input = unset.
function dtToMs(v: string): number | null {
  if (!v) return null
  const ms = new Date(v).getTime()
  return Number.isFinite(ms) ? ms : null
}

function buildQuery(): Partial<MessageQuery> {
  const q: Partial<MessageQuery> = { partition: partition.value, limit: limit.value }
  const startMs = dtToMs(startTime.value)
  if (startMs != null) {
    // A filled start time takes precedence over the 起点 mode select.
    q.offset = OffsetEarliest
    q.timestampMs = startMs
    q.endTimeMs = dtToMs(endTime.value)
    return q
  }
  q.endTimeMs = null
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

// Offset jump: fetch one batch starting at the entered offset and highlight
// the record at that offset. The 时间戳跳转 entry is the existing 起始时间
// input — a time query highlights its first returned record (see targetKey).
const jumpOffsetInput = ref<number | ''>('')
const jumpValid = computed(
  () => typeof jumpOffsetInput.value === 'number' && Number.isInteger(jumpOffsetInput.value) && jumpOffsetInput.value >= 0,
)

async function jumpToOffset(): Promise<void> {
  const offset = jumpOffsetInput.value
  if (typeof offset !== 'number' || !Number.isInteger(offset) || offset < 0) return
  await store.jumpToOffset(props.tabId, props.connectionId, props.topic, offset, {
    partition: partition.value,
    limit: limit.value,
  })
}

// targetKey identifies the highlighted jump-target row; null = no highlight.
const targetKey = computed(() => store.targetKey(props.tabId))

function isTarget(m: Message): boolean {
  return targetKey.value === `${m.partition}:${m.offset}`
}

// Scroll the jump-target row into view whenever the target changes or a jump
// completes. The second part of the key (scrollRequest) makes a repeat jump to
// the same offset re-scroll even though the resolved target key is unchanged.
// Concatenating into a primitive string compares by value, so pagination
// appends that leave the target untouched do not re-trigger a scroll. The
// optional call keeps environments without scrollIntoView (jsdom) safe; the
// highlight itself survives load-more appends without re-scrolling.
const tableWrap = ref<HTMLElement | null>(null)

watch(
  () => `${targetKey.value}|${st.value.scrollRequest}`,
  async () => {
    const key = targetKey.value
    if (!key) return
    await nextTick()
    tableWrap.value?.querySelector('[data-test="target-row"]')?.scrollIntoView?.({ block: 'center' })
  },
)

function openDetail(m: Message): void {
  store.select(props.tabId, m)
  detailOpen.value = true
}

function closeDetail(): void {
  detailOpen.value = false
  store.select(props.tabId, null)
}

// exportAs stores the loaded messages in the picked format via the native
// save dialog. The dropdown component owns its open state and outside-click
// closing.
function exportAs(format: 'csv' | 'jsonl'): void {
  if (format === 'csv') {
    void saveFile(`messages-${props.topic}`, exportCsv(st.value.messages, MESSAGE_EXPORT_COLUMNS), CSV_MIME)
  } else {
    void saveFile(`messages-${props.topic}`, exportJsonl(st.value.messages), JSONL_MIME)
  }
}

watch(
  () => [props.connectionId, props.topic],
  () => runQuery(),
)

// Unified refresh: Layout bumps refreshRequest (topbar button / tab context
// menu) and each data panel re-runs its own fetch path. The watcher only
// fires on increments, so mount keeps its single initial runQuery.
watch(
  () => props.refreshRequest,
  () => {
    if (props.refreshRequest > 0) void runQuery()
  },
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
        起始时间
        <input v-model="startTime" data-test="filter-start-time" type="datetime-local" class="input" />
      </label>
      <label class="filter-item">
        结束时间
        <input
          v-model="endTime"
          data-test="filter-end-time"
          type="datetime-local"
          class="input"
          :disabled="!startTime"
          :title="startTime ? undefined : '起始时间为空时结束时间无效'"
        />
      </label>
      <label class="filter-item">
        条数
        <input v-model.number="limit" data-test="filter-limit" type="number" min="1" max="10000" class="input" />
      </label>
      <label class="filter-item">
        跳转 Offset
        <input v-model.number="jumpOffsetInput" data-test="jump-offset-input" type="number" min="0" class="input" placeholder="输入 offset" />
      </label>
      <button class="btn ghost" type="button" data-test="btn-jump-offset" :disabled="!jumpValid || st.loading" @click="jumpToOffset">
        跳转
      </button>
      <button class="btn primary" type="button" data-test="btn-query" :disabled="st.loading" @click="runQuery">
        {{ st.loading ? '查询中…' : '查询' }}
      </button>
      <div class="filter-actions">
        <button class="btn ghost" type="button" data-test="btn-open-producer" @click="emit('open-producer')">生产消息</button>
        <ExportDropdown :disabled="st.messages.length === 0" @export="exportAs" />
      </div>
    </div>

    <div v-if="st.error" class="msg err" data-test="browse-error">{{ st.error }}</div>

    <div ref="tableWrap" class="table-wrap" data-test="browse-table">
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
            :class="{ 'row--target': isTarget(m) }"
            :data-test="isTarget(m) ? 'target-row' : 'message-row'"
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
.row--target { background: var(--accent-soft); box-shadow: inset 2px 0 0 var(--accent); }
.row--target:hover { background: var(--accent-soft); }
.mono { font-family: var(--mono); }
.truncate { max-width: 320px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.empty { text-align: center; color: var(--text-tertiary); padding: 24px; }
.actions { display: flex; align-items: center; gap: 12px; padding: 8px 16px; border-top: 1px solid var(--border); background: var(--bg-elevated); }
.count { font-size: 12px; color: var(--text-tertiary); }
</style>
