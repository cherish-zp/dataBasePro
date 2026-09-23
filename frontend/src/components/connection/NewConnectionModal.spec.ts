import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import NewConnectionModal from './NewConnectionModal.vue'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as never),
    listTopics: vi.fn(async () => []),
    describeTopic: vi.fn(async () => ({ name: "", partitions: [], configs: [] })),
    describeCluster: vi.fn(async () => ({ cluster_id: "", controller_id: -1, kafka_version: "", brokers: [], under_replicated_partitions: 0 })),
    alterTopicConfig: vi.fn(async () => {}),
    alterTopicPartitions: vi.fn(async () => {}),
    getTopicMessageCounts: vi.fn(async () => ({})),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    previewResetOffset: vi.fn(async () => ({})),
    listAudit: vi.fn(async () => []),
        checkUpdate: vi.fn(async () => ({ has_update: false, latest_version: 'v1.0.0' })),
        downloadUpdate: vi.fn(async () => {}),
        applyUpdate: vi.fn(async () => {}),
        updateProgress: vi.fn(async () => ({ phase: 'idle' as const, percent: 0 })),
        openURL: vi.fn(async () => {}),
    listSavedQueries: vi.fn(async () => []),
    saveSavedQuery: vi.fn(async (q: never) => ({}) as never),
    updateSavedQuery: vi.fn(async () => ({}) as never),
    deleteSavedQuery: vi.fn(async () => {}),
        testCHConnection: vi.fn(async () => {}),
        listCHDatabases: vi.fn(async () => []),
        listCHTables: vi.fn(async () => []),
        chPageRows: vi.fn(async () => ({ columns: [], rows: [], engine: '', total_rows: 0 })),
        chTruncateTable: vi.fn(async () => {}),
        chExecute: vi.fn(async () => []),
        listDrivers: vi.fn(async () => []),
        redisHashSetField: vi.fn(async () => {}),
        redisHashDeleteField: vi.fn(async () => {}),
        redisListSetIndex: vi.fn(async () => {}),
        redisListPush: vi.fn(async () => {}),
        redisListDeleteIndex: vi.fn(async () => {}),
        redisSetAdd: vi.fn(async () => {}),
        redisSetRemove: vi.fn(async () => {}),
        redisZSetAdd: vi.fn(async () => {}),
        redisZSetRemove: vi.fn(async () => {}),
    testRedisConnection: vi.fn(async () => {}),
    listRedisDBs: vi.fn(async () => []),
    redisScan: vi.fn(async () => ({ cursor: 0, keys: [] })),
    redisGetKey: vi.fn(async () => ({ key: '', type: 'string', ttl_seconds: -1 })),
    redisRenameKey: vi.fn(async () => {}),
    redisDeleteKeys: vi.fn(async () => 0),
    redisSetTTL: vi.fn(async () => {}),
    redisSetString: vi.fn(async () => {}),
    redisFlushDB: vi.fn(async () => {}),
    redisFlushAll: vi.fn(async () => {}),
    redisServerInfo: vi.fn(async () => ({ mode: 'standalone' as const, used_memory_human: '', connected_clients: 0, total_keys: 0 })),
    saveTextFile: vi.fn(async () => ''),
    updateConnection: vi.fn(async () => ({}) as never),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

