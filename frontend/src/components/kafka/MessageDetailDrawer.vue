<script setup lang="ts">
import { computed } from 'vue'
import type { Message } from '@/api/types'
import { prettyJSON, formatTime, displayValue } from '@/utils/format'

const props = defineProps<{ message: Message | null; show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const body = computed(() => (props.message ? prettyJSON(displayValue(props.message.value)) : ''))
const key = computed(() => displayValue(props.message?.key))
</script>

<template>
  <div v-if="show && message" class="drawer" data-test="message-drawer">
    <div class="drawer-header">
      <span class="drawer-title">消息详情</span>
      <button class="drawer-close" data-test="drawer-close" type="button" @click="emit('close')">✕</button>
    </div>
    <div class="drawer-body">
      <div class="meta">
        <span class="tag tag-partition" data-test="meta-partition">Partition {{ message.partition }}</span>
        <span class="tag tag-offset" data-test="meta-offset">Offset {{ message.offset }}</span>
        <span class="tag tag-time">{{ formatTime(message.timestamp) }}</span>
      </div>
      <div class="kv">
        <span class="label">Key</span>
        <pre class="value" data-test="key-value">{{ key }}</pre>
      </div>
      <div class="kv">
        <span class="label">Value</span>
        <pre class="value" data-test="value-body">{{ body }}</pre>
      </div>
      <div v-if="message.headers && message.headers.length" class="kv">
        <span class="label">Headers</span>
        <pre class="value" data-test="headers-body">{{ prettyJSON(JSON.stringify(message.headers)) }}</pre>
      </div>
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
  background: rgba(255, 255, 255, 0.86);
  -webkit-backdrop-filter: var(--glass-blur);
  backdrop-filter: var(--glass-blur);
  border-left: 1px solid var(--border);
  box-shadow: -12px 0 40px rgba(0, 0, 0, 0.12);
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
.drawer-title { font-weight: 600; font-size: 15px; }
.drawer-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 5px; padding: 1px 6px; }
.drawer-close:hover { background: var(--bg-hover); color: var(--text); }
.drawer-body { padding: 16px 18px; overflow: auto; }
.meta { display: flex; gap: 8px; flex-wrap: wrap; }
.tag { padding: 2px 10px; border-radius: 6px; font-size: 12px; font-family: var(--mono); font-weight: 500; }
.tag-partition { background: var(--info-soft); color: var(--info); border: 1px solid transparent; }
.tag-offset { background: var(--warn-soft); color: var(--warn); border: 1px solid transparent; }
.tag-time { background: var(--ok-soft); color: var(--ok); border: 1px solid transparent; }
.kv { margin-top: 16px; }
.label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.value {
  background: var(--bg-subtle);
  border: 1px solid var(--border);
  border-radius: 8px;
  padding: 10px;
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: var(--mono);
  font-size: 13px;
  color: var(--text);
}
</style>
