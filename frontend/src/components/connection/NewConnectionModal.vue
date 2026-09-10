<script setup lang="ts">
import { reactive, ref, computed, watch } from 'vue'
import { getApi } from '@/api/client'
import { useConnectionsStore } from '@/store/connections'
import type { Connection, CHConfigShape, KafkaConfig, RedisConfigShape, SASLConfig, TLSConfig } from '@/api/types'

const props = defineProps<{ show: boolean; connection?: Connection | null }>()
const emit = defineEmits<{ (e: 'close'): void }>()

const store = useConnectionsStore()

const SECURITY_PROTOCOLS = ['PLAINTEXT', 'SSL', 'SASL_PLAINTEXT', 'SASL_SSL'] as const

// 两段式第一段:数据库类型卡片。数据来自本地常量数组,后续可换驱动管理页数据。
const TYPE_CARDS: { type: 'kafka' | 'redis' | 'clickhouse'; label: string; icon: string }[] = [
  { type: 'kafka', label: 'Kafka', icon: '⚡' },
  { type: 'redis', label: 'Redis', icon: '🧱' },
  { type: 'clickhouse', label: 'ClickHouse', icon: '🗄️' },
]

const form = reactive({
  name: '',
  connType: 'kafka' as 'kafka' | 'redis' | 'clickhouse',
  addr: '',
  redisPassword: '',
  redisDB: 0,
  redisTLS: false,
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
  chHosts: '',
  chUsername: 'default',
  chPassword: '',
  chDatabase: 'default',
  chTLS: false,
  chProtocol: 'native' as 'native' | 'http',
})
const testing = ref(false)
const tested = ref(false)
const testError = ref<string | null>(null)
const saveError = ref<string | null>(null)
// 密码可见性:三个密码框(kafka/redis/clickhouse)各自独立切换,默认密文。
const showKafkaPassword = ref(false)
const showRedisPassword = ref(false)
const showChPassword = ref(false)

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
  form.name = conn.name
  if (conn.type === 'redis') {
    const cfg = conn.config as RedisConfigShape
    form.connType = 'redis'
    form.addr = cfg.addr
    form.redisPassword = cfg.password ?? ''
    form.redisDB = cfg.db ?? 0
    form.redisTLS = !!cfg.tls
    return
  }
  if (conn.type === 'clickhouse') {
    const cfg = conn.config as CHConfigShape
    form.connType = 'clickhouse'
    form.chHosts = cfg.hosts.join(', ')
    form.chUsername = cfg.username
    form.chPassword = cfg.password ?? ''
    form.chDatabase = cfg.database
    form.chTLS = !!cfg.tls
    // 旧配置缺省 protocol 时按 native 回填,与后端归一逻辑一致。
    form.chProtocol = cfg.protocol ?? 'native'
    return
  }
  form.connType = 'kafka'
  const cfg = conn.config as KafkaConfig
  const sasl = cfg.sasl
  const tls = cfg.tls
  form.brokers = cfg.bootstrap_servers.join(', ')
  form.securityProtocol = cfg.security_protocol
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
const chHosts = computed(() => form.chHosts.split(',').map((s) => s.trim()).filter(Boolean))
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
const config = computed<KafkaConfig | RedisConfigShape | CHConfigShape>(() => {
  if (form.connType === 'redis') {
    return {
      addr: form.addr,
      password: form.redisPassword || undefined,
      db: form.redisDB,
      tls: form.redisTLS,
    }
  }
  if (form.connType === 'clickhouse') {
    return {
      hosts: chHosts.value,
      username: form.chUsername,
      password: form.chPassword || undefined,
      database: form.chDatabase,
      tls: form.chTLS,
      // 显式携带(而非缺省省略),保存后编辑回填与后端归一都更清晰。
      protocol: form.chProtocol,
    }
  }
  return {
    bootstrap_servers: brokers.value,
    security_protocol: form.securityProtocol,
    sasl: sasl.value,
    tls: tls.value,
  }
})

