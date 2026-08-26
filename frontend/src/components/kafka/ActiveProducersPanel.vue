<script setup lang="ts">
import type { ActiveProducer } from '@/api/types'

defineProps<{ producers: ActiveProducer[]; loading?: boolean; note?: string }>()

function formatTime(ms: number): string {
  if (!ms) return '—'
  const d = new Date(ms)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
</script>

<template>
  <div class="producers-panel" data-test="producers-panel">
    <div class="producers-title">活跃生产者</div>
    <table class="table" data-test="producers-table">
      <thead>
        <tr>
          <th>Partition</th>
          <th>Producer ID</th>
          <th>Epoch</th>
          <th>Sequence</th>
          <th>最后生产时间</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="p in producers" :key="`${p.partition}-${p.producer_id}`" class="row" data-test="producer-row">
          <td>{{ p.partition }}</td>
          <td class="mono">{{ p.producer_id }}</td>
          <td class="mono">{{ p.producer_epoch }}</td>
          <td class="mono">{{ p.last_sequence }}</td>
          <td class="mono">{{ formatTime(p.last_timestamp) }}</td>
        </tr>
        <tr v-if="note && !loading">
          <td colspan="5" class="note" data-test="producers-note">{{ note }}</td>
        </tr>
        <tr v-else-if="producers.length === 0 && !loading">
          <td colspan="5" class="empty" data-test="producers-empty">暂无活跃生产者</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.producers-panel { margin-top: 14px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
.producers-title { font-weight: 600; color: var(--text); padding: 10px 12px; border-bottom: 1px solid var(--border); }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; padding: 8px 12px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border); background: var(--bg-subtle); }
.table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.empty { text-align: center; color: var(--text-tertiary); padding: 20px; }
.note { text-align: center; color: var(--warn); padding: 14px; font-size: 12px; }
</style>
