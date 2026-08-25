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
        </tr>
      </thead>
      <tbody>
        <tr v-for="l in rows" :key="l.partition" class="row" data-test="lag-row">
          <td>{{ l.partition }}</td>
          <td class="mono">{{ l.current_offset }}</td>
          <td class="mono">{{ l.log_end_offset }}</td>
          <td class="mono" :class="{ 'lag-high': l.lag > 0 }" data-test="lag-value">{{ l.lag }}</td>
        </tr>
        <tr v-if="rows.length === 0 && !loading">
          <td colspan="4" class="empty" data-test="lag-empty">暂无 lag 数据</td>
        </tr>
      </tbody>
    </table>
  </div>
</template>

<style scoped>
.lag-panel { margin-top: 14px; }
.lag-header { font-weight: 600; margin-bottom: 6px; color: #c3ccd6; }
.table { width: 100%; border-collapse: collapse; font-size: 13px; }
.table th { text-align: left; padding: 8px 12px; color: #9aa7b5; font-weight: 600; border-bottom: 1px solid #2a3542; }
.table td { padding: 6px 12px; border-bottom: 1px solid #222c38; }
.mono { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
.lag-high { color: #e3b341; font-weight: 600; }
.empty { text-align: center; color: #7a8698; padding: 20px; }
</style>
