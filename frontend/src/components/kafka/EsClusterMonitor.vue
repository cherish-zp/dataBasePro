<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { getApi } from '@/api/client'
import type { EsClusterStats } from '@/api/types'
import { useTabsStore } from '@/store/tabs'
import { formatBytes } from '@/utils/bytes'

const props = defineProps<{ connectionId: string }>()
const tabs = useTabsStore()

const stats = ref<EsClusterStats | null>(null)
const loading = ref(false)
const error = ref<string | null>(null)
const updated = ref<Date | null>(null)
const auto = ref(true)

// requestSeq 防止快速刷新/轮询下的乱序覆盖:慢响应绝不能覆盖更新的快照,
// 每次拉取自带序号,过期结果在触碰面板状态前丢弃(ClusterHealthPanel 同款)。
let requestSeq = 0

// load 拉取连接的 ES 集群监控快照。失败写入面板内错误区(不弹全局提示);
// 已有数据时失败保留旧数据,成功后错误与数据一并刷新。
async function load(): Promise<void> {
  const seq = ++requestSeq
  loading.value = true
  error.value = null
  try {
    const data = await getApi().esClusterStats?.({ connection_id: props.connectionId })
    if (seq !== requestSeq) return
    if (!data) {
      error.value = '当前客户端暂不支持集群监控,请升级应用'
      return
    }
    stats.value = data
    updated.value = new Date()
  } catch (e) {
    if (seq !== requestSeq) return
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

function refresh(): void {
  void load()
}

// 自动轮询:10 秒一次;开关关闭即停、打开即恢复,卸载清理定时器。
const POLL_MS = 10_000
let timer: number | null = null

function startPolling(): void {
  if (timer !== null) return
  timer = window.setInterval(() => void load(), POLL_MS)
}

function stopPolling(): void {
  if (timer === null) return
  window.clearInterval(timer)
  timer = null
}

watch(auto, (on) => {
  if (on) startPolling()
  else stopPolling()
})

onMounted(() => {
  void load()
  if (auto.value) startPolling()
})

onBeforeUnmount(stopPolling)

const statusText = computed(() => {
  switch (stats.value?.status) {
    case 'green':
      return '健康'
    case 'yellow':
      return '部分副本未分配'
    case 'red':
      return '主分片未分配'
    default:
      return stats.value?.status ?? ''
  }
})

const updatedText = computed(() =>
  updated.value ? `最近更新 ${updated.value.toLocaleTimeString('zh-CN', { hour12: false })}` : '尚未更新',
)
</script>

<template>
  <div class="monitor" data-test="es-cluster-monitor">
    <div v-if="loading && !stats" class="state" data-test="monitor-loading">加载中…</div>
    <template v-else>
      <div v-if="error" class="state err" data-test="monitor-error">{{ error }}</div>
      <template v-if="stats">
        <div class="header">
          <div
            class="status-card"
            :class="`status-${stats.status}`"
            :data-status="stats.status"
            data-test="monitor-status"
          >
            <span class="status-dot" aria-hidden="true"></span>
            <div class="status-meta">
              <span class="cluster-name mono">{{ stats.cluster_name }}</span>
              <span class="status-label">{{ statusText }}（{{ stats.status }}）</span>
            </div>
          </div>
          <div class="header-side">
            <span class="updated" data-test="monitor-updated">{{ updatedText }}</span>
            <label class="auto">
              <input v-model="auto" type="checkbox" data-test="monitor-auto" />
              自动刷新
            </label>
            <button class="btn-refresh" type="button" data-test="monitor-refresh" @click="refresh">刷新</button>
          </div>
        </div>

        <h3 class="section-title">概览</h3>
        <div class="tiles" data-test="monitor-tiles">
          <div class="tile" data-test="tile-nodes">
            <span class="label">节点数</span>
            <span class="value mono">{{ stats.number_of_nodes }}</span>
            <span class="sub">数据节点 {{ stats.number_of_data_nodes }}</span>
          </div>
          <div class="tile" data-test="tile-indices">
            <span class="label">索引数</span>
            <span class="value mono">{{ stats.indices_count }}</span>
          </div>
          <div class="tile" data-test="tile-shards">
            <span class="label">分片</span>
            <span class="value mono" data-test="tile-shards-active">{{ stats.active_shards }}</span>
            <span class="sub mono" data-test="tile-shards-primary">主分片 {{ stats.active_primary_shards }}</span>
            <span class="sub">迁移 {{ stats.relocating_shards }} · 未分配 {{ stats.unassigned_shards }}</span>
          </div>
          <div class="tile" data-test="tile-docs">
            <span class="label">文档数</span>
            <span class="value mono">{{ stats.docs_count }}</span>
          </div>
          <div class="tile" data-test="tile-store">
            <span class="label">存储大小</span>
            <span class="value mono">{{ formatBytes(stats.store_size_bytes) }}</span>
          </div>
          <button
            class="tile clickable"
            type="button"
            data-test="tile-templates"
            title="打开索引模板管理"
            @click="tabs.openEsTemplates(connectionId)"
          >
            <span class="label">模板数</span>
            <span class="value mono">{{ stats.templates_count }}</span>
            <span class="sub">去管理 →</span>
          </button>
        </div>

        <h3 class="section-title">节点</h3>
        <div class="nodes" data-test="monitor-nodes">
          <div v-if="stats.nodes.length === 0" class="state" data-test="nodes-empty">无节点信息</div>
          <table v-else class="nodes-table">
            <thead>
              <tr>
                <th>名称</th>
                <th>IP</th>
                <th>角色</th>
                <th>堆%</th>
                <th>磁盘%</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="n in stats.nodes" :key="`${n.name}:${n.ip}`" data-test="node-row">
                <td>{{ n.name }}</td>
                <td class="mono">{{ n.ip }}</td>
                <td class="roles">{{ n.roles }}</td>
                <td class="mono" :class="{ danger: n.heap_percent >= 90 }" data-test="node-heap">{{ n.heap_percent }}%</td>
                <td class="mono" :class="{ danger: n.disk_percent >= 90 }" data-test="node-disk">{{ n.disk_percent }}%</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </template>
  </div>
</template>

<style scoped>
.monitor { height: 100%; overflow-y: auto; padding: 4px 2px; color: var(--text); font-family: var(--font); }
.state { color: var(--text-secondary); font-size: 13px; padding: 4px 0; }
.state.err { color: var(--danger); }
.header { display: flex; align-items: stretch; gap: 10px; flex-wrap: wrap; }
.status-card {
  display: flex; align-items: center; gap: 10px; flex: 1; min-width: 220px;
  background: var(--bg-elevated); border: 1px solid var(--border); border-left-width: 4px;
  border-radius: var(--radius-md, 10px); padding: 12px 14px;
}
.status-card.status-green { border-left-color: var(--ok); }
.status-card.status-yellow { border-left-color: var(--warn); }
.status-card.status-red { border-left-color: var(--danger); }
.status-dot { width: 10px; height: 10px; border-radius: 50%; flex: none; }
.status-card.status-green .status-dot { background: var(--ok); }
.status-card.status-yellow .status-dot { background: var(--warn); }
.status-card.status-red .status-dot { background: var(--danger); }
.status-meta { display: flex; flex-direction: column; gap: 2px; min-width: 0; }
.cluster-name { font-size: 14px; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.status-label { font-size: 12px; color: var(--text-secondary); }
.header-side { display: flex; align-items: center; gap: 12px; flex: none; }
.updated { font-size: 12px; color: var(--text-secondary); }
.auto { display: inline-flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-secondary); cursor: pointer; }
.auto input { accent-color: var(--accent); cursor: pointer; }
.btn-refresh {
  border: 1px solid var(--border-strong); background: transparent; color: var(--text);
  font-size: 12px; font-family: var(--font); border-radius: 7px; padding: 5px 12px;
  cursor: pointer; transition: background 0.15s ease;
}
.btn-refresh:hover { background: var(--bg-hover); }
.section-title {
  font-size: 12px; font-weight: 600; color: var(--text-secondary);
  text-transform: uppercase; letter-spacing: 0.04em; margin: 14px 0 8px;
}
.tiles {
  display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px;
}
.tile {
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px); padding: 9px 12px;
  display: flex; flex-direction: column; gap: 2px; min-width: 0;
  text-align: left; color: var(--text); font-family: var(--font);
}
.tile.clickable { cursor: pointer; transition: border-color 0.15s ease, background 0.15s ease; }
.tile.clickable:hover { border-color: var(--accent); background: var(--accent-soft); }
.tile .label { font-size: 11px; color: var(--text-secondary); }
.tile .value { font-size: 13px; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.tile .sub { font-size: 11px; color: var(--text-secondary); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.mono { font-family: var(--mono); }
.nodes-table {
  width: 100%; border-collapse: collapse; font-size: 12px;
  background: var(--bg-elevated); border: 1px solid var(--border);
  border-radius: var(--radius-md, 10px); overflow: hidden;
}
.nodes-table th,
.nodes-table td { padding: 7px 10px; text-align: left; border-bottom: 1px solid var(--border); }
.nodes-table th { font-size: 11px; font-weight: 600; color: var(--text-secondary); }
.nodes-table tbody tr:last-child td { border-bottom: none; }
.nodes-table .roles { color: var(--text-secondary); max-width: 220px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.nodes-table .danger { color: var(--danger); font-weight: 600; }
</style>
