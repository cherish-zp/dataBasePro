<script setup lang="ts">
import { ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { TopicDetail } from '@/api/types'

const props = defineProps<{ connectionId: string; topic: string | null; show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const detail = ref<TopicDetail | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// load fetches the partition topology and key configs of the selected topic.
async function load(): Promise<void> {
  if (!props.topic) return
  loading.value = true
  error.value = null
  detail.value = null
  try {
    detail.value = await getApi().describeTopic(props.connectionId, props.topic)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.connectionId, props.topic] as const,
  ([show]) => {
    if (!show) {
      detail.value = null
      error.value = null
      loading.value = false
      return
    }
    void load()
  },
  { immediate: true },
)

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

        <h3 class="section-title">关键配置</h3>
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
.state { color: var(--text-secondary); font-size: 13px; padding: 4px 0; }
.state.err { color: var(--danger); }
</style>