describe('NewConnectionModal', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
  })
  afterEach(() => {
    vi.unstubAllEnvs()
  })

  function mountModal() {
    return mount(NewConnectionModal, { props: { show: true } })
  }

  it('新建模式重新打开时表单重置:上次输入的 Redis 信息不残留', async () => {
    // 第一次打开:填入 Redis 连接信息(模拟用户输入)。
    const wrapper = mount(NewConnectionModal, { props: { show: true } })
    await wrapper.find('[data-test="type-card-redis"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('我的 Redis')
    await wrapper.find('[data-test="input-addr"]').setValue('127.0.0.1:6379')
    await wrapper.find('[data-test="input-redis-password"]').setValue('s3cret')
    // 关闭再重新打开(新建模式,无 connection):整体重置,名称清空、
    // 类型回到默认 kafka(redis 字段需重新切卡后校验)。
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true })
    expect((wrapper.find('[data-test="input-name"]').element as HTMLInputElement).value).toBe('')
    await wrapper.find('[data-test="type-card-redis"]').trigger('click')
    expect((wrapper.find('[data-test="input-addr"]').element as HTMLInputElement).value).toBe('')
    expect((wrapper.find('[data-test="input-redis-password"]').element as HTMLInputElement).value).toBe('')
  })

  it('does not render when hidden', () => {
    const wrapper = mount(NewConnectionModal, { props: { show: false } })
    expect(wrapper.find('[data-test="new-connection-modal"]').exists()).toBe(false)
  })

  it('keeps case-sensitive text inputs (brokers/name/username) free of autocapitalize', async () => {
    const wrapper = mountModal()
    for (const sel of ['input-brokers', 'input-name']) {
      const input = wrapper.find(`[data-test="${sel}"]`)
      expect(input.attributes('autocapitalize'), sel).toBe('off')
      expect(input.attributes('autocorrect'), sel).toBe('off')
      expect(input.attributes('autocomplete'), sel).toBe('off')
    }
    await wrapper.find('[data-test="input-security-protocol"]').setValue('SASL_PLAINTEXT')
    await wrapper.find('[data-test="input-mechanism"]').setValue('PLAIN')
    const username = wrapper.find('[data-test="input-username"]')
    expect(username.attributes('autocapitalize')).toBe('off')
    expect(username.attributes('autocorrect')).toBe('off')
    expect(username.attributes('autocomplete')).toBe('off')
  })

  it('save is disabled until name and brokers are provided', async () => {
    const wrapper = mountModal()
    const save = wrapper.find('[data-test="btn-save"]')
    expect((save.element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="input-name"]').setValue('local')
    await wrapper.find('[data-test="input-brokers"]').setValue('localhost:9092')
    expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('creates a connection with the entered config and closes', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="input-name"]').setValue('local')
    await wrapper.find('[data-test="input-brokers"]').setValue('a:9092, b:9092')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'local',
          type: 'kafka',
          config: { bootstrap_servers: ['a:9092', 'b:9092'], security_protocol: 'PLAINTEXT' },
        }),
      )
    })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('includes SASL settings when a SASL protocol is selected', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="input-name"]').setValue('secure')
    await wrapper.find('[data-test="input-brokers"]').setValue('localhost:9092')
    await wrapper.find('[data-test="input-security-protocol"]').setValue('SASL_PLAINTEXT')
    await wrapper.find('[data-test="input-mechanism"]').setValue('SCRAM-SHA-256')
    await wrapper.find('[data-test="input-username"]').setValue('user')
    await wrapper.find('[data-test="input-password"]').setValue('secret')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            security_protocol: 'SASL_PLAINTEXT',
            sasl: { enabled: true, mechanism: 'SCRAM-SHA-256', username: 'user', password: 'secret' },
          }),
        }),
      )
    })
  })

  it('hides SASL fields for PLAINTEXT and shows them again for SASL_SSL with TLS enabled', async () => {
    const wrapper = mountModal()
    expect(wrapper.find('[data-test="input-username"]').exists()).toBe(false)
    await wrapper.find('[data-test="input-security-protocol"]').setValue('SASL_SSL')
    expect(wrapper.find('[data-test="input-username"]').exists()).toBe(true)
    await wrapper.find('[data-test="input-mechanism"]').setValue('PLAIN')
    await wrapper.find('[data-test="input-username"]').setValue('u')
    await wrapper.find('[data-test="input-password"]').setValue('p')
    await wrapper.find('[data-test="input-ca"]').setValue('CA-PEM')
    await wrapper.find('[data-test="input-name"]').setValue('x')
    await wrapper.find('[data-test="input-brokers"]').setValue('b:1')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            security_protocol: 'SASL_SSL',
            tls: { enabled: true, ca_cert: 'CA-PEM', insecure_skip_verify: false },
          }),
        }),
      )
    })
  })

  it('switches to kerberos fields when GSSAPI is selected and saves them', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="input-security-protocol"]').setValue('SASL_PLAINTEXT')
    await wrapper.find('[data-test="input-mechanism"]').setValue('GSSAPI')
    // username/password 换成 kerberos 四栏,serviceName 预填 kafka。
    expect(wrapper.find('[data-test="input-username"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-password"]').exists()).toBe(false)
    const service = wrapper.find('[data-test="input-service-name"]')
    expect((service.element as HTMLInputElement).value).toBe('kafka')
    await wrapper.find('[data-test="input-name"]').setValue('kerb')
    await wrapper.find('[data-test="input-brokers"]').setValue('b:1')
    await wrapper.find('[data-test="input-principal"]').setValue('admin/admin@YHSJ.COM')
    await wrapper.find('[data-test="input-keytab"]').setValue('/etc/security/keytabs/admin.keytab')
    await wrapper.find('[data-test="input-krb5"]').setValue('/etc/krb5.conf')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            security_protocol: 'SASL_PLAINTEXT',
            sasl: {
              enabled: true,
              mechanism: 'GSSAPI',
              principal: 'admin/admin@YHSJ.COM',
              keytab_path: '/etc/security/keytabs/admin.keytab',
              krb5_conf_path: '/etc/krb5.conf',
              service_name: 'kafka',
            },
          }),
        }),
      )
    })
  })

  it('prefills kerberos fields from DS_KAFKA_* environment variables', async () => {
    vi.stubEnv('DS_KAFKA_SECURITY_PROTOCOL', 'SASL_PLAINTEXT')
    vi.stubEnv('DS_KAFKA_SASL_MECHANISM', 'GSSAPI')
    vi.stubEnv('DS_KAFKA_KERBEROS_PRINCIPAL', 'env/admin@ENV.COM')
    vi.stubEnv('DS_KAFKA_KERBEROS_KEYTAB', '/env/admin.keytab')
    vi.stubEnv('DS_KERBEROS_KRB5FILE', '/env/krb5.conf')
    vi.stubEnv('DS_KAFKA_SASL_KERBEROS_SERVICE_NAME', 'envkafka')
    const wrapper = mountModal()
    expect((wrapper.find('[data-test="input-security-protocol"]').element as HTMLSelectElement).value).toBe('SASL_PLAINTEXT')
    expect((wrapper.find('[data-test="input-mechanism"]').element as HTMLSelectElement).value).toBe('GSSAPI')
    expect((wrapper.find('[data-test="input-principal"]').element as HTMLInputElement).value).toBe('env/admin@ENV.COM')
    expect((wrapper.find('[data-test="input-keytab"]').element as HTMLInputElement).value).toBe('/env/admin.keytab')
    expect((wrapper.find('[data-test="input-krb5"]').element as HTMLInputElement).value).toBe('/env/krb5.conf')
    expect((wrapper.find('[data-test="input-service-name"]').element as HTMLInputElement).value).toBe('envkafka')
  })


  it('shows redis fields when type redis is selected and saves a redis connection', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-redis"]').trigger('click')
    expect(wrapper.find('[data-test="input-brokers"]').exists()).toBe(false)
    const addr = wrapper.find('[data-test="input-addr"]')
    expect(addr.exists()).toBe(true)
    await wrapper.find('[data-test="input-name"]').setValue('redis-local')
    await addr.setValue('127.0.0.1:6379')
    await wrapper.find('[data-test="input-redis-password"]').setValue('pw')
    await wrapper.find('[data-test="input-redis-db"]').setValue('2')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          type: 'redis',
          config: expect.objectContaining({
            addr: '127.0.0.1:6379',
            password: 'pw',
            db: 2,
          }),
        }),
      )
    })
  })

  it('routes test connection to testRedisConnection when type is redis', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-redis"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('r')
    await wrapper.find('[data-test="input-addr"]').setValue('127.0.0.1:6379')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.testRedisConnection).toHaveBeenCalledWith(
        expect.objectContaining({ addr: '127.0.0.1:6379' }),
      )
    })
    expect(api.testConnection).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="test-ok"]').exists()).toBe(true)
  })

  it('prefills redis fields in edit mode', async () => {
    const conn: Connection = {
      id: 'r1',
      name: 'redis-old',
      type: 'redis',
      config: { addr: 'r.internal:6380', password: 'pw', db: 3 },
      created_at: 1,
      updated_at: 1,
    }
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: conn } })
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="input-addr"]').element as HTMLInputElement).value).toBe('r.internal:6380')
    })
    expect((wrapper.find('[data-test="input-redis-db"]').element as HTMLInputElement).value).toBe('3')
    await wrapper.find('[data-test="input-name"]').setValue('redis-new')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'r1', name: 'redis-new', type: 'redis' }),
      )
    })
  })

  it('test connection calls the api and shows success', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="input-brokers"]').setValue('localhost:9092')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.testConnection).toHaveBeenCalled()
      expect(wrapper.find('[data-test="test-ok"]').exists()).toBe(true)
    })
  })

  it('shows test errors', async () => {
    ;(api.testConnection as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('broker unreachable'))
    const wrapper = mountModal()
    await wrapper.find('[data-test="input-brokers"]').setValue('localhost:9092')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="test-error"]').text()).toBe('broker unreachable')
    })
  })

  it('keeps the modal open when the backdrop is clicked', async () => {
    const wrapper = mountModal()
    // trigger 直接作用在遮罩元素上,target 即遮罩自身,等价于点击弹窗外的空白处。
    await wrapper.find('[data-test="new-connection-modal"]').trigger('click')
    expect(wrapper.emitted('close')).toBeFalsy()
    expect(wrapper.find('[data-test="modal-title"]').exists()).toBe(true)
  })

  it('emits close via the close button', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  const gssapiConn: Connection = {
    id: 'c-1',
    name: 'kerb-old',
    type: 'kafka',
    created_at: 1,
    updated_at: 2,
    config: {
      bootstrap_servers: ['a:9092', 'b:9092'],
      security_protocol: 'SASL_PLAINTEXT',
      sasl: {
        enabled: true,
        mechanism: 'GSSAPI',
        principal: 'admin/admin@YHSJ.COM',
        keytab_path: '/etc/security/keytabs/admin.keytab',
        krb5_conf_path: '/etc/krb5.conf',
        service_name: 'mysvc',
      },
    },
  }

  it('shows the create title when no connection is passed', () => {
    const wrapper = mountModal()
    expect(wrapper.find('[data-test="modal-title"]').text()).toBe('新建连接')
  })

  it('prefills every kerberos field from the connection in edit mode', () => {
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: gssapiConn } })
    expect(wrapper.find('[data-test="modal-title"]').text()).toBe('编辑连接')
    expect((wrapper.find('[data-test="input-name"]').element as HTMLInputElement).value).toBe('kerb-old')
    expect((wrapper.find('[data-test="input-brokers"]').element as HTMLInputElement).value).toBe('a:9092, b:9092')
    expect((wrapper.find('[data-test="input-security-protocol"]').element as HTMLSelectElement).value).toBe('SASL_PLAINTEXT')
    expect((wrapper.find('[data-test="input-mechanism"]').element as HTMLSelectElement).value).toBe('GSSAPI')
    expect((wrapper.find('[data-test="input-principal"]').element as HTMLInputElement).value).toBe('admin/admin@YHSJ.COM')
    expect((wrapper.find('[data-test="input-keytab"]').element as HTMLInputElement).value).toBe('/etc/security/keytabs/admin.keytab')
    expect((wrapper.find('[data-test="input-krb5"]').element as HTMLInputElement).value).toBe('/etc/krb5.conf')
    expect((wrapper.find('[data-test="input-service-name"]').element as HTMLInputElement).value).toBe('mysvc')
  })

  it('saves edits through updateConnection with the connection id and closes', async () => {
    const api2 = fakeApi({ updateConnection: vi.fn(async (r: never) => r) })
    setApi(api2)
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: gssapiConn } })
    await wrapper.find('[data-test="input-name"]').setValue('kerb-new')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api2.updateConnection).toHaveBeenCalledWith({
        id: 'c-1',
        name: 'kerb-new',
        type: 'kafka',
        config: expect.objectContaining({
          bootstrap_servers: ['a:9092', 'b:9092'],
          security_protocol: 'SASL_PLAINTEXT',
          sasl: {
            enabled: true,
            mechanism: 'GSSAPI',
            principal: 'admin/admin@YHSJ.COM',
            keytab_path: '/etc/security/keytabs/admin.keytab',
            krb5_conf_path: '/etc/krb5.conf',
            service_name: 'mysvc',
          },
        }),
      })
    })
    expect(wrapper.emitted('close')).toBeTruthy()
    expect(api2.createConnection).not.toHaveBeenCalled()
  })

  it('prefills username/password and TLS fields in edit mode', () => {
    const wrapper = mount(NewConnectionModal, {
      props: {
        show: true,
        connection: {
          id: 'c-2', name: 'plain-old', type: 'kafka', created_at: 1, updated_at: 1,
          config: {
            bootstrap_servers: ['h:9092'],
            security_protocol: 'SASL_SSL',
            sasl: { enabled: true, mechanism: 'SCRAM-SHA-256', username: 'user', password: 'secret' },
            tls: { enabled: true, ca_cert: 'CA-PEM', insecure_skip_verify: true },
          },
        },
      },
    })
    expect((wrapper.find('[data-test="input-security-protocol"]').element as HTMLSelectElement).value).toBe('SASL_SSL')
    expect((wrapper.find('[data-test="input-mechanism"]').element as HTMLSelectElement).value).toBe('SCRAM-SHA-256')
    expect((wrapper.find('[data-test="input-username"]').element as HTMLInputElement).value).toBe('user')
    expect((wrapper.find('[data-test="input-password"]').element as HTMLInputElement).value).toBe('secret')
    expect((wrapper.find('[data-test="input-ca"]').element as HTMLTextAreaElement).value).toBe('CA-PEM')
    expect((wrapper.find('[data-test="input-insecure"]').element as HTMLInputElement).checked).toBe(true)
  })

  it('derives the security protocol from legacy sasl/tls booleans when the field is missing', () => {
    const base = { id: 'c-3', name: 'legacy', type: 'kafka' as const, created_at: 1, updated_at: 1 }
    const mountWith = async (cfg: Connection['config']) => {
      const w = mount(NewConnectionModal, {
        props: { show: true, connection: { ...base, config: cfg } },
      })
      return (w.find('[data-test="input-security-protocol"]').element as HTMLSelectElement).value
    }
    expect(mountWith({ bootstrap_servers: ['h:1'], sasl: { enabled: true, mechanism: 'PLAIN', username: 'u' } })).resolves.toBe('SASL_PLAINTEXT')
    expect(mountWith({ bootstrap_servers: ['h:1'], tls: { enabled: true } })).resolves.toBe('SSL')
    expect(mountWith({ bootstrap_servers: ['h:1'], sasl: { enabled: true, mechanism: 'PLAIN', username: 'u' }, tls: { enabled: true } })).resolves.toBe('SASL_SSL')
    expect(mountWith({ bootstrap_servers: ['h:1'] })).resolves.toBe('PLAINTEXT')
  })

  it('renders the two-stage type grid with selectable cards', async () => {
    const wrapper = mountModal()
    for (const t of ['kafka', 'redis', 'clickhouse', 'mysql', 'tidb', 'postgres']) {
      expect(wrapper.find(`[data-test="type-card-${t}"]`).exists()).toBe(true)
    }
    // 默认选中 kafka,下方渲染 kafka 表单。
    expect(wrapper.find('[data-test="type-card-kafka"]').classes()).toContain('active')
    expect(wrapper.find('[data-test="input-brokers"]').exists()).toBe(true)
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    expect(wrapper.find('[data-test="type-card-clickhouse"]').classes()).toContain('active')
    expect(wrapper.find('[data-test="type-card-kafka"]').classes()).not.toContain('active')
    expect(wrapper.find('[data-test="input-ch-hosts"]').exists()).toBe(true)
  })

  it('shows mysql fields with mysql defaults (port 3306 / TLS disabled) when mysql is selected', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-mysql"]').trigger('click')
    expect(wrapper.find('[data-test="input-brokers"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-addr"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-ch-hosts"]').exists()).toBe(false)
    for (const f of ['input-mysql-host', 'input-mysql-port', 'input-mysql-username', 'input-mysql-password', 'input-mysql-database', 'input-mysql-tls-mode']) {
      expect(wrapper.find(`[data-test="${f}"]`).exists(), f).toBe(true)
    }
    expect((wrapper.find('[data-test="input-mysql-port"]').element as HTMLInputElement).value).toBe('3306')
    expect((wrapper.find('[data-test="input-mysql-tls-mode"]').element as HTMLSelectElement).value).toBe('disabled')
  })

  it('prefills tidb defaults (port 4000 / TLS disabled) when tidb is selected', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-tidb"]').trigger('click')
    expect((wrapper.find('[data-test="input-mysql-port"]').element as HTMLInputElement).value).toBe('4000')
    // 自建 TiDB 默认不开 TLS;TiDB Cloud 等托管服务需用户显式选择 TLS。
    expect((wrapper.find('[data-test="input-mysql-tls-mode"]').element as HTMLSelectElement).value).toBe('disabled')
    // 从 TiDB 切回 MySQL 恢复 MySQL 默认值。
    await wrapper.find('[data-test="type-card-mysql"]').trigger('click')
    expect((wrapper.find('[data-test="input-mysql-port"]').element as HTMLInputElement).value).toBe('3306')
    expect((wrapper.find('[data-test="input-mysql-tls-mode"]').element as HTMLSelectElement).value).toBe('disabled')
  })

  it('offers the three TLS modes in the dropdown and saves the chosen one', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-mysql"]').trigger('click')
    const tls = wrapper.find('[data-test="input-mysql-tls-mode"]')
    expect(tls.findAll('option').map((o) => o.element.value)).toEqual(['disabled', 'skip-verify', 'verify-full'])
    await tls.setValue('verify-full')
    await wrapper.find('[data-test="input-name"]').setValue('my-local')
    await wrapper.find('[data-test="input-mysql-host"]').setValue('h.internal')
    await wrapper.find('[data-test="input-mysql-username"]').setValue('app')
    await wrapper.find('[data-test="input-mysql-password"]').setValue('pw')
    await wrapper.find('[data-test="input-mysql-database"]').setValue('orders')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'my-local',
          type: 'mysql',
          config: { host: 'h.internal', port: 3306, username: 'app', password: 'pw', database: 'orders', tls_mode: 'verify-full' },
        }),
      )
    })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('saves a tidb connection with type tidb and tidb defaults', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-tidb"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('tidb-local')
    await wrapper.find('[data-test="input-mysql-host"]').setValue('127.0.0.1')
    await wrapper.find('[data-test="input-mysql-username"]').setValue('root')
    await wrapper.find('[data-test="input-mysql-database"]').setValue('shop')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'tidb-local',
          type: 'tidb',
          config: { host: '127.0.0.1', port: 4000, username: 'root', password: '', database: 'shop', tls_mode: 'disabled' },
        }),
      )
    })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('save stays disabled while the mysql host is empty', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-mysql"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('my')
    expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="input-mysql-host"]').setValue('h.internal')
    expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('routes test connection to testMysqlConnection when mysql/tidb is selected', async () => {
    const api2 = fakeApi({ testMysqlConnection: vi.fn(async () => {}) })
    setApi(api2)
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-tidb"]').trigger('click')
    await wrapper.find('[data-test="input-mysql-host"]').setValue('10.0.0.1')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(api2.testMysqlConnection).toHaveBeenCalledWith(
        expect.objectContaining({ host: '10.0.0.1', port: 4000, tls_mode: 'disabled' }),
      )
    })
    expect(api2.testConnection).not.toHaveBeenCalled()
    expect(api2.testCHConnection).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="test-ok"]').exists()).toBe(true)
  })

  it('surfaces test errors for mysql connections', async () => {
    const api2 = fakeApi({
      testMysqlConnection: vi.fn(async () => {
        throw new Error('access denied for user')
      }),
    })
    setApi(api2)
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-mysql"]').trigger('click')
    await wrapper.find('[data-test="input-mysql-host"]').setValue('h.internal')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="test-error"]').text()).toBe('access denied for user')
    })
  })

  it('prefills mysql fields in edit mode and carries the connection type on update', async () => {
    const conn: Connection = {
      id: 'my1',
      name: 'my-old',
      type: 'mysql',
      config: { host: 'h.internal', port: 3307, username: 'app', password: 'pw', database: 'orders', tls_mode: 'verify-full' },
      created_at: 1,
      updated_at: 1,
    }
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: conn } })
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="input-mysql-host"]').element as HTMLInputElement).value).toBe('h.internal')
    })
    expect((wrapper.find('[data-test="input-mysql-port"]').element as HTMLInputElement).value).toBe('3307')
    expect((wrapper.find('[data-test="input-mysql-username"]').element as HTMLInputElement).value).toBe('app')
    expect((wrapper.find('[data-test="input-mysql-password"]').element as HTMLInputElement).value).toBe('pw')
    expect((wrapper.find('[data-test="input-mysql-database"]').element as HTMLInputElement).value).toBe('orders')
    expect((wrapper.find('[data-test="input-mysql-tls-mode"]').element as HTMLSelectElement).value).toBe('verify-full')
    await wrapper.find('[data-test="input-name"]').setValue('my-new')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'my1',
          name: 'my-new',
          type: 'mysql',
          config: expect.objectContaining({ host: 'h.internal', port: 3307, tls_mode: 'verify-full' }),
        }),
      )
    })
  })

  it('prefills tidb fields in edit mode with the tidb type', async () => {
    const conn: Connection = {
      id: 'ti1',
      name: 'ti-old',
      type: 'tidb',
      config: { host: 'ti.internal', port: 4000, username: 'root', password: '', database: 'sales', tls_mode: 'skip-verify' },
      created_at: 1,
      updated_at: 1,
    }
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: conn } })
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="input-mysql-host"]').element as HTMLInputElement).value).toBe('ti.internal')
    })
    expect((wrapper.find('[data-test="input-mysql-port"]').element as HTMLInputElement).value).toBe('4000')
    expect(wrapper.find('[data-test="type-card-tidb"]').classes()).toContain('active')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({ id: 'ti1', type: 'tidb' }),
      )
    })
  })

  it('password inputs toggle visibility via eye button', async () => {
    const wrapper = mountModal()
    // kafka:密码框仅在 SASL 非 GSSAPI 时出现,先切到 SASL_PLAINTEXT。
    await wrapper.find('[data-test="input-security-protocol"]').setValue('SASL_PLAINTEXT')
    const kafkaInput = wrapper.find('[data-test="input-password"]')
    expect(kafkaInput.attributes('type')).toBe('password')
    const kafkaToggle = wrapper.find('[data-test="toggle-password-kafka"]')
    expect(kafkaToggle.attributes('aria-label')).toBe('显示密码')
    expect(kafkaToggle.attributes('type')).toBe('button')
    await kafkaToggle.trigger('click')
    expect(kafkaInput.attributes('type')).toBe('text')
    expect(kafkaToggle.attributes('aria-label')).toBe('隐藏密码')
    // 明文状态下输入仍能正常写入 v-model。
    await kafkaInput.setValue('secret')
    expect((kafkaInput.element as HTMLInputElement).value).toBe('secret')
    await kafkaToggle.trigger('click')
    expect(kafkaInput.attributes('type')).toBe('password')

    // redis
    await wrapper.find('[data-test="type-card-redis"]').trigger('click')
    const redisInput = wrapper.find('[data-test="input-redis-password"]')
    expect(redisInput.attributes('type')).toBe('password')
    const redisToggle = wrapper.find('[data-test="toggle-password-redis"]')
    expect(redisToggle.attributes('type')).toBe('button')
    expect(redisToggle.attributes('aria-label')).toBe('显示密码')
    await redisToggle.trigger('click')
    expect(redisInput.attributes('type')).toBe('text')
    await redisToggle.trigger('click')
    expect(redisInput.attributes('type')).toBe('password')

    // clickhouse
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    const chInput = wrapper.find('[data-test="input-ch-password"]')
    expect(chInput.attributes('type')).toBe('password')
    const chToggle = wrapper.find('[data-test="toggle-password-ch"]')
    expect(chToggle.attributes('type')).toBe('button')
    expect(chToggle.attributes('aria-label')).toBe('显示密码')
    await chToggle.trigger('click')
    expect(chInput.attributes('type')).toBe('text')
    await chToggle.trigger('click')
    expect(chInput.attributes('type')).toBe('password')
  })

  it('shows clickhouse fields and hides kafka/redis fields when clickhouse is selected', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    expect(wrapper.find('[data-test="input-brokers"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-addr"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-ch-hosts"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-ch-username"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-ch-password"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-ch-database"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-ch-tls"]').exists()).toBe(true)
    // 默认值:用户名与库均为 default。
    expect((wrapper.find('[data-test="input-ch-username"]').element as HTMLInputElement).value).toBe('default')
    expect((wrapper.find('[data-test="input-ch-database"]').element as HTMLInputElement).value).toBe('default')
  })

  it('keeps entered fields when switching between type cards', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    await wrapper.find('[data-test="input-ch-hosts"]').setValue('n1:9000')
    await wrapper.find('[data-test="type-card-kafka"]').trigger('click')
    await wrapper.find('[data-test="input-brokers"]').setValue('b:9092')
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    expect((wrapper.find('[data-test="input-ch-hosts"]').element as HTMLInputElement).value).toBe('n1:9000')
    await wrapper.find('[data-test="type-card-kafka"]').trigger('click')
    expect((wrapper.find('[data-test="input-brokers"]').element as HTMLInputElement).value).toBe('b:9092')
  })

  it('saves a clickhouse connection with split hosts and type clickhouse', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('ch-local')
    await wrapper.find('[data-test="input-ch-hosts"]').setValue('node1:9000, node2:9000,,')
    await wrapper.find('[data-test="input-ch-username"]').setValue('alice')
    await wrapper.find('[data-test="input-ch-password"]').setValue('pw')
    await wrapper.find('[data-test="input-ch-database"]').setValue('logs')
    await wrapper.find('[data-test="input-ch-tls"]').setValue(true)
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ch-local',
          type: 'clickhouse',
          config: { hosts: ['node1:9000', 'node2:9000'], username: 'alice', password: 'pw', database: 'logs', tls: true, protocol: 'native' },
        }),
      )
    })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('prefills clickhouse fields in edit mode and updates through updateConnection', async () => {
    const conn: Connection = {
      id: 'ch1',
      name: 'ch-old',
      type: 'clickhouse',
      config: { hosts: ['a:9000', 'b:9000'], username: 'default', password: 'pw', database: 'default', tls: true },
      created_at: 1,
      updated_at: 1,
    }
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: conn } })
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="input-ch-hosts"]').element as HTMLInputElement).value).toBe('a:9000, b:9000')
    })
    expect((wrapper.find('[data-test="input-ch-username"]').element as HTMLInputElement).value).toBe('default')
    expect((wrapper.find('[data-test="input-ch-database"]').element as HTMLInputElement).value).toBe('default')
    expect((wrapper.find('[data-test="input-ch-tls"]').element as HTMLInputElement).checked).toBe(true)
    await wrapper.find('[data-test="input-name"]').setValue('ch-new')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ch1',
          name: 'ch-new',
          config: expect.objectContaining({ hosts: ['a:9000', 'b:9000'] }),
        }),
      )
    })
  })

  it('routes test connection to testCHConnection when clickhouse is selected', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    await wrapper.find('[data-test="input-ch-hosts"]').setValue('n1:9000')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.testCHConnection).toHaveBeenCalledWith(
        expect.objectContaining({ hosts: ['n1:9000'] }),
      )
    })
    expect(api.testConnection).not.toHaveBeenCalled()
    expect(api.testRedisConnection).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="test-ok"]').exists()).toBe(true)
  })

  it('shows the CH protocol selector defaulting to native and saves http when chosen', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    const sel = wrapper.find('[data-test="input-ch-protocol"]')
    expect(sel.exists()).toBe(true)
    expect((sel.element as HTMLSelectElement).value).toBe('native')
    await sel.setValue('http')
    await wrapper.find('[data-test="input-name"]').setValue('ch-http')
    await wrapper.find('[data-test="input-ch-hosts"]').setValue('10.128.10.10:8123')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'ch-http',
          type: 'clickhouse',
          config: expect.objectContaining({ hosts: ['10.128.10.10:8123'], protocol: 'http' }),
        }),
      )
    })
  })

  it('shows the default-port hint under the CH hosts input', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    expect(wrapper.find('[data-test="ch-port-hint"]').text()).toContain('9000')
    expect(wrapper.find('[data-test="ch-port-hint"]').text()).toContain('8123')
  })

  it('surfaces the backend port/protocol hint when the CH handshake fails', async () => {
    ;(api.testCHConnection as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('clickhouse ping: [handshake] unexpected packet [72] from server — 端口疑似 HTTP,请将协议切换为 HTTP 后重试'),
    )
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-clickhouse"]').trigger('click')
    await wrapper.find('[data-test="input-ch-hosts"]').setValue('10.128.10.10:8123')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="test-error"]').text()).toContain('端口疑似 HTTP')
    })
  })

  it('carries the connection type when saving an edited clickhouse connection', async () => {
    const conn: Connection = {
      id: 'ch9',
      name: 'ch-old',
      type: 'clickhouse',
      config: { hosts: ['h:9000'], username: 'default', database: 'default' },
      created_at: 1,
      updated_at: 1,
    }
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: conn } })
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'ch9',
          name: 'ch-old',
          type: 'clickhouse',
          config: expect.objectContaining({ hosts: ['h:9000'], username: 'default', database: 'default' }),
        }),
      )
    })
  })

  it('renders the es card and shows es fields when selected', async () => {
    const wrapper = mountModal()
    expect(wrapper.find('[data-test="type-card-es"]').exists()).toBe(true)
    await wrapper.find('[data-test="type-card-es"]').trigger('click')
    expect(wrapper.find('[data-test="type-card-es"]').classes()).toContain('active')
    expect(wrapper.find('[data-test="input-brokers"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-mysql-host"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-ch-hosts"]').exists()).toBe(false)
    const hosts = wrapper.find('[data-test="input-es-hosts"]')
    expect(hosts.exists()).toBe(true)
    // ES 地址自带端口,不渲染端口输入。
    expect(hosts.attributes('placeholder')).toBe('127.0.0.1:9200')
    // 默认 none 认证:不渲染任何凭据输入。
    expect(wrapper.find('[data-test="input-es-username"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-es-password"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-es-api-key"]').exists()).toBe(false)
    expect((wrapper.find('[data-test="input-es-tls-mode"]').element as HTMLSelectElement).value).toBe('disabled')
  })

  it('switches es credential fields with the auth mode dropdown', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-es"]').trigger('click')
    const auth = wrapper.find('[data-test="input-es-auth-mode"]')
    expect(auth.findAll('option').map((o) => o.element.value)).toEqual(['none', 'basic', 'apikey'])
    await auth.setValue('basic')
    expect(wrapper.find('[data-test="input-es-username"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-es-password"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-es-api-key"]').exists()).toBe(false)
    await auth.setValue('apikey')
    expect(wrapper.find('[data-test="input-es-username"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-es-password"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-es-api-key"]').exists()).toBe(true)
    await auth.setValue('none')
    expect(wrapper.find('[data-test="input-es-api-key"]').exists()).toBe(false)
  })

  it('saves an es connection with split hosts, auth mode and tls mode', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-es"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('es-local')
    await wrapper.find('[data-test="input-es-hosts"]').setValue('127.0.0.1:9200, es2:9200,,')
    await wrapper.find('[data-test="input-es-auth-mode"]').setValue('basic')
    await wrapper.find('[data-test="input-es-username"]').setValue('elastic')
    await wrapper.find('[data-test="input-es-password"]').setValue('pw')
    await wrapper.find('[data-test="input-es-tls-mode"]').setValue('verify-full')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'es-local',
          type: 'es',
          config: {
            hosts: ['127.0.0.1:9200', 'es2:9200'],
            username: 'elastic',
            password: 'pw',
            api_key: '',
            auth_mode: 'basic',
            tls_mode: 'verify-full',
          },
        }),
      )
    })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('save stays disabled while every es host is blank', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-es"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('es')
    expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(true)
    // 逗号/空格不算有效地址,任一非空即可保存。
    await wrapper.find('[data-test="input-es-hosts"]').setValue(' , ')
    expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="input-es-hosts"]').setValue('127.0.0.1:9200')
    expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(false)
  })

  it('routes test connection to testEsConnection when es is selected', async () => {
    const api2 = fakeApi({ testEsConnection: vi.fn(async () => {}) })
    setApi(api2)
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-es"]').trigger('click')
    await wrapper.find('[data-test="input-es-hosts"]').setValue('127.0.0.1:9200')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(api2.testEsConnection).toHaveBeenCalledWith(
        expect.objectContaining({ hosts: ['127.0.0.1:9200'], auth_mode: 'none', tls_mode: 'disabled' }),
      )
    })
    expect(api2.testConnection).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="test-ok"]').exists()).toBe(true)
  })

  it('surfaces test errors for es connections', async () => {
    const api2 = fakeApi({
      testEsConnection: vi.fn(async () => {
        throw new Error('connection refused')
      }),
    })
    setApi(api2)
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-es"]').trigger('click')
    await wrapper.find('[data-test="input-es-hosts"]').setValue('127.0.0.1:9200')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="test-error"]').text()).toBe('connection refused')
    })
  })

  it('prefills es fields in edit mode and carries type es on update', async () => {
    const conn: Connection = {
      id: 'es1',
      name: 'es-old',
      type: 'es',
      config: {
        hosts: ['10.0.0.1:9200', '10.0.0.2:9200'],
        username: 'elastic',
        password: 'pw',
        api_key: 'ZXNfYXBp',
        auth_mode: 'apikey',
        tls_mode: 'skip-verify',
      },
      created_at: 1,
      updated_at: 1,
    }
    const wrapper = mount(NewConnectionModal, { props: { show: true, connection: conn } })
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="input-es-hosts"]').element as HTMLInputElement).value).toBe('10.0.0.1:9200, 10.0.0.2:9200')
    })
    expect((wrapper.find('[data-test="input-es-auth-mode"]').element as HTMLSelectElement).value).toBe('apikey')
    // apikey 模式只回显 api key 输入。
    expect(wrapper.find('[data-test="input-es-username"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="input-es-password"]').exists()).toBe(false)
    expect((wrapper.find('[data-test="input-es-api-key"]').element as HTMLInputElement).value).toBe('ZXNfYXBp')
    expect((wrapper.find('[data-test="input-es-tls-mode"]').element as HTMLSelectElement).value).toBe('skip-verify')
    expect(wrapper.find('[data-test="type-card-es"]').classes()).toContain('active')
    await wrapper.find('[data-test="input-name"]').setValue('es-new')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.updateConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          id: 'es1',
          name: 'es-new',
          type: 'es',
          config: expect.objectContaining({ hosts: ['10.0.0.1:9200', '10.0.0.2:9200'], auth_mode: 'apikey', tls_mode: 'skip-verify' }),
        }),
      )
    })
  })
})

