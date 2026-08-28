<script setup lang="ts">
import { onMounted, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { ClusterHealth } from '@/api/types'

const props = withDefaults(
  defineProps<{ connectionId: string; refreshRequest?: number }>(),
  { refreshRequest: 0 },
)

const health = ref<ClusterHealth | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// load fetches the cluster health snapshot of the connection.
async function load(): Promise<void> {
  loading.value = true
  error.value = null
  try {
    health.value = await getApi().describeCluster(props.connectionId)
  } catch (e) {
    health.value = null
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

onMounted(load)

// Unified refresh from the top bar / tab context menu: re-run the local
// load() (describeCluster). Only fires on increments, so mount keeps its
// single initial load.
watch(
  () => props.refreshRequest,
  () => {
    if (props.refreshRequest > 0) void load()
  },
)

// Switching tabs patches this component instance in place (Layout does not
// key its workspace), so connectionId changes must drop the previous
// connection's data and refetch — same idiom as MessageBrowser/SqlConsole.
watch(
  () => props.connectionId,
  () => {
    health.value = null
    error.value = null
    load()
  },
)
</script>

<template>
  <div class="health-view" data-test="cluster-health-panel">
    <div v-if="loading" class="state" data-test="health-loading">加载中…</div>
    <div v-else-if="error" class="state err" data-test="health-error">{{ error }}</div>
    <template v-else-if="health">
      <div v-if="health.brokers.length === 0" class="state" data-test="health-empty">
        未获取到任何 Broker，请确认连接是否可用后重试。
      </div>
      <template v-else>
        <h3 class="section-title">概览</h3>
        <div class="summary" data-test="health-summary">
          <div class="summary-item">
            <span class="label">Kafka 版本</span>
            <span class="value mono" data-test="summary-version">{{ health.kafka_version || '未知' }}</span>
          </div>
          <div class="summary-item">
            <span class="label">Controller</span>
            <span class="value mono" data-test="summary-controller">broker {{ health.controller_id }}</span>
          </div>
          <div class="summary-item">
            <span class="label">Broker 数</span>
            <span class="value mono" data-test="summary-brokers">{{ health.brokers.length }}</span>
          </div>
          <div class="summary-item">
            <span class="label">Under-Replicated 分区</span>
            <span
              class="value mono"
              :class="{ danger: health.under_replicated_partitions > 0 }"
              data-test="urp-value"
            >{{ health.under_replicated_partitions }}</span>
          </div>
          <div class="summary-item wide">
            <span class="label">Cluster ID</span>
            <span class="value mono" data-test="summary-cluster-id">{{ health.cluster_id || '未知' }}</span>
          </div>
        </div>

        <h3 class="section-title">Broker 拓扑</h3>
        <div
          v-for="b in health.brokers"
          :key="b.id"
          class="broker-card"
          :class="{ offline: !b.online }"
          data-test="broker-card"
        >
          <div class="broker-line">
            <span class="mono broker-id" data-test="broker-id">broker {{ b.id }}</span>
            <span v-if="b.id === health.controller_id" class="controller-badge" data-test="controller-badge">controller</span>
            <span
              class="state-pill"
              :class="{ offline: !b.online }"
              :data-status="b.online ? 'online' : 'offline'"
              data-test="broker-state"
            >{{ b.online ? '在线' : '离线' }}</span>
          </div>
          <div class="broker-meta mono" data-test="broker-host">{{ b.host }}:{{ b.port }}</div>
          <div class="broker-meta">
            <span v-if="b.rack" class="rack" data-test="broker-rack">机架 {{ b.rack }}</span>
            <span data-test="broker-version">{{ b.version || '版本未知' }}</span>
          </div>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.health-view { max-width: 860px; padding: 4px 2px; color: var(--text); font-family: var(--font); }
.section-title {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.04em; margin: 14px 0 8px;
}
.section-title:first-child { margin-top: 0; }
.summary {
  display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 8px;
}
.summary-item {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px); padding: 9px 12px;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.summary-item.wide { grid-column: span 2; }
.summary-item .label { font-size: 11px; color: var(--text-secondary); }
.summary-item .value { font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.summary-item .value.danger { color: var(--danger); font-weight: 600; }
.mono { font-family: var(--mono); }
.broker-card {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px); padding: 10px 12px; margin-bottom: 8px;
  transition: border-color 0.15s ease, box-shadow 0.15s ease;
}
.broker-card.offline { border-color: var(--danger); box-shadow: 0 0 0 1px var(--danger) inset; }
.broker-line { display: flex; align-items: center; gap: 7px; }
.broker-id { font-size: 13px; font-weight: 600; }
.controller-badge {
  font-size: 10px; font-weight: 600; color: var(--info); background: var(--info-soft);
  padding: 1px 6px; border-radius: 99px; text-transform: uppercase; letter-spacing: 0.03em;
}
.state-pill {
  margin-left: auto; font-size: 11px; padding: 1px 8px; border-radius: 99px;
  color: var(--ok); background: var(--ok-soft); flex: none;
}
.state-pill.offline { color: var(--danger); background: var(--danger-soft); }
.broker-meta { margin-top: 4px; font-size: 12px; color: var(--text-secondary); display: flex; gap: 12px; flex-wrap: wrap; }
.broker-meta .rack { color: var(--text-secondary); }
.state { color: var(--text-secondary); font-size: 13px; padding: 4px 0; }
.state.err { color: var(--danger); }
</style>