const nameInvalid = computed(() => form.name.trim() === '')
const brokersInvalid = computed(() => form.connType === 'kafka' && brokers.value.length === 0)
const addrInvalid = computed(() => form.connType === 'redis' && form.addr.trim() === '')
const chHostsInvalid = computed(() => form.connType === 'clickhouse' && chHosts.value.length === 0)
const saveInvalid = computed(() => nameInvalid.value || brokersInvalid.value || addrInvalid.value || chHostsInvalid.value)
// 测试连接不需要名称,只校验目标地址。
const targetInvalid = computed(() => brokersInvalid.value || addrInvalid.value || chHostsInvalid.value)

async function runTest(): Promise<void> {
  if (targetInvalid.value) return
  testing.value = true
  tested.value = false
  testError.value = null
  try {
    // 按类型分派:redis 走 TestRedisConnection,clickhouse 走 TestCHConnection,
    // kafka 走原 TestConnection。
    if (form.connType === 'redis') {
      await getApi().testRedisConnection(config.value as RedisConfigShape)
    } else if (form.connType === 'clickhouse') {
      await getApi().testCHConnection(config.value as CHConfigShape)
    } else {
      await store.testConnection(config.value as KafkaConfig)
    }
    tested.value = true
  } catch (e) {
    testError.value = e instanceof Error ? e.message : String(e)
  } finally {
    testing.value = false
  }
}

