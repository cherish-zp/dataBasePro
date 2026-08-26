<script setup lang="ts">
import type { PartitionLag } from '@/api/types'

defineProps<{ rows: PartitionLag[]; loading?: boolean }>()
</script>

<template>
  <div class="lag-panel">
    <div class="lag-header">消费滞后（Lag）</div>
    <table class="table" data-test="lag-table">
      <thead>
        <tr>
          <th>Partition</th>
          <th>Current Offset</th>
          <th>Log End Offset</th>
          <th>Lag</th>
          <th>Host</th>
          <th>Consumer ID</th>
          <th>Client ID</th>
        </tr>
      </thead>
      <tbody>
        <tr v-for="l in rows" :key="l.partition" class="row" data-test="lag-row">
          <td>{{ l.partition }}</td>
          <td class="mono">{{ l.current_offset }}</td>
          <td class="mono">{{ l.log_end_offset }}</td>
          <td class="mono" :class="{ 'lag-high': l.lag > 0 }" data-test="lag-value">{{ l.lag }}</td>
          <td data-test="lag-client-host">{{ l.client_host || '—' }}</td>
          <td class="mono" data-test="lag-member-id">{{ l.member_id || '—' }}</td>
          <td class="mono" data-test="lag-client-id">{{ l.client_id || '—' }}</td>
        </tr>
        <tr v-if="rows.length === 0 && !loading">
          <td colspan="7" class="empty" data-test="lag-empty">暂无 lag 数据</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.lag-panel { margin-top: 14px; background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-md); overflow: hidden; }
.lag-header { font-weight: 600; margin-bottom: 0; color: var(--text); padding: 10px 12px; border-bottom: 1px solid var(--border); }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; padding: 8px 12px; color: var(--text-secondary); font-weight: 600; border-bottom: 1px solid var(--border); background: var(--bg-subtle); }
.table td { padding: 6px 12px; border-bottom: 1px solid var(--border); }
.mono { font-family: var(--mono); }
.lag-high { color: var(--warn); font-weight: 600; }
.empty { text-align: center; color: var(--text-tertiary); padding: 20px; }
</style>
