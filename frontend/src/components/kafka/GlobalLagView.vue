<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { ConsumerGroup } from '@/api/types'
import { flattenGroupLag } from '@/utils/lag'
import { fuzzyScore } from '@/utils/fuzzy'

const props = withDefaults(
  defineProps<{ connectionId: string; refreshRequest?: number }>(),
  { refreshRequest: 0 },
)

const groups = ref<ConsumerGroup[]>([])
const loading = ref(false)
const error = ref<string | null>(null)
const query = ref('')

async function refresh(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    groups.value = await getApi().listConsumerGroups(props.connectionId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(refresh)

// Unified refresh from the top bar / tab context menu: re-run the local
// refresh() (listConsumerGroups). Only fires on increments, so mount keeps
// its single initial refresh.
watch(
  () => props.refreshRequest,
  () => {
    if (props.refreshRequest > 0) void refresh()
  },
)

// Switching lag tabs patches this component instance in place (Layout does not
// key its workspace), so connectionId changes must drop the previous
// connection's data and refetch — same idiom as MessageBrowser/SqlConsole.
watch(
  () => props.connectionId,
  () => {
    groups.value = []
    error.value = null
    query.value = ''
    refresh()
  },
)

// rows re-flattens the fetched groups and keeps them sorted by Lag descending
// even while filtering, so the biggest backlogs stay on top while searching.
// A row matches when either its group or its topic name fuzzy-matches.
const rows = computed(() => {
  const q = query.value.trim()
  const all = flattenGroupLag(groups.value)
  if (!q) return all
  return all.filter(
    (r) => fuzzyScore(q, r.group) !== Infinity || fuzzyScore(q, r.topic) !== Infinity,
  )
})

function emptyText(): string {
  return query.value.trim() ? '无匹配 Group / Topic' : '暂无 lag 数据'
}
</script>

<template>
  <div class="global-lag" data-test="global-lag-view">
    <div class="toolbar">
      <span class="title">Lag 总览</span>
      <input
        v-model="query"
        class="search-input"
        type="search"
        data-test="global-lag-search"
        placeholder="🔍 模糊搜索 Group / Topic…"
        autocapitalize="off"
        autocorrect="off"
        autocomplete="off"
        spellcheck="false"
      />
      <button class="btn ghost" type="button" data-test="btn-refresh" :disabled="loading" @click="refresh">
        {{ loading ? '加载中…' : '刷新' }}
      </button>
    </div>

    <div v-if="error" class="msg err" data-test="lag-error">{{ error }}</div>

    <table class="table" data-test="global-lag-table">
      <thead>
        <tr>
          <th>Group</th>
          <th>Topic</th>
          <th>Total Lag</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="r in rows" :key="`${r.group}:${r.topic}`" class="row" data-test="lag-row">
          <td class="mono" data-test="row-group">{{ r.group }}</td>
          <td class="mono" data-test="row-topic">{{ r.topic }}</td>
          <td class="mono" :class="{ 'lag-danger': r.lag > 1000, 'lag-warn': r.lag > 100 && r.lag <= 1000 }" data-test="lag-value">{{ r.lag }}</td>
        </tr>
        <tr v-if="rows.length === 0 && !loading && !error">
          <td colspan="3" class="empty" data-test="lag-empty">{{ emptyText() }}</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.global-lag { padding: 16px; color: var(--text); font-family: var(--font); }
.toolbar { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.title { font-weight: 600; font-size: 14px; }
.search-input {
  background: var(--bg-subtle); border: 1px solid var(--border); color: var(--text);
  border-radius: 7px; padding: 6px 9px; font-size: 13px; width: 220px;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.search-input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.search-input::placeholder { color: var(--text-tertiary); }
.btn {
  border-radius: 7px; padding: 6px 13px; font-size: 13px; cursor: pointer;
  border: 1px solid transparent;
  transition: background 0.15s ease, opacity 0.15s ease;
}
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
.msg { padding: 8px 10px; font-size: 13px; margin-top: 10px; border-radius: 7px; }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.table {
  margin-top: 12px; width: 100%; border-collapse: collapse; font-size: 13px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md); overflow: hidden;
}
.table th {
  text-align: left; padding: 8px 12px; color: var(--text-secondary);
  font-weight: 600; border-bottom: 1px solid var(--border); background: var(--bg-subtle);
}
.table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.lag-danger { color: var(--danger); font-weight: 600; }
.lag-warn { color: var(--warn); font-weight: 600; }
.empty { text-align: center; color: var(--text-tertiary); padding: 20px; }
</style>
