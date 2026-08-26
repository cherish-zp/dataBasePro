<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useGroupsStore } from '@/store/groups'
import type { ResetOffsetMode } from '@/api/types'
import SearchSelect, { type SelectOption } from '@/components/common/SearchSelect.vue'
import GroupLagPanel from './GroupLagPanel.vue'

const props = defineProps<{ tabId: string; connectionId: string; group?: string }>()

const store = useGroupsStore()
const st = computed(() => store.stateFor(props.tabId))

const selectedGroup = ref<string | null>(props.group ?? null)
const selectedTopic = ref<string | null>(null)
const resetMode = ref<ResetOffsetMode>('latest')
const timestampMs = ref<number | null>(null)

const groups = computed(() => st.value.groups)
const group = computed(() => groups.value.find((g) => g.name === selectedGroup.value) ?? null)
const topics = computed(() => Object.keys(group.value?.topics ?? {}))
const lags = computed(() => (selectedTopic.value ? group.value?.topics[selectedTopic.value] ?? [] : []))
const groupOptions = computed<SelectOption[]>(() => groups.value.map((g) => ({ value: g.name, label: `${g.name} (${g.state})` })))
const topicOptions = computed<SelectOption[]>(() => topics.value.map((t) => ({ value: t, label: t })))

function pickGroup(name: string): void {
  selectedGroup.value = name
  const g = groups.value.find((x) => x.name === name)
  const ts = g ? Object.keys(g.topics ?? {}) : []
  selectedTopic.value = ts[0] ?? null
}

async function refresh(): Promise<void> {
  await store.load(props.tabId, props.connectionId)
  if (selectedGroup.value == null && groups.value.length > 0) {
    pickGroup(groups.value[0].name)
  } else if (selectedGroup.value != null) {
    const g = groups.value.find((x) => x.name === selectedGroup.value)
    const ts = g ? Object.keys(g.topics ?? {}) : []
    if (selectedTopic.value == null || (ts.length > 0 && !ts.includes(selectedTopic.value))) {
      selectedTopic.value = ts[0] ?? null
    }
  }
}

watch(selectedGroup, (name) => {
  if (name) pickGroup(name)
})

async function reset(): Promise<void> {
  if (!selectedGroup.value || !selectedTopic.value) return
  await store.resetOffset(
    props.tabId,
    props.connectionId,
    selectedGroup.value,
    selectedTopic.value,
    resetMode.value,
    resetMode.value === 'timestamp' ? (timestampMs.value ?? Date.now()) : undefined,
  )
}

onMounted(refresh)
</script>

<template>
  <div class="group-view" data-test="group-view">
    <div class="toolbar">
      <label class="field" data-test="field-group">
        消费组
        <SearchSelect v-model="selectedGroup" :options="groupOptions" placeholder="选择消费组" />
      </label>
      <label class="field" data-test="field-topic">
        Topic
        <SearchSelect v-model="selectedTopic" :options="topicOptions" placeholder="选择 Topic" />
      </label>
      <button class="btn ghost" type="button" data-test="btn-refresh" :disabled="st.loading" @click="refresh">
        {{ st.loading ? '加载中…' : '刷新' }}
      </button>
    </div>

    <div v-if="st.error" class="msg err" data-test="group-error">{{ st.error }}</div>

    <GroupLagPanel :rows="lags" :loading="st.loading" />

    <div class="reset-panel" data-test="reset-panel">
      <span class="reset-title">重置 Offset</span>
      <label class="field">
        目标
        <select v-model="resetMode" data-test="select-reset-mode" class="input">
          <option value="latest">Latest</option>
          <option value="earliest">Earliest</option>
          <option value="timestamp">指定时间戳</option>
        </select>
      </label>
      <label v-if="resetMode === 'timestamp'" class="field">
        时间戳(ms)
        <input v-model.number="timestampMs" data-test="input-reset-timestamp" type="number" class="input" />
      </label>
      <button
        class="btn danger"
        type="button"
        data-test="btn-reset"
        :disabled="!selectedGroup || !selectedTopic || st.resetting"
        @click="reset"
      >
        {{ st.resetting ? '重置中…' : '重置' }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.group-view { padding: 16px; color: var(--text); font-family: var(--font); }
.toolbar { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; }
.field { display: flex; flex-direction: column; gap: 4px; font-size: 12px; color: var(--text-secondary); }
.input {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px; min-width: 160px;
  transition: border-color 0.15s ease, background 0.15s ease;
}
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.btn { border-radius: 7px; padding: 6px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.btn.danger { background: var(--warn-soft); color: var(--warn); border: 1px solid transparent; }
.btn.danger:hover:not(:disabled) { background: rgba(217, 119, 6, 0.2); }
.msg { padding: 8px 10px; font-size: 13px; margin-top: 8px; border-radius: 7px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.reset-panel { display: flex; gap: 12px; align-items: flex-end; flex-wrap: wrap; margin-top: 16px; padding-top: 14px; border-top: 1px solid var(--border); }
.reset-title { font-weight: 600; font-size: 13px; color: var(--text); padding-bottom: 6px; }
</style>
