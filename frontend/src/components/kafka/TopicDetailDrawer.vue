<script setup lang="ts">
import { ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { TopicDetail } from '@/api/types'

const props = defineProps<{ connectionId: string; topic: string | null; show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const detail = ref<TopicDetail | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// Config editing state: drafts holds one editable value per whitelisted key.
const editing = ref(false)
const drafts = ref<Record<string, string>>({})
const saving = ref(false)
const cfgError = ref<string | null>(null)

// requestSeq guards against last-write-wins on a quick topic/connection switch
// and makes close/timeout void any in-flight callbacks: every load tags itself
// with a fresh sequence and a response whose seq is no longer current (a stale
// topic, or a save whose drawer was already closed) is dropped before it can
// touch the drawer state.
let requestSeq = 0

// load fetches the partition topology and key configs of the selected topic.
async function load(): Promise<void> {
  if (!props.topic) return
  const seq = ++requestSeq
  loading.value = true
  error.value = null
  detail.value = null
  try {
    const data = await getApi().describeTopic(props.connectionId, props.topic)
    if (seq !== requestSeq) return
    detail.value = data
  } catch (e) {
    if (seq !== requestSeq) return
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch(
  () => [props.show, props.connectionId, props.topic] as const,
  ([show]) => {
    if (!show) {
      // Closing the drawer voids any in-flight load/save so a late callback
      // can never render on the hidden drawer (reopening re-fetches).
      requestSeq += 1
      detail.value = null
      error.value = null
      loading.value = false
      editing.value = false
      saving.value = false
      cfgError.value = null
      drafts.value = {}
      return
    }
    void load()
  },
  { immediate: true },
)

// startEdit copies the described values into per-key drafts so edits start
// from the current broker state.
function startEdit(): void {
  if (!detail.value) return
  drafts.value = Object.fromEntries(detail.value.configs.map((c) => [c.key, c.value]))
  cfgError.value = null
  editing.value = true
}

function cancelEdit(): void {
  editing.value = false
  cfgError.value = null
}

// save sends every whitelisted row and, on success, re-describes the topic so
// the table reflects the broker's accepted values. On failure the error is
// shown and the user's edits are kept in place. If the drawer was closed or
// the topic switched while the save was in flight, the trailing load() is
// dropped (requestSeq was bumped in the meantime); the reopened drawer pulls
// fresh data on its own.
async function save(): Promise<void> {
  if (!detail.value || !props.topic || saving.value) return
  saving.value = true
  cfgError.value = null
  const seq = requestSeq
  try {
    const entries = detail.value.configs.map((c) => ({ key: c.key, value: drafts.value[c.key] ?? '' }))
    await getApi().alterTopicConfig({ connection_id: props.connectionId, topic: props.topic, entries })
    if (seq !== requestSeq) return
    editing.value = false
    await load()
  } catch (e) {
    if (seq !== requestSeq) return
    cfgError.value = e instanceof Error ? e.message : String(e)
  } finally {
    saving.value = false
  }
}

function listText(nums: number[]): string {
  return nums.join(', ')
}
</script>

<template>
  <div v-if="show && topic" class="drawer" data-test="topic-detail-drawer">
    <div class="drawer-header">
      <span class="drawer-title">Topic 详情 <span class="drawer-topic">{{ topic }}</span></span>
      <button class="drawer-close" data-test="drawer-close" type="button" @click="emit('close')">✕</button>
    </div>
    <div class="drawer-body">
      <div v-if="loading" class="state" data-test="detail-loading">加载中…</div>
      <div v-else-if="error" class="state err" data-test="detail-error">{{ error }}</div>
      <template v-else-if="detail">
        <h3 class="section-title">分区拓扑</h3>
        <table class="table" data-test="topo-table">
          <thead>
            <tr>
              <th>分区</th>
              <th>Leader</th>
              <th>Replicas</th>
              <th>ISR</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="p in detail.partitions" :key="p.id" data-test="topo-row">
              <td class="mono" data-test="row-partition">{{ p.id }}</td>
              <td class="mono" data-test="row-leader">{{ p.leader }}</td>
              <td class="mono" data-test="row-replicas">{{ listText(p.replicas) }}</td>
              <td class="mono" data-test="row-isr">{{ listText(p.isr) }}</td>
            </tr>
          </tbody>
        </table>

        <div class="cfg-head">
          <h3 class="section-title">关键配置</h3>
          <button
            v-if="detail.configs.length > 0 && !editing"
            class="btn ghost small"
            type="button"
            data-test="cfg-edit"
            @click="startEdit"
          >
            编辑
          </button>
        </div>
        <template v-if="editing">
          <table class="table" data-test="cfg-table">
            <thead>
              <tr>
                <th>配置项</th>
                <th>值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in detail.configs" :key="c.key" data-test="cfg-row">
                <td class="mono" data-test="cfg-key">{{ c.key }}</td>
                <td>
                  <input v-model="drafts[c.key]" class="cfg-input" data-test="cfg-input" />
                </td>
              </tr>
            </tbody>
          </table>
          <div v-if="cfgError" class="state err cfg-error" data-test="cfg-error">{{ cfgError }}</div>
          <div class="cfg-actions">
            <button class="btn ghost small" type="button" data-test="cfg-cancel" :disabled="saving" @click="cancelEdit">
              取消
            </button>
            <button class="btn primary small" type="button" data-test="cfg-save" :disabled="saving" @click="save">
              {{ saving ? '保存中…' : '保存' }}
            </button>
          </div>
        </template>
        <template v-else>
          <table v-if="detail.configs.length" class="table" data-test="cfg-table">
            <thead>
              <tr>
                <th>配置项</th>
                <th>值</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="c in detail.configs" :key="c.key" data-test="cfg-row">
                <td class="mono" data-test="cfg-key">{{ c.key }}</td>
                <td class="mono" data-test="cfg-value">{{ c.value }}</td>
              </tr>
            </tbody>
          </table>
          <div v-else class="state" data-test="config-empty">（无配置）</div>
        </template>
      </template>
    </div>
  </div>
</template>

<style scoped>
.drawer {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  width: 460px;
  background: var(--glass-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border-left: 1px solid var(--border);
  box-shadow: var(--glass-shadow);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  color: var(--text);
  font-family: var(--font);
}
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid var(--border);
}
.drawer-title { font-weight: 600; font-size: 15px; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.drawer-topic { font-family: var(--mono); font-size: 13px; color: var(--text-secondary); margin-left: 4px; }
.drawer-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 5px; padding: 1px 6px; flex: none; }
.drawer-close:hover { background: var(--bg-hover); color: var(--text); }
.drawer-body { padding: 16px 18px; overflow: auto; }
.cfg-head { display: flex; align-items: center; justify-content: space-between; margin-top: 14px; }
.cfg-head .section-title { margin-top: 0; }
.section-title {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.04em; margin: 14px 0 8px;
}
.section-title:first-child { margin-top: 0; }
.table {
  width: 100%; border-collapse: collapse; font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px); overflow: hidden;
}
.table th {
  text-align: left; padding: 7px 12px; color: var(--text-secondary);
  font-weight: 600; border-bottom: 1px solid var(--border); background: var(--bg-subtle);
}
.table td { padding: 5px 12px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.cfg-input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-subtle); border: 1px solid var(--border);
  border-radius: 6px; color: var(--text);
  padding: 4px 8px; font-size: 13px; font-family: var(--mono);
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.cfg-input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.cfg-actions { display: flex; gap: 8px; justify-content: flex-end; margin-top: 10px; }
.cfg-error { margin-top: 10px; }
.state { color: var(--text-secondary); font-size: 13px; padding: 4px 0; }
.state.err { color: var(--danger); }
.btn { border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.small { padding: 4px 12px; font-size: 12px; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
</style>