async function save(): Promise<void> {
  saveError.value = null
  if (saveInvalid.value) return
  try {
    if (props.connection) {
      // type 用 form.connType(预填自连接类型):携带显式类型避免后端
      // resolvedType 对空 type 默认 kafka,导致 redis/clickhouse 走错分支。
      await store.update(props.connection.id, { name: form.name.trim(), type: form.connType, config: config.value })
    } else {
      await store.create({ name: form.name.trim(), type: form.connType, config: config.value })
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
  <div v-if="show" class="modal-backdrop" data-test="new-connection-modal">
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
          <label class="label">数据库类型</label>
          <div class="type-grid" data-test="type-grid">
            <button
              v-for="c in TYPE_CARDS"
              :key="c.type"
              type="button"
              class="type-card"
              :class="{ active: form.connType === c.type }"
              :data-test="`type-card-${c.type}`"
              @click="form.connType = c.type"
            >
              <span class="type-card-icon">{{ c.icon }}</span>
              <span class="type-card-label">{{ c.label }}</span>
            </button>
          </div>
        </div>
        <template v-if="form.connType === 'redis'">
          <div class="field">
            <label class="label">地址 <span class="req">*</span>(集群可填逗号分隔多个种子)</label>
            <input v-model="form.addr" data-test="input-addr" class="input" placeholder="127.0.0.1:6379" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field">
            <label class="label">密码(可选)</label>
            <div class="password-wrap">
              <input v-model="form.redisPassword" :type="showRedisPassword ? 'text' : 'password'" data-test="input-redis-password" class="input password-input" />
              <button
                type="button"
                class="eye-btn"
                tabindex="-1"
                data-test="toggle-password-redis"
                :aria-label="showRedisPassword ? '隐藏密码' : '显示密码'"
                @click="showRedisPassword = !showRedisPassword"
              >
                <svg v-if="showRedisPassword" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          </div>
          <div class="field">
            <label class="label">DB(集群模式固定 0)</label>
            <input v-model.number="form.redisDB" data-test="input-redis-db" class="input" type="number" min="0" />
          </div>
        </template>
        <template v-else-if="form.connType === 'clickhouse'">
          <div class="field">
            <label class="label">节点地址 <span class="req">*</span>(多节点逗号分隔)</label>
            <input v-model="form.chHosts" data-test="input-ch-hosts" class="input" placeholder="node1:9000,node2:9000" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
            <span class="hint" data-test="ch-port-hint">原生协议默认端口 9000;HTTP 协议默认端口 8123</span>
            <span v-if="chHostsInvalid" class="err">至少填写一个节点</span>
          </div>
          <div class="field">
            <label class="label">协议</label>
            <select v-model="form.chProtocol" class="input" data-test="input-ch-protocol">
              <option value="native">Native(9000)</option>
              <option value="http">HTTP(8123)</option>
            </select>
          </div>
          <div class="field">
            <label class="label">用户名</label>
            <input v-model="form.chUsername" data-test="input-ch-username" class="input" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field">
            <label class="label">密码</label>
            <div class="password-wrap">
              <input v-model="form.chPassword" :type="showChPassword ? 'text' : 'password'" data-test="input-ch-password" class="input password-input" />
              <button
                type="button"
                class="eye-btn"
                tabindex="-1"
                data-test="toggle-password-ch"
                :aria-label="showChPassword ? '隐藏密码' : '显示密码'"
                @click="showChPassword = !showChPassword"
              >
                <svg v-if="showChPassword" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                  <line x1="1" y1="1" x2="23" y2="23" />
                </svg>
                <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                  <circle cx="12" cy="12" r="3" />
                </svg>
              </button>
            </div>
          </div>
          <div class="field">
            <label class="label">数据库</label>
            <input v-model="form.chDatabase" data-test="input-ch-database" class="input" autocapitalize="off" autocorrect="off" autocomplete="off" spellcheck="false" />
          </div>
          <div class="field">
            <label class="checkbox-label">
              <input v-model="form.chTLS" type="checkbox" data-test="input-ch-tls" />
              启用 TLS
            </label>
          </div>
        </template>
        <template v-else>
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
              <div class="password-wrap">
                <input v-model="form.password" :type="showKafkaPassword ? 'text' : 'password'" data-test="input-password" class="input password-input" />
                <button
                  type="button"
                  class="eye-btn"
                  tabindex="-1"
                  data-test="toggle-password-kafka"
                  :aria-label="showKafkaPassword ? '隐藏密码' : '显示密码'"
                  @click="showKafkaPassword = !showKafkaPassword"
                >
                  <svg v-if="showKafkaPassword" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24" />
                    <line x1="1" y1="1" x2="23" y2="23" />
                  </svg>
                  <svg v-else viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
                    <circle cx="12" cy="12" r="3" />
                  </svg>
                </button>
              </div>
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
        </template>

        <div v-if="tested" class="msg ok" data-test="test-ok">连接测试成功</div>
        <div v-if="testError" class="msg err" data-test="test-error">{{ testError }}</div>
        <div v-if="saveError" class="msg err" data-test="save-error">{{ saveError }}</div>
      </div>
      <div class="modal-footer">
        <button class="btn ghost" type="button" data-test="btn-test" :disabled="testing || targetInvalid" @click="runTest">
          {{ testing ? '测试中…' : '测试连接' }}
        </button>
        <button class="btn ghost" type="button" @click="close">取消</button>
        <button class="btn primary" type="button" data-test="btn-save" :disabled="nameInvalid || saveInvalid" @click="save">
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
.type-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; }
.type-card {
  display: flex; flex-direction: column; align-items: center; gap: 4px;
  padding: 10px 6px; cursor: pointer;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 10px;
  color: var(--text); font-family: inherit;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.type-card:hover { border-color: var(--accent); background: var(--bg-elevated); }
.type-card.active {
  border-color: var(--accent); background: var(--bg-elevated);
  box-shadow: 0 0 0 3px var(--accent-soft);
}
.type-card-icon { font-size: 20px; line-height: 1; }
.type-card-label { font-size: 12px; font-weight: 500; }
.req { color: var(--danger); }
.input {
  width: 100%; box-sizing: border-box;
  background: var(--bg-subtle); border: 1px solid var(--border); border-radius: 7px;
  color: var(--text); padding: 8px 10px; font-size: 13px;
  transition: border-color 0.15s ease, background 0.15s ease, box-shadow 0.15s ease;
}
.input:focus { outline: none; border-color: var(--accent); background: var(--bg-elevated); box-shadow: 0 0 0 3px var(--accent-soft); }
.password-wrap { position: relative; }
/* 右侧留白加大,避免输入文字被眼睛图标遮挡。 */
.password-input { padding-right: 34px; }
.eye-btn {
  position: absolute; right: 6px; top: 50%; transform: translateY(-50%);
  display: flex; align-items: center; justify-content: center;
  width: 24px; height: 24px; padding: 0; border: none; background: none;
  color: var(--text-tertiary); cursor: pointer; border-radius: 5px;
}
.eye-btn:hover { color: var(--text); background: var(--bg-hover); }
.textarea { resize: vertical; }
.checkbox-label { font-size: 13px; color: var(--text); display: flex; gap: 6px; align-items: center; }
.hint { display: block; font-size: 12px; color: var(--text-tertiary); margin-top: 4px; }
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
