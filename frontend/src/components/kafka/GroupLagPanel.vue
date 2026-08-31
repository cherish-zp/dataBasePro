<script setup lang="ts">
import type { PartitionLag, ResetPreviewRow } from '@/api/types'

defineProps<{ rows: PartitionLag[]; loading?: boolean; preview?: ResetPreviewRow[] | null }>()

defineEmits<{ (e: 'confirm-reset'): void; (e: 'cancel-preview'): void }>()
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

    <div v-if="preview" class="dry-run" data-test="dry-run">
      <div class="dry-run-title">重置预览（Dry-run）— 请确认以下分区将被重置</div>
      <table class="table" data-test="dry-run-table">
        <thead>
          <tr>
            <th>Partition</th>
            <th>Current Offset</th>
            <th>New Offset</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="p in preview" :key="p.partition" class="row" data-test="dry-run-row">
            <td>{{ p.partition }}</td>
            <td class="mono">{{ p.current_offset }}</td>
            <td class="mono" data-test="dry-run-new-offset">{{ p.new_offset ?? '—' }}</td>
          </tr>
        </tbody>
      </table>
      <div class="dry-run-actions">
        <button class="btn danger" type="button" data-test="btn-confirm-reset" :disabled="!preview || preview.length === 0" @click="$emit('confirm-reset')">确认重置</button>
        <button class="btn ghost" type="button" data-test="btn-cancel-preview" @click="$emit('cancel-preview')">取消</button>
      </div>
    </div>
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
.dry-run { border-top: 1px solid var(--border); }
.dry-run-title { font-weight: 600; font-size: 13px; color: var(--warn); padding: 10px 12px; }
.dry-run-actions { display: flex; gap: 8px; padding: 10px 12px 12px; }
.btn { border-radius: 7px; padding: 6px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn.danger { background: var(--warn-soft); color: var(--warn); border: 1px solid transparent; }
.btn.danger:hover:not(:disabled) { background: rgba(217, 119, 6, 0.2); }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover { background: var(--bg-hover); }
</style>
