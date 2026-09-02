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

  it('emits close via backdrop and close button', async () => {
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
})
