<script setup lang="ts">
import { reactive, ref, computed, watch } from 'vue'
import { getApi } from '@/api/client'
import { buildBatchMessages, clampCount, loadTemplates, saveTemplate } from '@/utils/batchProduce'

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
  count: 1,
  randomKey: false,
  loop: false,
})
const producing = ref(false)
const ok = ref(false)
const error = ref<string | null>(null)
const batchSummary = ref<{ ok: number; failed: number } | null>(null)
const batchFailures = ref<{ index: number; error: string }[]>([])
const templates = ref<string[]>(loadTemplates())
const showTemplates = ref(false)

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

// 批量行数 > 1 或勾选随机 key 时走批量接口；普通单发保持原接口。
const batchMode = computed(() => form.count > 1 || form.randomKey)

async function produce(): Promise<void> {
  if (valueInvalid.value) return
  producing.value = true
  ok.value = false
  error.value = null
  batchSummary.value = null
  batchFailures.value = []
  try {
    if (!batchMode.value) {
      await getApi().produceMessage({
        connection_id: props.connectionId,
        topic: form.topic.trim(),
        partition: form.partition,
        key: form.key,
        value: form.value,
      })
      ok.value = true
      templates.value = saveTemplate(templates.value, form.value)
      form.key = ''
      form.value = ''
    } else {
      const messages = buildBatchMessages({
        value: form.value,
        key: form.key,
        count: clampCount(form.count),
        randomKey: form.randomKey,
        loop: form.loop,
      })
      const results = await getApi().produceMessages({
        connection_id: props.connectionId,
        topic: form.topic.trim(),
        partition: form.partition,
        messages,
      })
      const failed = results.filter((r) => r.error !== '')
      batchSummary.value = { ok: results.length - failed.length, failed: failed.length }
      batchFailures.value = failed.map((r) => ({ index: r.index, error: r.error }))
      // 只把成功发送的 value 记入最近模板（循环模式下值相同，自动去重）。
      const sent: string[] = []
      for (let i = 0; i < messages.length; i++) {
        if (!failed.some((f) => f.index === i) && !sent.includes(messages[i].value)) {
          sent.push(messages[i].value)
        }
      }
      for (const v of sent) templates.value = saveTemplate(templates.value, v)
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    producing.value = false
  }
}

function fillTemplate(tpl: string): void {
  form.value = tpl
  showTemplates.value = false
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
          <div class="batch-row">
            <label class="label" for="batch-count">批量行数</label>
            <input id="batch-count" v-model.number="form.count" data-test="input-count" class="input count" type="number" min="1" max="1000" />
            <label class="check"><input v-model="form.randomKey" data-test="input-random-key" type="checkbox" /> 随机 key</label>
            <label class="check"><input v-model="form.loop" data-test="input-loop" type="checkbox" /> 循环发送</label>
          </div>
        </div>
        <div class="field">
          <div class="value-head">
            <label class="label">Value <span class="req">*</span></label>
            <button v-if="templates.length > 0" class="btn ghost template-toggle" type="button" data-test="template-toggle" @click="showTemplates = !showTemplates">
              最近模板 ▾
            </button>
          </div>
          <div v-if="showTemplates" class="template-list">
            <button v-for="(tpl, i) in templates" :key="i" class="template-item" type="button" data-test="template-item" :title="tpl" @click="fillTemplate(tpl)">
              {{ tpl.length > 48 ? tpl.slice(0, 48) + '…' : tpl }}
            </button>
          </div>
          <textarea v-model="form.value" data-test="input-value" class="input textarea" rows="6" placeholder='{"key":"value"}'></textarea>
          <span v-if="valueInvalid" class="err" data-test="produce-error">消息内容不能为空</span>
        </div>

        <div v-if="ok" class="msg ok" data-test="produce-ok">消息已发送</div>
        <div v-if="batchSummary" :class="batchSummary.failed > 0 ? 'msg err' : 'msg ok'" data-test="batch-summary">
          成功 {{ batchSummary.ok }} / 失败 {{ batchSummary.failed }}
        </div>
        <div v-if="batchFailures.length > 0" data-test="batch-failures">
          <div v-for="f in batchFailures" :key="f.index" class="msg err">第 {{ f.index + 1 }} 条：{{ f.error }}</div>
        </div>
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
.batch-row { display: flex; align-items: center; gap: 14px; }
.batch-row .label { margin-bottom: 0; }
.count { width: 84px; }
.check { display: flex; align-items: center; gap: 5px; font-size: 12px; color: var(--text-secondary); cursor: pointer; }
.check input { accent-color: var(--accent); }
.value-head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 4px; }
.template-toggle { padding: 2px 8px; font-size: 12px; border-radius: 6px; }
.template-list { display: flex; flex-direction: column; gap: 4px; margin-bottom: 8px; }
.template-item { text-align: left; background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 6px; color: var(--text-secondary); font-size: 12px; padding: 5px 8px; cursor: pointer; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.template-item:hover { background: var(--bg-hover); color: var(--text); border-color: var(--border-strong); }
.modal-footer { display: flex; gap: 8px; justify-content: flex-end; padding: 12px 18px; border-top: 1px solid var(--border); }
.btn { border-radius: 7px; padding: 7px 14px; font-size: 13px; cursor: pointer; border: 1px solid transparent; transition: background 0.15s ease, opacity 0.15s ease; }
.btn:disabled { opacity: 0.5; cursor: not-allowed; }
.btn.primary { background: var(--accent); color: #fff; }
.btn.primary:hover:not(:disabled) { background: var(--accent-hover); }
.btn.ghost { background: transparent; color: var(--text); border-color: var(--border-strong); }
.btn.ghost:hover:not(:disabled) { background: var(--bg-hover); }
</style>