describe('PostgreSQL 连接卡片', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })
  afterEach(() => document.body.innerHTML = '')

  function mountModal() {
    return mount(NewConnectionModal, { props: { show: true }, attachTo: document.body })
  }

  it('渲染 PostgreSQL 类型卡片,选中后显示 PG 字段与默认值(5432 / disable / 超时 5000)', async () => {
    const wrapper = mountModal()
    expect(wrapper.find('[data-test="type-card-postgres"]').exists()).toBe(true)
    await wrapper.find('[data-test="type-card-postgres"]').trigger('click')
    for (const f of ['input-postgres-host', 'input-postgres-port', 'input-postgres-username', 'input-postgres-password', 'input-postgres-database', 'input-postgres-tls-mode']) {
      expect(wrapper.find(`[data-test="${f}"]`).exists()).toBe(true)
    }
    expect((wrapper.find('[data-test="input-postgres-port"]').element as HTMLInputElement).value).toBe('5432')
    expect((wrapper.find('[data-test="input-postgres-tls-mode"]').element as HTMLSelectElement).value).toBe('disable')
  })

  it('测试连接走 testPostgresConnection 并携带完整配置(含 connect_timeout_ms)', async () => {
    const api2 = fakeApi({ testPostgresConnection: vi.fn(async () => {}) })
    setApi(api2)
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-postgres"]').trigger('click')
    await wrapper.find('[data-test="input-postgres-host"]').setValue('127.0.0.1')
    await wrapper.find('[data-test="input-postgres-username"]').setValue('postgres')
    await wrapper.find('[data-test="input-postgres-password"]').setValue('pw')
    await wrapper.find('[data-test="input-postgres-database"]').setValue('shop')
    await wrapper.find('[data-test="btn-test"]').trigger('click')
    await vi.waitFor(() => {
      expect(api2.testPostgresConnection).toHaveBeenCalledWith({
        host: '127.0.0.1',
        port: 5432,
        username: 'postgres',
        password: 'pw',
        database: 'shop',
        tls_mode: 'disable',
        connect_timeout_ms: 5000,
      })
    })
  })

  it('保存连接时 type 为 postgres 且配置含 search_path 可选项', async () => {
    const api2 = fakeApi({ createConnection: vi.fn(async (c: never) => c) })
    setApi(api2)
    const wrapper = mountModal()
    await wrapper.find('[data-test="type-card-postgres"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('pg-local')
    await wrapper.find('[data-test="input-postgres-host"]').setValue('127.0.0.1')
    await wrapper.find('[data-test="input-postgres-username"]').setValue('postgres')
    await wrapper.find('[data-test="input-postgres-database"]').setValue('shop')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api2.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'pg-local',
          type: 'postgres',
          config: expect.objectContaining({ host: '127.0.0.1', port: 5432, database: 'shop', tls_mode: 'disable', connect_timeout_ms: 5000 }),
        }),
      )
    })
  })
})

