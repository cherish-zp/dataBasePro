<script setup lang="ts">
import { reactive, ref, computed, watch } from 'vue'
import { useConnectionsStore } from '@/store/connections'
import type { Connection, KafkaConfig, SASLConfig, TLSConfig } from '@/api/types'

const props = defineProps<{ show: boolean; connection?: Connection | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const store = useConnectionsStore()

const SECURITY_PROTOCOLS = ['PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL'] as const

const form = reactive({
  name: '',
  brokers: '',
  securityProtocol: 'PLAINTEXT',
  mechanism: 'PLAIN',
  username: '',
  password: '',
  principal: '',
  keytabPath: '',
  krb5ConfPath: '',
  serviceName: 'kafka',
  caCert: '',
  insecureSkipVerify: false,
})
const testing = ref(false)
const tested = ref(false)
const testError = ref<string | null>(null)
const saveError = ref<string | null>(null)

const editing = computed(() => !!props.connection)

const isSasl = computed(() => form.securityProtocol.startsWith('SASL_'))
const isTLS = computed(() => form.securityProtocol.endsWith('_SSL'))
const isGssapi = computed(() => isSasl.value && form.mechanism === 'GSSAPI')

// envDefaults 由部署环境的 DS_KAFKA_* 变量提供 Kerberos 预填值
// (新建连接时的初始默认,可覆盖)。
function envDefault(key: string): string {
  const v = process.env[key]
  return typeof v === 'string' ? v : ''
}

// fillFrom 用已有连接预填表单。旧配置缺 security_protocol 时按
// sasl/tls 布尔推导(sasl.enabled→SASL_PLAINTEXT, tls.enabled→SSL,
// 两者→SASL_SSL, 否则 PLAINTEXT),与后端 EffectiveSecurityProtocol 一致。
function fillFrom(conn: Connection): void {
  const sasl = conn.config.sasl
  const tls = conn.config.tls
  form.name = conn.name
  form.brokers = conn.config.bootstrap_servers.join(', ')
  form.securityProtocol = conn.config.security_protocol
    || (sasl?.enabled && tls?.enabled ? 'SASL_SSL' : sasl?.enabled ? 'SASL_PLAINTEXT' : tls?.enabled ? 'SSL' : 'PLAINTEXT')
  form.mechanism = sasl?.mechanism || 'PLAIN'
  form.username = sasl?.username ?? ''
  form.password = sasl?.password ?? ''
  form.principal = sasl?.principal ?? ''
  form.keytabPath = sasl?.keytab_path ?? ''
  form.krb5ConfPath = sasl?.krb5_conf_path ?? ''
  form.serviceName = sasl?.service_name || 'kafka'
  form.caCert = tls?.ca_cert ?? ''
  form.insecureSkipVerify = !!tls?.insecure_skip_verify
}

watch(
  () => props.show,
  (show) => {
    if (!show) return
    if (props.connection) {
      fillFrom(props.connection)
      return
    }
    const principal = envDefault('DS_KAFKA_KERBEROS_PRINCIPAL')
    if (principal) {
      form.securityProtocol = envDefault('DS_KAFKA_SECURITY_PROTOCOL') || 'SASL_PLAINTEXT'
      form.mechanism = envDefault('DS_KAFKA_SASL_MECHANISM') || 'GSSAPI'
      form.principal = principal
      form.keytabPath = envDefault('DS_KAFKA_KERBEROS_KEYTAB')
      form.krb5ConfPath = envDefault('DS_KERBEROS_KRB5FILE')
      form.serviceName = envDefault('DS_KAFKA_SASL_KERBEROS_SERVICE_NAME') || 'kafka'
    }
  },
  // 表单可能以 show=true 直接挂载,立即预填一次。
  { immediate: true },
)

const brokers = computed(() => form.brokers.split(',').map((s) => s.trim()).filter(Boolean))
const sasl = computed<SASLConfig | undefined>(() => {
  if (!isSasl.value) return undefined
  if (isGssapi.value) {
    return {
      enabled: true,
      mechanism: 'GSSAPI',
      principal: form.principal,
      keytab_path: form.keytabPath,
      krb5_conf_path: form.krb5ConfPath,
      service_name: form.serviceName || 'kafka',
    }
  }
  return { enabled: true, mechanism: form.mechanism, username: form.username, password: form.password }
})
const tls = computed<TLSConfig | undefined>(() => {
  if (!isTLS.value && !form.caCert && !form.insecureSkipVerify) return undefined
  return { enabled: isTLS.value, ca_cert: form.caCert, insecure_skip_verify: form.insecureSkipVerify }
})
const config = computed<KafkaConfig>(() => ({
  bootstrap_servers: brokers.value,
  security_protocol: form.securityProtocol,
  sasl: sasl.value,
  tls: tls.value,
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
    if (props.connection) {
      await store.update(props.connection.id, { name: form.name.trim(), type: props.connection.type, config: config.value })
    } else {
      await store.create({ name: form.name.trim(), type: 'kafka', config: config.value })
    }
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
        <span class="modal-title" data-test="modal-title">{{ editing ? '编辑连接' : '新建连接' }}</span>
        <button class="modal-close" type="button" data-test="modal-close" @click="close">✕</button>
      </div>
      <div class="modal-body">
        <div class="field">
          <label class="label">名称 <span class="req">*</span></label>
          <input v-model="form.name" data-test="input-name" class="input" placeholder="例如：本地开发" autocapitalize="off" autocorrect="off" autocomplete="off" />
          <span v-if="nameInvalid" class="err">名称不能为空</span>
        </div>
        <div class="field">
          <label class="label">bootstrap.servers <span class="req">*</span></label>
          <input v-model="form.brokers" data-test="input-brokers" class="input" placeholder="localhost:9092,broker2:9092" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
          <span v-if="brokersInvalid" class="err">至少填写一个 broker</span>
        </div>
        <div class="field">
          <label class="label">安全协议</label>
          <select v-model="form.securityProtocol" class="input" data-test="input-security-protocol">
            <option v-for="p in SECURITY_PROTOCOLS" :key="p" :value="p">{{ p }}</option>
          </select>
        </div>
        <template v-if="isSasl">
          <div class="field">
            <label class="label">认证方式</label>
            <select v-model="form.mechanism" class="input" data-test="input-mechanism">
              <option value="PLAIN">PLAIN</option>
              <option value="SCRAM-SHA-256">SCRAM-SHA-256</option>
              <option value="SCRAM-SHA-512">SCRAM-SHA-512</option>
              <option value="GSSAPI">GSSAPI（Kerberos）</option>
            </select>
          </div>
          <template v-if="!isGssapi">
            <div class="field">
              <label class="label">用户名</label>
              <input v-model="form.username" data-test="input-username" class="input" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <label class="label">密码</label>
              <input v-model="form.password" type="password" data-test="input-password" class="input" />
            </div>
          </template>
          <template v-else>
            <div class="field">
              <label class="label">Kerberos Principal（须含 @REALM）</label>
              <input v-model="form.principal" data-test="input-principal" class="input" placeholder="admin/admin@YHSJ.COM" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <label class="label">keytab 路径</label>
              <input v-model="form.keytabPath" data-test="input-keytab" class="input" placeholder="/etc/security/keytabs/admin.keytab" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <label class="label">krb5.conf 路径</label>
              <input v-model="form.krb5ConfPath" data-test="input-krb5" class="input" placeholder="/etc/krb5.conf" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
            </div>
            <div class="field">
              <label class="label">服务名（service principal 首段）</label>
              <input v-model="form.serviceName" data-test="input-service-name" class="input" placeholder="kafka" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
            </div>
          </template>
        </template>
        <template v-if="isTLS">
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
        </template>

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
