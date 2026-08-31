import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import App from './App.vue'

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
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

const conn = (id: string): Connection => ({
  id, name: `conn-${id}`, type: 'kafka',
  config: { bootstrap_servers: ['h:1'] }, created_at: 1, updated_at: 1,
})

function mountApp(overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(App)
  return { wrapper, api }
}

describe('App', () => {
  beforeEach(() => setActivePinia(createPinia()))

  it('loads connections on mount and passes them to the layout', async () => {
    const { wrapper, api } = mountApp({ listConnections: vi.fn(async () => [conn('a')]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })
    expect(api.listConnections).toHaveBeenCalled()
    expect(wrapper.find('[data-test="layout"]').exists()).toBe(true)
  })

  it('opens and closes the new connection modal', async () => {
    const { wrapper } = mountApp()
    await wrapper.find('[data-test="btn-new"]').trigger('click')
    expect(wrapper.find('[data-test="new-connection-modal"]').exists()).toBe(true)
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.find('[data-test="new-connection-modal"]').exists()).toBe(false)
  })

  it('creates a connection through the modal and shows it in the tree', async () => {
    const { wrapper, api } = mountApp()
    await wrapper.find('[data-test="btn-new"]').trigger('click')
    await wrapper.find('[data-test="input-name"]').setValue('本地')
    await wrapper.find('[data-test="input-brokers"]').setValue('localhost:9092')
    await wrapper.find('[data-test="btn-save"]').trigger('click')
    await flushPromises()
    expect(api.createConnection).toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })
    expect(wrapper.find('[data-test="conn-name"]').text()).toBe('本地')
  })

  it('deletes a connection', async () => {
    const { wrapper, api } = mountApp({ listConnections: vi.fn(async () => [conn('a')]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(1)
    })
    await wrapper.find('[data-test="btn-delete"]').trigger('click')
    await flushPromises()
    expect(api.deleteConnection).toHaveBeenCalledWith('a')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="connection"]')).toHaveLength(0)
    })
  })
})