describe('PostgreSQL database 必填校验', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
  })
  afterEach(() => document.body.innerHTML = '')

  it('database 为空时保存与测试按钮禁用,填写后恢复', async () => {
    const wrapper = mount(NewConnectionModal, { props: { show: true } })
    await wrapper.find('[data-test="type-card-postgres"]').trigger('click')
    await wrapper.find('[data-test="input-postgres-host"]').setValue('127.0.0.1')
    await wrapper.find('[data-test="input-postgres-username"]').setValue('postgres')
    await wrapper.find('[data-test="input-name"]').setValue('pg-local')
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(true)
      expect((wrapper.find('[data-test="btn-test"]').element as HTMLButtonElement).disabled).toBe(true)
    })
    await wrapper.find('[data-test="input-postgres-database"]').setValue('shop')
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="btn-save"]').element as HTMLButtonElement).disabled).toBe(false)
      expect((wrapper.find('[data-test="btn-test"]').element as HTMLButtonElement).disabled).toBe(false)
    })
    // 模板展示必填标记与错误提示。
    expect(wrapper.find('[data-test="postgres-database-err"]').exists()).toBe(false)
    await wrapper.find('[data-test="input-postgres-database"]').setValue('')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="postgres-database-err"]').exists()).toBe(true)
    })
  })
})
