import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Message } from '@/api/types'
import MessageBrowser from './MessageBrowser.vue'

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
    listConsumerGroups: vi.fn(async () => []),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    ...overrides,
  }
}

const msg = (offset: number, partition = 0): Message => ({
  partition, offset, timestamp: 1700000000000, key: `k${offset}`, value: '{"n":1}', headers: [],
})

function mountBrowser(overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(MessageBrowser, {
    props: { tabId: 'tab1', connectionId: 'c', topic: 'events', partitions: [0, 1] },
  })
  return { wrapper, api }
}

describe('MessageBrowser', () => {
  it('fetches earliest messages on mount and renders rows', async () => {
    const { wrapper, api } = mountBrowser({
      consumeMessages: vi.fn(async () => [msg(0), msg(1), msg(2)]),
    })
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledWith(
        expect.objectContaining({ connection_id: 'c', topic: 'events', partition: -1, offset: -2, limit: 500 }),
      )
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="message-row"]')).toHaveLength(3)
    })
    expect(wrapper.find('[data-test="message-count"]').text()).toBe('3 条')
  })

  it('shows an empty state when no messages', async () => {
    const { wrapper } = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="browse-empty"]').exists()).toBe(true)
    })
  })

  it('surfaces fetch errors', async () => {
    const { wrapper } = mountBrowser({
      consumeMessages: vi.fn(async () => {
        throw new Error('broker down')
      }),
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="browse-error"]').text()).toBe('broker down')
    })
  })

  it('opens the detail drawer on row click', async () => {
    const { wrapper } = mountBrowser({
      consumeMessages: vi.fn(async () => [msg(5, 1)]),
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="message-row"]').length).toBe(1)
    })
    await wrapper.find('[data-test="message-row"]').trigger('click')
    expect(wrapper.find('[data-test="message-drawer"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="meta-offset"]').text()).toContain('5')
  })

  it('loads the next page via load more', async () => {
    const consume = vi.fn(async () => [msg(0), msg(1), msg(2)])
    const { wrapper } = mountBrowser({ consumeMessages: consume })
    // The load-more button only appears for single-partition pages that are
    // exactly full (hasMore); All-partition queries do not paginate.
    await wrapper.find('[data-test="filter-partition"]').setValue(0)
    await wrapper.find('[data-test="filter-limit"]').setValue(3)
    await wrapper.find('[data-test="btn-query"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="btn-load-more"]').exists()).toBe(true)
    })
    consume.mockResolvedValueOnce([msg(3)])
    await wrapper.find('[data-test="btn-load-more"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="message-row"]')).toHaveLength(4)
    })
  })

  it('renders UTF-8 (Chinese) message values verbatim, not base64', async () => {
    const { wrapper } = mountBrowser({
      consumeMessages: vi.fn(async () => [
        { ...msg(0), key: 'cn', value: '中文消息 你好 hello 世界', headers: [] },
      ]),
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="message-row"]')).toHaveLength(1)
    })
    const row = wrapper.find('[data-test="message-row"]')
    expect(row.text()).toContain('中文消息 你好 hello 世界')
    expect(row.text()).not.toContain('5Lit')
  })

  it('uses timestamp mode when selected', async () => {
    const { wrapper, api } = mountBrowser({
      consumeMessagesByTimestamp: vi.fn(async () => [msg(9)]),
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="message-row"]').length).toBe(0)
    })
    await wrapper.find('[data-test="filter-mode"]').setValue('timestamp')
    await wrapper.find('[data-test="filter-timestamp"]').setValue(123456789)
    await wrapper.find('[data-test="btn-query"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.consumeMessagesByTimestamp).toHaveBeenCalledWith(
        expect.objectContaining({ timestamp_ms: 123456789, partition: -1 }),
      )
    })
  })
})
