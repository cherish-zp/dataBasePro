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
  background: #1e2733;
  border-left: 1px solid #33404f;
  box-shadow: -8px 0 24px rgba(0, 0, 0, 0.35);
  z-index: 1000;
  display: flex;
  flex-direction: column;
  color: #d6dee8;
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
}
.drawer-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 14px 18px;
  border-bottom: 1px solid #33404f;
}
.drawer-title { font-weight: 600; font-size: 15px; }
.drawer-close { background: none; border: none; color: #9aa7b5; font-size: 16px; cursor: pointer; }
.drawer-body { padding: 16px 18px; overflow: auto; }
.meta { display: flex; gap: 8px; flex-wrap: wrap; }
.tag { padding: 2px 10px; border-radius: 4px; font-size: 12px; font-family: ui-monospace, monospace; }
.tag-partition { background: #1f6feb22; color: #6ea8fe; border: 1px solid #1f6feb55; }
.tag-offset { background: #d2992222; color: #e3b341; border: 1px solid #d2992255; }
.tag-time { background: #3fb95022; color: #56d364; border: 1px solid #3fb95055; }
.kv { margin-top: 16px; }
.label { font-size: 12px; color: #9aa7b5; text-transform: uppercase; letter-spacing: 0.04em; }
.value {
  background: #151c26;
  border: 1px solid #2a3542;
  border-radius: 6px;
  padding: 10px;
  margin: 6px 0 0;
  white-space: pre-wrap;
  word-break: break-all;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 13px;
}
</style>
