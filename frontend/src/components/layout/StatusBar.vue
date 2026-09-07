<script setup lang="ts">
import { computed } from 'vue'
import { useConnectionsStore } from '@/store/connections'
import { APP_VERSION } from '@/version'

// The bottom status bar reads the reactive connections store directly, so
// counts and the latest error update in place whenever the store changes —
// no manual refresh and no data-source-specific logic (works for Kafka and
// future MySQL/ES backends alike).
const store = useConnectionsStore()

// total counts every saved connection; online only counts connections whose
// status is exactly 'connected' — 'connecting' and other transient states are
// neither online nor offline.
const total = computed(() => store.connections.length)
const online = computed(() => Object.values(store.statusById).filter((s) => s === 'connected').length)
</script>

<template>
  <footer class="statusbar" data-test="status-bar">
    <span class="statusbar-count" data-test="status-count">连接 {{ total }} · 在线 {{ online }}</span>
    <span class="statusbar-right">
      <span class="statusbar-version" data-test="status-version">v{{ APP_VERSION }}</span>
      <span class="statusbar-author" data-test="status-author">By Mr Zp</span>
    </span>
    <span v-if="store.error" class="statusbar-error" data-test="status-error">最近错误：{{ store.error }}</span>
  </footer>
</template>

<style scoped>
.statusbar {
  flex: none;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 0;
  padding: 5px 16px;
  border-top: 1px solid var(--border);
  background: var(--glass-bg);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  color: var(--text-secondary);
  font-size: 12px;
  font-family: var(--font);
}
.statusbar-count { white-space: nowrap; }
.statusbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.statusbar-version,
.statusbar-author { white-space: nowrap; color: var(--text-tertiary); }
.statusbar-error {
  min-width: 0;
  color: var(--danger);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
