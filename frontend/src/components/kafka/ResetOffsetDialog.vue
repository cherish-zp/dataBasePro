<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { ConsumerGroup, ResetOffsetMode } from '@/api/types'

const props = withDefaults(
  defineProps<{ show: boolean; connectionId: string; topic?: string | null; group?: string | null }>(),
  { topic: null, group: null },
)

const emit = defineEmits<{ (e: 'close'): void }>()

// mode 'rewind' is a UI-only convenience: it resolves to an explicit-offset
// reset of current - N per partition (clamped to the log start offset).
type DialogMode = ResetOffsetMode | 'rewind'

const groups = ref<ConsumerGroup[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const selectedGroup = ref<string | null>(null)
const selectedTopic = ref<string | null>(null)
const mode = ref<DialogMode>('latest')
const timestampMs = ref<number>(Date.now())
const rewindN = ref<number>(1000)

interface PreviewRow {
  partition: number
  current: number
  target: number | null
}
const previewRows = ref<PreviewRow[] | null>(null)
// editTargets backs the per-partition offset inputs of the 指定 Offset mode.
const editTargets = ref<Record<number, number>>({})
// rewindTargets holds the clamped targets computed by the last rewind preview.
const rewindTargets = ref<Record<number, number> | null>(null)
const resetting = ref(false)
const resetError = ref<string | null>(null)

const group = computed(() => groups.value.find((g) => g.name === selectedGroup.value) ?? null)
const isStable = computed(() => group.value?.state === 'Stable')
const topicRows = computed(() => {
  const t = selectedTopic.value
  if (!t) return []
  return group.value?.topics?.[t] ?? []
})

const topicOptions = computed<string[]>(() => {
  if (props.topic) return [props.topic]
  const set = new Set<string>()
  for (const g of groups.value) {
    for (const t of Object.keys(g.topics ?? {})) set.add(t)
  }
  return [...set].sort()
})

// dryRunReady: a preview exists (or is not needed because confirm recomputes
// everything) and a group/topic pair is picked.
const canConfirm = computed((): boolean => {
  if (!selectedGroup.value || !selectedTopic.value) return false
  if (mode.value === 'rewind') return rewindTargets.value !== null
  return previewRows.value !== null
})

// Any input that changes the reset target invalidates a shown preview.
watch([selectedGroup, selectedTopic, mode, timestampMs, rewindN], () => {
  previewRows.value = null
  editTargets.value = {}
  rewindTargets.value = null
  resetError.value = null
})

function pickGroup(name: string): void {
  selectedGroup.value = name || null
  const g = groups.value.find((x) => x.name === name)
  const ts = g ? Object.keys(g.topics ?? {}) : []
  if (props.topic) {
    selectedTopic.value = props.topic
  } else {
    selectedTopic.value = ts[0] ?? null
  }
}

watch(
  () => props.show,
  (show) => {
    if (!show) return
    groups.value = []
    previewRows.value = null
    editTargets.value = {}
    rewindTargets.value = null
    resetError.value = null
    mode.value = 'latest'
    void open()
  },
  { immediate: true },
)

async function open(): Promise<void> {
  loading.value = true
  loadError.value = null
  try {
    groups.value = await getApi().listConsumerGroups(props.connectionId)
    const pre = props.group ?? groups.value[0]?.name ?? null
    selectedGroup.value = pre
    const g = groups.value.find((x) => x.name === pre)
    const ts = g ? Object.keys(g.topics ?? {}) : []
    selectedTopic.value = props.topic ?? ts[0] ?? null
  } catch (e) {
    loadError.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

// previewReset builds the dry-run table. latest targets come straight from the
// lag data; earliest/timestamp targets come from the read-only preview API;
// rewind clamps current - N to the log start; offset prefills editable inputs
// with the current offsets.
async function previewReset(): Promise<void> {
  if (!selectedGroup.value || !selectedTopic.value) return
  const rows: PreviewRow[] = topicRows.value.map((r) => ({
    partition: r.partition,
    current: r.current_offset,
    target: null,
  }))
  previewRows.value = rows
  const gid = selectedGroup.value
  const tid = selectedTopic.value
  try {
    if (mode.value === 'latest') {
      for (const row of rows) {
        const src = topicRows.value.find((r) => r.partition === row.partition)
        if (src) row.target = src.log_end_offset
      }
    } else if (mode.value === 'rewind') {
      const starts = await getApi().previewResetOffset({
        connection_id: props.connectionId,
        group: gid,
        topic: tid,
        mode: 'earliest',
      })
      const targets: Record<number, number> = {}
      for (const row of rows) {
        const start = starts[row.partition] ?? 0
        const target = Math.max(start, row.current - (rewindN.value || 0))
        targets[row.partition] = target
        row.target = target
      }
      rewindTargets.value = targets
    } else if (mode.value === 'offset') {
      const targets: Record<number, number> = {}
      for (const row of rows) targets[row.partition] = row.current
      editTargets.value = targets
      for (const row of rows) row.target = row.current
    } else {
      const offsets = await getApi().previewResetOffset({
        connection_id: props.connectionId,
        group: gid,
        topic: tid,
        mode: mode.value,
        timestamp_ms: mode.value === 'timestamp' ? timestampMs.value || Date.now() : undefined,
      })
      for (const row of rows) {
        const t = offsets[row.partition]
        if (t !== undefined) row.target = t
      }
    }
  } catch {
    // Targets degrade to "—"; the preview table itself stays visible.
  }
  // A mode/group switch while the preview was in flight cleared the table.
  if (previewRows.value !== rows) return
}

async function confirmReset(): Promise<void> {
  if (!selectedGroup.value || !selectedTopic.value || resetting.value) return
  resetting.value = true
  resetError.value = null
  try {
    if (mode.value === 'offset') {
      await getApi().resetConsumerGroupOffset({
        connection_id: props.connectionId,
        group: selectedGroup.value,
        topic: selectedTopic.value,
        mode: 'offset',
        per_partition_offsets: { ...editTargets.value },
      })
    } else if (mode.value === 'rewind') {
      if (!rewindTargets.value) return
      await getApi().resetConsumerGroupOffset({
        connection_id: props.connectionId,
        group: selectedGroup.value,
        topic: selectedTopic.value,
        mode: 'offset',
        per_partition_offsets: { ...rewindTargets.value },
      })
    } else {
      await getApi().resetConsumerGroupOffset({
        connection_id: props.connectionId,
        group: selectedGroup.value,
        topic: selectedTopic.value,
        mode: mode.value,
        timestamp_ms: mode.value === 'timestamp' ? timestampMs.value || Date.now() : undefined,
      })
    }
    emit('close')
  } catch (e) {
    resetError.value = e instanceof Error ? e.message : String(e)
  } finally {
    resetting.value = false
  }
}
</script>

<template>
  <Teleport to="body">
    <div v-if="show" class="overlay" @click.self="emit('close')">
      <div class="dialog" data-test="reset-offset-dialog">
        <div class="head">
          <span class="title">重置消费位点</span>
          <button class="close" type="button" data-test="btn-reset-x" @click="emit('close')">✕</button>
        </div>

        <div v-if="loadError" class="msg err" data-test="reset-load-error">{{ loadError }}</div>
        <div v-else-if="loading" class="msg" data-test="reset-loading">加载消费组…</div>

        <template v-else>
          <div class="form">
            <label class="field">
              <span class="label">Topic</span>
              <select
                class="input"
                data-test="select-reset-topic"
                :disabled="!!props.topic"
                :value="selectedTopic ?? ''"
                @change="selectedTopic = ($event.target as HTMLSelectElement).value || null"
              >
                <option v-for="t in topicOptions" :key="t" :value="t">{{ t }}</option>
              </select>
            </label>
            <label class="field">
              <span class="label">消费组</span>
              <select
                class="input"
                data-test="select-reset-group"
                :value="selectedGroup ?? ''"
                @change="pickGroup(($event.target as HTMLSelectElement).value)"
              >
                <option v-for="g in groups" :key="g.name" :value="g.name" data-test="reset-group-option">
                  {{ g.name }}（{{ g.state }}）
                </option>
              </select>
            </label>
          </div>

          <div v-if="isStable" class="msg warn" data-test="reset-stable-warning">
            ⚠ 该消费组仍在运行（Stable），broker 将拒绝提交。请先停止消费者，再执行重置。
          </div>

          <div class="form">
            <label class="field">
              <span class="label">目标位置</span>
              <select v-model="mode" class="input" data-test="select-reset-mode">
                <option value="earliest">Earliest（最早）</option>
                <option value="latest">Latest（最新）</option>
                <option value="timestamp">指定时间戳</option>
                <option value="offset">指定 Offset</option>
                <option value="rewind">回退 N 条</option>
              </select>
            </label>
            <label v-if="mode === 'timestamp'" class="field">
              <span class="label">时间戳 (unix ms)</span>
              <input v-model.number="timestampMs" class="input" type="number" data-test="input-reset-timestamp" />
            </label>
            <label v-if="mode === 'rewind'" class="field">
              <span class="label">回退条数 N</span>
              <input v-model.number="rewindN" class="input" type="number" min="1" data-test="input-rewind-n" />
            </label>
            <button class="btn ghost" type="button" data-test="btn-reset-dry-run" :disabled="!selectedGroup || !selectedTopic" @click="previewReset">
              预览 (Dry-run)
            </button>
          </div>

          <table v-if="previewRows" class="table" data-test="reset-preview-table">
            <thead>
              <tr>
                <th>Partition</th>
                <th>当前 Offset</th>
                <th>目标 Offset</th>
                <th>变化</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in previewRows" :key="row.partition" data-test="reset-row">
                <td class="mono">{{ row.partition }}</td>
                <td class="mono">{{ row.current }}</td>
                <td v-if="mode === 'offset'" class="mono">
                  <input
                    v-model.number="editTargets[row.partition]"
                    class="input num"
                    type="number"
                    :data-test="`reset-row-input-${row.partition}`"
                  />
                </td>
                <td v-else class="mono" data-test="reset-row-target">{{ row.target ?? '—' }}</td>
                <td class="mono delta">{{ row.target == null ? '—' : row.target - row.current }}</td>
              </tr>
              <tr v-if="previewRows.length === 0">
                <td colspan="4" class="empty">该消费组在此 Topic 上没有已提交的位点</td>
              </tr>
            </tbody>
          </table>

          <div v-if="resetError" class="msg err" data-test="reset-error">{{ resetError }}</div>

          <div class="actions">
            <button class="btn ghost" type="button" data-test="btn-reset-cancel" :disabled="resetting" @click="emit('close')">
              取消
            </button>
            <button
              class="btn danger"
              type="button"
              data-test="btn-reset-confirm"
              :disabled="!canConfirm || resetting"
              :title="isStable ? '消费组 Stable 时 broker 将拒绝提交' : ''"
              @click="confirmReset"
            >
              {{ resetting ? '提交中…' : '确认重置' }}
            </button>
          </div>
        </template>
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
  width: 560px;
  max-width: calc(100vw - 48px);
  max-height: calc(100vh - 64px);
  overflow: auto;
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
.form { display: flex; gap: 10px; align-items: flex-end; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 4px; flex: 1; min-width: 150px; }
.label { font-size: 12px; color: var(--text-secondary); }
.input {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px; width: 100%; box-sizing: border-box;
}
.input.num { padding: 3px 6px; }
.input:focus { outline: none; border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }
.msg { font-size: 13px; padding: 8px 10px; border-radius: 7px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.msg.warn { background: var(--warn-soft); color: var(--warn); }
.table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  background: var(--bg-subtle); border: 1px solid var(--border);
  border-radius: 9px; overflow: hidden;
}
.table th {
  text-align: left; padding: 6px 10px; color: var(--text-secondary);
  font-weight: 600; border-bottom: 1px solid var(--border); background: var(--bg-hover);
}
.table td { padding: 4px 10px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.delta { color: var(--text-secondary); }
.empty { text-align: center; color: var(--text-tertiary); padding: 12px; }
.actions { display: flex; justify-content: flex-end; gap: 8px; }
.btn { border-radius: 7px; padding: 6px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.btn.danger { background: var(--danger); color: #fff; }
.btn.danger:hover:not(:disabled) { background: var(--danger-hover, var(--danger)); filter: brightness(1.08); }
</style>
