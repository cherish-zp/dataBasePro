import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
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
    listConsumerGroups: vi.fn(async () => []),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
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
    await wrapper.find('[data-test="input-sasl"]').setValue(true)
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
          config: { bootstrap_servers: ['a:9092', 'b:9092'] },
        }),
      )
    })
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  it('includes SASL settings when enabled', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="input-name"]').setValue('secure')
    await wrapper.find('[data-test="input-brokers"]').setValue('localhost:9092')
    await wrapper.find('[data-test="input-sasl"]').setValue(true)
    await wrapper.find('[data-test="input-mechanism"]').setValue('SCRAM-SHA-256')
    await wrapper.find('[data-test="input-username"]').setValue('user')
    await wrapper.find('[data-test="input-password"]').setValue('secret')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.createConnection).toHaveBeenCalledWith(
        expect.objectContaining({
          config: expect.objectContaining({
            sasl: { enabled: true, mechanism: 'SCRAM-SHA-256', username: 'user', password: 'secret' },
          }),
        }),
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

  it('emits close via backdrop and close button', async () => {
    const wrapper = mountModal()
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
