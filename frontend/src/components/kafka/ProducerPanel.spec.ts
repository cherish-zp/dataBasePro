import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import ProducerPanel from './ProducerPanel.vue'

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

function mountPanel(overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(ProducerPanel, {
    props: { show: true, connectionId: 'c', topic: 'orders', partitions: [0, 1] },
  })
  return { wrapper, api }
}

describe('ProducerPanel', () => {
  it('renders nothing when hidden', () => {
    setActivePinia(createPinia())
    const wrapper = mount(ProducerPanel, { props: { show: false, connectionId: 'c', topic: 't', partitions: [] } })
    expect(wrapper.find('[data-test="producer-panel"]').exists()).toBe(false)
  })

  it('prefills the topic and partition options', () => {
    const { wrapper } = mountPanel()
    expect((wrapper.find('[data-test="input-topic"]').element as HTMLInputElement).value).toBe('orders')
    const options = wrapper.findAll('[data-test="input-partition"] option').map((o) => o.text())
    expect(options).toEqual(['自动', '0', '1'])
  })

  it('produces a message with key/value/partition', async () => {
    const { wrapper, api } = mountPanel()
    await wrapper.find('[data-test="input-key"]').setValue('order-1')
    await wrapper.find('[data-test="input-value"]').setValue('{"n":1}')
    await wrapper.find('[data-test="input-partition"]').setValue(1)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(api.produceMessage).toHaveBeenCalledWith({
      connection_id: 'c', topic: 'orders', partition: 1, key: 'order-1', value: '{"n":1}',
    })
    expect(wrapper.find('[data-test="produce-ok"]').exists()).toBe(true)
  })

  it('validates non-empty value before producing', async () => {
    const { wrapper, api } = mountPanel()
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(api.produceMessage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="produce-error"]').exists()).toBe(true)
  })

  it('surfaces produce errors', async () => {
    const { wrapper } = mountPanel({
      produceMessage: vi.fn(async () => {
        throw new Error('produce failed')
      }),
    })
    await wrapper.find('[data-test="input-value"]').setValue('v')
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="produce-error"]').text()).toContain('produce failed')
    })
  })

  it('emits close', async () => {
    const { wrapper } = mountPanel()
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })
})
