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
    describeCluster: vi.fn(async () => ({ cluster_id: "", controller_id: -1, kafka_version: "", brokers: [], under_replicated_partitions: 0 })),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
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

  it('prefills the topic from the active tab each time the panel opens', async () => {
    setActivePinia(createPinia())
    setApi(fakeApi())
    const wrapper = mount(ProducerPanel, {
      props: { show: false, connectionId: 'c', topic: 'a', partitions: [0, 1] },
    })
    await wrapper.setProps({ topic: 'bad_t81_test' })
    await wrapper.setProps({ show: true })
    expect((wrapper.find('[data-test="input-topic"]').element as HTMLInputElement).value).toBe('bad_t81_test')
  })

  it('follows topic prop changes while the panel stays open', async () => {
    setActivePinia(createPinia())
    setApi(fakeApi())
    const wrapper = mount(ProducerPanel, {
      props: { show: true, connectionId: 'c', topic: 'a', partitions: [0, 1] },
    })
    await wrapper.setProps({ topic: 'b' })
    expect((wrapper.find('[data-test="input-topic"]').element as HTMLInputElement).value).toBe('b')
  })

  it('keeps a manually edited topic when no open or prop change happens', async () => {
    const { wrapper } = mountPanel()
    await wrapper.find('[data-test="input-topic"]').setValue('custom')
    expect((wrapper.find('[data-test="input-topic"]').element as HTMLInputElement).value).toBe('custom')
  })

  it('renders batch mode controls', () => {
    const { wrapper } = mountPanel()
    expect((wrapper.find('[data-test="input-count"]').element as HTMLInputElement).value).toBe('1')
    expect(wrapper.find('[data-test="input-random-key"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="input-loop"]').exists()).toBe(true)
  })

  it('sends the same value N times in loop mode and shows the batch summary', async () => {
    const { wrapper, api } = mountPanel({
      produceMessages: vi.fn(async () => [
        { index: 0, partition: 0, offset: 0, error: '' },
        { index: 1, partition: 0, offset: 1, error: '' },
        { index: 2, partition: 0, offset: 2, error: '' },
      ]),
    })
    await wrapper.find('[data-test="input-value"]').setValue('payload')
    await wrapper.find('[data-test="input-count"]').setValue(3)
    await wrapper.find('[data-test="input-loop"]').setValue(true)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(api.produceMessages).toHaveBeenCalledWith({
      connection_id: 'c',
      topic: 'orders',
      partition: -1,
      messages: [
        { key: '', value: 'payload' },
        { key: '', value: 'payload' },
        { key: '', value: 'payload' },
      ],
    })
    expect(api.produceMessage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="batch-summary"]').text()).toContain('成功 3 / 失败 0')
  })

  it('generates a random key per message when 随机 key is on', async () => {
    const { wrapper, api } = mountPanel({
      produceMessages: vi.fn(async () => [{ index: 0, partition: 0, offset: 0, error: '' }]),
    })
    await wrapper.find('[data-test="input-value"]').setValue('v')
    await wrapper.find('[data-test="input-random-key"]').setValue(true)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    const call = vi.mocked(api.produceMessages).mock.calls[0][0]
    expect(call.messages).toHaveLength(1)
    expect(call.messages[0].key).toMatch(/^key-/)
    expect(api.produceMessage).not.toHaveBeenCalled()
  })

  it('expands a JSON array value into one message per element without loop', async () => {
    const { wrapper, api } = mountPanel({
      produceMessages: vi.fn(async () => [
        { index: 0, partition: 0, offset: 0, error: '' },
        { index: 1, partition: 0, offset: 1, error: '' },
      ]),
    })
    await wrapper.find('[data-test="input-value"]').setValue('["a", {"x":1}]')
    await wrapper.find('[data-test="input-count"]').setValue(2)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(api.produceMessages).toHaveBeenCalledWith({
      connection_id: 'c',
      topic: 'orders',
      partition: -1,
      messages: [
        { key: '', value: 'a' },
        { key: '', value: '{"x":1}' },
      ],
    })
  })

  it('surfaces an error when array mode receives a non-array value', async () => {
    const { wrapper, api } = mountPanel()
    await wrapper.find('[data-test="input-value"]').setValue('not json')
    await wrapper.find('[data-test="input-count"]').setValue(2)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(api.produceMessages).not.toHaveBeenCalled()
    expect(api.produceMessage).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="produce-error"]').exists()).toBe(true)
  })

  it('lists failed indexes with their errors after a batch send', async () => {
    const { wrapper } = mountPanel({
      produceMessages: vi.fn(async () => [
        { index: 0, partition: 0, offset: 0, error: '' },
        { index: 1, partition: 0, offset: -1, error: 'boom' },
      ]),
    })
    await wrapper.find('[data-test="input-value"]').setValue('v')
    await wrapper.find('[data-test="input-count"]').setValue(2)
    await wrapper.find('[data-test="input-loop"]').setValue(true)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="batch-summary"]').text()).toContain('成功 1 / 失败 1')
    expect(wrapper.find('[data-test="batch-failures"]').text()).toContain('boom')
  })

  it('records sent values as recent templates and refills on click', async () => {
    localStorage.clear()
    const { wrapper, api } = mountPanel()
    await wrapper.find('[data-test="input-value"]').setValue('tpl-value')
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(api.produceMessage).toHaveBeenCalled()
    expect(JSON.parse(localStorage.getItem('dbclient.produce-templates.v1') ?? '[]')).toEqual(['tpl-value'])

    await wrapper.find('[data-test="template-toggle"]').trigger('click')
    const items = wrapper.findAll('[data-test="template-item"]')
    expect(items).toHaveLength(1)
    await items[0].trigger('click')
    expect((wrapper.find('[data-test="input-value"]').element as HTMLTextAreaElement).value).toBe('tpl-value')
  })

  it('records batch values as templates only for successful messages', async () => {
    localStorage.clear()
    const { wrapper } = mountPanel({
      produceMessages: vi.fn(async () => [
        { index: 0, partition: 0, offset: 0, error: '' },
        { index: 1, partition: 0, offset: -1, error: 'boom' },
      ]),
    })
    await wrapper.find('[data-test="input-value"]').setValue('["good","bad"]')
    await wrapper.find('[data-test="input-count"]').setValue(2)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(JSON.parse(localStorage.getItem('dbclient.produce-templates.v1') ?? '[]')).toEqual(['good'])
  })
})
