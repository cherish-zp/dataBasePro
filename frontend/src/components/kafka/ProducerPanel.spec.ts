import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { BatchProduceRequest } from '@/api/types'
import { COUNT_MAX } from '@/utils/batchProduce'
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
    alterTopicConfig: vi.fn(async () => {}),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
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

  it('shows a cap hint when the batch count exceeds COUNT_MAX', async () => {
    const { wrapper } = mountPanel()
    expect(wrapper.find('[data-test="count-cap-hint"]').exists()).toBe(false)
    await wrapper.find('[data-test="input-count"]').setValue(COUNT_MAX + 10)
    const hint = wrapper.find('[data-test="count-cap-hint"]')
    expect(hint.exists()).toBe(true)
    expect(hint.text()).toContain(String(COUNT_MAX))
  })

  it('hides the cap hint at or below COUNT_MAX', async () => {
    const { wrapper } = mountPanel()
    await wrapper.find('[data-test="input-count"]').setValue(COUNT_MAX)
    expect(wrapper.find('[data-test="count-cap-hint"]').exists()).toBe(false)
    await wrapper.find('[data-test="input-count"]').setValue(1)
    expect(wrapper.find('[data-test="count-cap-hint"]').exists()).toBe(false)
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

  it('caps an oversized JSON array batch at COUNT_MAX messages and failure rows', async () => {
    const big = JSON.stringify(Array.from({ length: COUNT_MAX + 10 }, (_, i) => `m-${i}`))
    const { wrapper, api } = mountPanel({
      produceMessages: vi.fn(async (req: BatchProduceRequest) =>
        req.messages.map((_m, index) => ({ index, partition: -1, offset: -1, error: 'boom' })),
      ),
    })
    await wrapper.find('[data-test="input-value"]').setValue(big)
    await wrapper.find('[data-test="input-count"]').setValue(2)
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    const call = vi.mocked(api.produceMessages).mock.calls[0][0]
    expect(call.messages).toHaveLength(COUNT_MAX)
    expect(wrapper.findAll('[data-test="batch-failures"] .msg.err')).toHaveLength(COUNT_MAX)
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

  it('clears the stale ok banner when the panel is reopened', async () => {
    const { wrapper } = mountPanel()
    await wrapper.find('[data-test="input-value"]').setValue('v')
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="produce-ok"]').exists()).toBe(true)
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true })
    expect(wrapper.find('[data-test="produce-ok"]').exists()).toBe(false)
  })

  it('clears the stale error banner when the panel is reopened', async () => {
    const { wrapper } = mountPanel({
      produceMessage: vi.fn(async () => {
        throw new Error('boom')
      }),
    })
    await wrapper.find('[data-test="input-value"]').setValue('v')
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="produce-error"].msg.err').text()).toContain('boom')
    })
    await wrapper.setProps({ show: false })
    await wrapper.setProps({ show: true })
    expect(wrapper.find('[data-test="produce-error"].msg.err').exists()).toBe(false)
  })

  it('keeps the ok banner while the panel stays open', async () => {
    const { wrapper } = mountPanel()
    await wrapper.find('[data-test="input-value"]').setValue('v')
    await wrapper.find('[data-test="btn-produce"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="produce-ok"]').exists()).toBe(true)
    await wrapper.find('[data-test="input-value"]').setValue('v2')
    expect(wrapper.find('[data-test="produce-ok"]').exists()).toBe(true)
  })

  describe('import file', () => {
    async function importFile(wrapper: ReturnType<typeof mountPanel>['wrapper'], name: string, content: string) {
      const file = new File([content], name)
      Object.defineProperty(wrapper.find('[data-test="import-input"]').element, 'files', {
        value: [file],
        configurable: true,
      })
      await wrapper.find('[data-test="import-input"]').trigger('change')
      // FileReader 通过事件循环异步回调，等待其 handler 完成后再断言。
      await new Promise((r) => setTimeout(r, 20))
      await flushPromises()
    }

    it('renders the import button and hidden file input', () => {
      const { wrapper } = mountPanel()
      expect(wrapper.find('[data-test="import-file"]').exists()).toBe(true)
      expect(wrapper.find('[data-test="import-input"]').exists()).toBe(true)
    })

    it('shows the imported message count after selecting a file', async () => {
      const { wrapper } = mountPanel()
      await importFile(wrapper, 'data.jsonl', '{"a":1}\n{"b":2}\n')
      expect(wrapper.find('[data-test="import-summary"]').text()).toContain('已导入 2 条消息')
    })

    it('sends imported messages through produceMessages and skips the single-send path', async () => {
      const { wrapper, api } = mountPanel({
        produceMessages: vi.fn(async () => [
          { index: 0, partition: 0, offset: 0, error: '' },
          { index: 1, partition: 0, offset: 1, error: '' },
        ]),
      })
      await importFile(wrapper, 'data.jsonl', '"alpha"\n"beta"\n')
      await wrapper.find('[data-test="btn-produce"]').trigger('click')
      await flushPromises()
      expect(api.produceMessage).not.toHaveBeenCalled()
      expect(api.produceMessages).toHaveBeenCalledWith({
        connection_id: 'c',
        topic: 'orders',
        partition: -1,
        messages: [
          { key: '', value: 'alpha' },
          { key: '', value: 'beta' },
        ],
      })
      expect(wrapper.find('[data-test="batch-summary"]').text()).toContain('成功 2 / 失败 0')
    })

    it('allows sending imported messages even when the value field is empty', async () => {
      const { wrapper, api } = mountPanel({
        produceMessages: vi.fn(async () => [{ index: 0, partition: 0, offset: 0, error: '' }]),
      })
      await importFile(wrapper, 'data.jsonl', '"only"\n')
      await wrapper.find('[data-test="btn-produce"]').trigger('click')
      await flushPromises()
      expect(api.produceMessages).toHaveBeenCalled()
    })

    it('renders per-message failures after sending imported messages', async () => {
      const { wrapper } = mountPanel({
        produceMessages: vi.fn(async () => [
          { index: 0, partition: 0, offset: 0, error: '' },
          { index: 1, partition: 0, offset: -1, error: 'boom' },
        ]),
      })
      await importFile(wrapper, 'data.jsonl', '"a"\n"b"\n')
      await wrapper.find('[data-test="btn-produce"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="batch-summary"]').text()).toContain('成功 1 / 失败 1')
      expect(wrapper.find('[data-test="batch-failures"]').text()).toContain('boom')
    })

    it('clears imported messages when the value field is edited', async () => {
      const { wrapper } = mountPanel()
      await importFile(wrapper, 'data.jsonl', '"a"\n"b"\n')
      expect(wrapper.find('[data-test="import-summary"]').exists()).toBe(true)
      await wrapper.find('[data-test="input-value"]').setValue('manual')
      expect(wrapper.find('[data-test="import-summary"]').exists()).toBe(false)
    })

    it('surfaces import parse errors on the error banner', async () => {
      const { wrapper } = mountPanel()
      await importFile(wrapper, 'data.jsonl', '{"ok":1}\nbad line\n')
      expect(wrapper.find('[data-test="produce-error"].msg.err').text()).toContain('第 2 行 JSON 解析失败')
    })

    it('clears imported messages when the topic changes', async () => {
      const { wrapper, api } = mountPanel()
      await importFile(wrapper, 'data.jsonl', '"alpha"\n"beta"\n')
      expect(wrapper.find('[data-test="import-summary"]').exists()).toBe(true)
      // 面板常驻挂载，切 topic 只改 prop；导入列表属于读取它的那个 topic，必须一并清空。
      await wrapper.setProps({ topic: 'other' })
      expect(wrapper.find('[data-test="import-summary"]').exists()).toBe(false)
      // 清空后普通发送走单条路径，旧导入列表不会被发到新 topic。
      await wrapper.find('[data-test="input-value"]').setValue('manual')
      await wrapper.find('[data-test="btn-produce"]').trigger('click')
      await flushPromises()
      expect(api.produceMessages).not.toHaveBeenCalled()
      expect(api.produceMessage).toHaveBeenCalledWith({
        connection_id: 'c', topic: 'other', partition: -1, key: '', value: 'manual',
      })
    })

    it('does not record imported values as recent templates', async () => {
      localStorage.clear()
      const { wrapper } = mountPanel({
        produceMessages: vi.fn(async () => [
          { index: 0, partition: 0, offset: 0, error: '' },
          { index: 1, partition: 0, offset: 1, error: '' },
        ]),
      })
      await importFile(wrapper, 'data.jsonl', '"alpha"\n"beta"\n')
      await wrapper.find('[data-test="btn-produce"]').trigger('click')
      await flushPromises()
      expect(JSON.parse(localStorage.getItem('dbclient.produce-templates.v1') ?? '[]')).toEqual([])
    })
  })
})
