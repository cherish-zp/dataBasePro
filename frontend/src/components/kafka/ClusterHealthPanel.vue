<script setup lang="ts">
import { ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { ClusterHealth } from '@/api/types'

const props = defineProps<{ connectionId: string; show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const health = ref<ClusterHealth | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)

// load fetches the cluster health snapshot of the selected connection.
async function load(): Promise<void> {
  if (!props.connectionId) return
  loading.value = true
  error.value = null
  health.value = null
  try {
    health.value = await getApi().describeCluster(props.connectionId)
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    loading.value = false
  }
}

watch(
  () => [props.show, props.connectionId] as const,
  ([show]) => {
    if (!show) {
      health.value = null
      error.value = null
      loading.value = false
      return
    }
    void load()
  },
  { immediate: true },
)
</script>

<template>
  <div v-if="show" class="drawer" data-test="cluster-health-panel">
    <div class="drawer-header">
      <span class="drawer-title">集群健康</span>
      <button class="drawer-close" data-test="drawer-close" type="button" @click="emit('close')">✕</button>
    </div>
    <div class="drawer-body">
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
.drawer-title { font-weight: 600; font-size: 15px; min-width: 0; }
.drawer-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 5px; padding: 1px 6px; flex: none; }
.drawer-close:hover { background: var(--bg-hover); color: var(--text); }
.drawer-body { padding: 16px 18px; overflow: auto; }
.section-title {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.04em; margin: 14px 0 8px;
}
.section-title:first-child { margin-top: 0; }
.summary {
  display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 8px;
}
.summary.wide { grid-template-columns: repeat(2, minmax(0, 1fr)); }
.summary-item {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px); padding: 9px 12px;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
}
.summary-item.wide { grid-column: 1 / -1; }
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
