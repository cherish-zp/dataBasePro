<script setup lang="ts">
import { reactive, ref, computed } from 'vue'
import { useConnectionsStore } from '@/store/connections'
import type { KafkaConfig, SASLConfig } from '@/api/types'

const props = defineProps<{ show: boolean }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const store = useConnectionsStore()

const form = reactive({
  name: '',
  brokers: '',
  saslEnabled: false,
  mechanism: 'PLAIN',
  username: '',
  password: '',
  caCert: '',
  insecureSkipVerify: false,
})
const testing = ref(false)
const tested = ref(false)
const testError = ref<string | null>(null)
const saveError = ref<string | null>(null)

const brokers = computed(() => form.brokers.split(',').map((s) => s.trim()).filter(Boolean))
const sasl = computed<SASLConfig | undefined>(() =>
  form.saslEnabled ? { enabled: true, mechanism: form.mechanism, username: form.username, password: form.password } : undefined,
)
const config = computed<KafkaConfig>(() => ({
  bootstrap_servers: brokers.value,
  sasl: sasl.value,
  tls: form.caCert || form.insecureSkipVerify
    ? { enabled: true, ca_cert: form.caCert, insecure_skip_verify: form.insecureSkipVerify }
    : undefined,
}))

const nameInvalid = computed(() => form.name.trim() === '')
const brokersInvalid = computed(() => brokers.value.length === 0)

async function runTest(): Promise<void> {
  if (brokersInvalid.value) return
  testing.value = true
  tested.value = false
  testError.value = null
  try {
    await store.testConnection(config.value)
    tested.value = true
  } catch (e) {
    testError.value = e instanceof Error ? e.message : String(e)
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  saveError.value = null
  if (nameInvalid.value || brokersInvalid.value) return
  try {
    await store.create({ name: form.name.trim(), type: 'kafka', config: config.value })
    emit('close')
  } catch (e) {
    saveError.value = e instanceof Error ? e.message : String(e)
  }
}

function close(): void {
  emit('close')
}
</script>

<template>
  <div v-if="show" class="modal-backdrop" data-test="new-connection-modal" @click.self="close">
    <div class="modal">
      <div class="modal-header">
        <span class="modal-title">新建连接</span>
        <button class="modal-close" type="button" data-test="modal-close" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label">名称 <span class="req">*</span></label>
          <input v-model="form.name" data-test="input-name" class="input" placeholder="例如：本地开发" />
          <span v-if="nameInvalid" class="err">名称不能为空</span>
        </div>
        <div class="field">
          <label class="label">bootstrap.servers <span class="req">*</span></label>
          <input v-model="form.brokers" data-test="input-brokers" class="input" placeholder="localhost:9092,broker2:9092" />
          <span v-if="brokersInvalid" class="err">至少填写一个 broker</span>
        </div>
        <div class="field">
          <label class="checkbox-label">
            <input v-model="form.saslEnabled" type="checkbox" data-test="input-sasl" />
            启用 SASL 认证
          </label>
        </div>
        <template v-if="form.saslEnabled">
          <div class="field">
            <label class="label">认证方式</label>
            <select v-model="form.mechanism" class="input" data-test="input-mechanism">
              <option value="PLAIN">PLAIN</option>
              <option value="SCRAM-SHA-256">SCRAM-SHA-256</option>
              <option value="SCRAM-SHA-512">SCRAM-SHA-512</option>
            </select>
          </div>
          <div class="field">
            <label class="label">用户名</label>
            <input v-model="form.username" data-test="input-username" class="input" />
          </div>
          <div class="field">
            <label class="label">密码</label>
            <input v-model="form.password" type="password" data-test="input-password" class="input" />
          </div>
        </template>
        <div class="field">
          <label class="label">CA 证书（可选）</label>
          <textarea v-model="form.caCert" data-test="input-ca" class="input textarea" rows="3"></textarea>
        </div>
        <div class="field">
          <label class="checkbox-label">
            <input v-model="form.insecureSkipVerify" type="checkbox" data-test="input-insecure" />
            跳过证书校验
          </label>
        </div>

        <div v-if="tested" class="msg ok" data-test="test-ok">连接测试成功</div>
        <div v-if="testError" class="msg err" data-test="test-error">{{ testError }}</div>
        <div v-if="saveError" class="msg err" data-test="save-error">{{ saveError }}</div>
      </div>
      <div class="modal-footer">
        <button class="btn ghost" type="button" data-test="btn-test" :disabled="testing || brokersInvalid" @click="runTest">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn ghost" type="button" @click="close">取消</button>
        <button class="btn primary" type="button" data-test="btn-save" :disabled="nameInvalid || brokersInvalid" @click="save">
          保存
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.modal-backdrop {
  position: fixed; inset: 0;
  background: rgba(0, 0, 0, 0.22);
  -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px);
  display: flex; align-items: center; justify-content: center; z-index: 900;
}
.modal {
  width: 460px; max-width: 92vw; max-height: 88vh; overflow: auto;
  background: var(--bg-elevated);
  border: 1px solid var(--border);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-md);
  color: var(--text);
  font-family: var(--font);
}
.modal-header { display: flex; justify-content: space-between; align-items: center; padding: 16px 18px; border-bottom: 1px solid var(--border); }
.modal-title { font-weight: 600; font-size: 15px; }
.modal-close { background: none; border: none; color: var(--text-tertiary); font-size: 16px; cursor: pointer; border-radius: 6px; padding: 1px 6px; }
.modal-close:hover { background: var(--bg-hover); color: var(--text); }
.modal-body { padding: 16px 18px; }
.field { margin-bottom: 12px; }
.label { display: block; font-size: 12px; color: var(--text-secondary); margin-bottom: 4px; }
.req { color: var(--danger); }
.input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 7px;
  color: var(--text); padding: 8px 10px; font-size: 13px;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.textarea { resize: vertical; }
.checkbox-label { font-size: 13px; color: var(--text); display: flex; gap: 6px; align-items: center; }
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
