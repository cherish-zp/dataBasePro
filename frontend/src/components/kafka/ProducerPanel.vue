<script setup lang="ts">
import { reactive, ref, computed, watch } from 'vue'
import { getApi } from '@/api/client'

const props = defineProps<{
  show: boolean
  connectionId: string
  topic: string
  partitions: number[]
}>()
const emit = defineEmits<{ (e: 'close'): void }>()

const form = reactive({
  topic: props.topic,
  partition: -1,
  key: '',
  value: '',
})
const producing = ref(false)
const ok = ref(false)
const error = ref<string | null>(null)

// 面板随活跃 tab 常驻挂载：打开时用当前 topic 预填；打开状态下切换 tab 时跟随。
// 其余时刻不回写，保证输入框仍可自由编辑。
watch([() => props.show, () => props.topic], ([show]) => {
  if (show) form.topic = props.topic
})

const partitionOptions = computed(() => [
  { label: '自动', value: -1 },
  ...props.partitions.map((p) => ({ label: String(p), value: p })),
])

const valueInvalid = computed(() => form.value.trim() === '')

async function produce(): Promise<void> {
  if (valueInvalid.value) return
  producing.value = true
  ok.value = false
  error.value = null
  try {
    await getApi().produceMessage({
      connection_id: props.connectionId,
      topic: form.topic.trim(),
      partition: form.partition,
      key: form.key,
      value: form.value,
    })
    ok.value = true
    form.key = ''
    form.value = ''
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    producing.value = false
  }
}

function close(): void {
  emit('close')
}
</script>

<template>
  <div v-if="show" class="modal-backdrop" data-test="producer-panel" @click.self="close">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">生产消息</span>
        <button class="modal-close" type="button" data-test="modal-close" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label">Topic</label>
          <input v-model="form.topic" data-test="input-topic" class="input" />
        </div>
        <div class="field">
          <label class="label">Partition</label>
          <select v-model="form.partition" data-test="input-partition" class="input">
            <option v-for="opt in partitionOptions" :key="opt.value" :value="opt.value">{{ opt.label }}</option>
          </select>
        </div>
        <div class="field">
          <label class="label">Key（可选）</label>
          <input v-model="form.key" data-test="input-key" class="input" placeholder="分区键" />
        </div>
        <div class="field">
          <label class="label">Value <span class="req">*</span></label>
          <textarea v-model="form.value" data-test="input-value" class="input textarea" rows="6" placeholder='{"key":"value"}'></textarea>
          <span v-if="valueInvalid" class="err" data-test="produce-error">消息内容不能为空</span>
        </div>

        <div v-if="ok" class="msg ok" data-test="produce-ok">消息已发送</div>
        <div v-if="error" class="msg err" data-test="produce-error">{{ error }}</div>
      </div>
      <div class="modal-footer">
        <button class="btn ghost" type="button" @click="close">取消</button>
        <button class="btn primary" type="button" data-test="btn-produce" :disabled="producing || valueInvalid" @click="produce">
          {{ producing ? '发送中…' : '发送' }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0; background: rgba(0, 0, 0, 0.22);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center; z-index: 900;
}
.modal {
  width: 480px; max-width: 92vw; max-height: 88vh; overflow: auto;
  background: var(--bg-elevated); border: 1px solid var(--border); border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  color: var(--text); font-family: var(--font);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.modal-title { font-weight: 600; font-size: 15px; }
.modal-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 6px; padding: 1px 6px; }
.modal-close:hover { background: var(--bg-hover); color: var(--text); }
.modal-body { padding: 16px 18px; }
.field { margin-bottom: 12px; }
.label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.req { color: var(--danger); }
.input { width: 100%; box-sizing: border-box; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 7px; color: var(--text); padding: 8px 10px; font-size: 13px; transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease; }
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.textarea { resize: vertical; }
.err { color: var(--danger); font-size: 12px; }
.msg { margin-top: 8px; font-size: 13px; border-radius: 7px; padding: 8px 10px; }
.msg.ok { background: var(--ok-soft); color: var(--ok); }
.msg.err { background: var(--danger-soft); color: var(--danger); }
.modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.btn { border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
</style>
