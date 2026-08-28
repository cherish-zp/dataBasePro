<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import type { Message } from '@/api/types'
import { formatTime, displayValue, prettyJSON } from '@/utils/format'
import { renderJsonView } from '@/utils/jsonview'

const props = defineProps<{ message: Message | null; show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

// Per-open display state: reset whenever the drawer opens or the message
// changes, so each detail view starts formatted (when parseable) and collapsed.
const valueMode = ref<'formatted' | 'raw'>('formatted')
const keyMode = ref<'formatted' | 'raw'>('formatted')
const valueExpanded = ref(false)

watch(
  () => [props.show, props.message] as const,
  () => {
    valueMode.value = 'formatted'
    keyMode.value = 'formatted'
    valueExpanded.value = false
  },
)

const keyRaw = computed(() => displayValue(props.message?.key))
const keyView = computed(() => renderJsonView(keyRaw.value))
const keyFormatted = computed(() => keyView.value.ok && keyMode.value === 'formatted')

const valueRaw = computed(() => displayValue(props.message?.value))
const valueView = computed(() => renderJsonView(valueRaw.value))
const valueFormatted = computed(() => valueView.value.ok && valueMode.value === 'formatted')
const valueText = computed(() => (valueFormatted.value ? valueView.value.text : valueRaw.value))

// Collapse cap: .value.collapsed caps height at 18em = 12 lines at line-height
// 1.5; the toggle only appears past that threshold so short values stay clean.
// It is derived from the view's canonical text (pretty or raw passthrough) so
// the control stays visible across raw/formatted switches.
const LONG_LINES = 12
const valueLong = computed(() => valueView.value.text.split('\n').length > LONG_LINES)

function toggleKeyMode(): void {
  keyMode.value = keyMode.value === 'formatted' ? 'raw' : 'formatted'
}
function toggleValueMode(): void {
  valueMode.value = valueMode.value === 'formatted' ? 'raw' : 'formatted'
}
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
        <div class="kv-head">
          <span class="label">Key</span>
          <button v-if="keyView.ok" class="mode-btn" data-test="key-mode" type="button" @click="toggleKeyMode">
            {{ keyMode === 'formatted' ? '原始' : '格式化' }}
          </button>
        </div>
        <pre class="value" data-test="key-value"><template v-if="keyFormatted"><span v-for="(t, i) in keyView.tokens" :key="i" :class="'tok-' + t.type">{{ t.text }}</span></template><template v-else>{{ keyRaw }}</template></pre>
      </div>
      <div class="kv">
        <div class="kv-head">
          <span class="label">Value</span>
          <span class="kv-actions">
            <button v-if="valueView.ok" class="mode-btn" data-test="value-mode" type="button" @click="toggleValueMode">
              {{ valueMode === 'formatted' ? '原始' : '格式化' }}
            </button>
            <button v-if="valueLong" class="mode-btn" data-test="value-expand" type="button" @click="valueExpanded = !valueExpanded">
              {{ valueExpanded ? '收起' : '展开' }}
            </button>
          </span>
        </div>
        <pre class="value" :class="{ collapsed: valueLong && !valueExpanded }" data-test="value-body"><template v-if="valueFormatted"><span v-for="(t, i) in valueView.tokens" :key="i" :class="'tok-' + t.type">{{ t.text }}</span></template><template v-else>{{ valueText }}</template></pre>
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
.kv-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
.kv-actions { display: inline-flex; gap: 6px; }
.label { font-size: 12px; color: var(--text-secondary); text-transform: uppercase; letter-spacing: 0.04em; }
.mode-btn {
  background: none; border: 1px solid var(--border-strong); color: var(--text-secondary);
  font-size: 11px; line-height: 1.5; border-radius: 5px; padding: 0 8px; cursor: pointer;
  transition: background 0.15s ease, color 0.15s ease;
}
.mode-btn:hover { background: var(--bg-hover); color: var(--text); }
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
  line-height: 1.5;
  color: var(--text);
}
.value.collapsed { max-height: 18em; overflow: hidden; }
.tok-key { color: var(--json-key); }
.tok-string { color: var(--json-string); }
.tok-number { color: var(--json-number); }
.tok-boolean { color: var(--json-boolean); }
.tok-null { color: var(--json-null); }
</style>
