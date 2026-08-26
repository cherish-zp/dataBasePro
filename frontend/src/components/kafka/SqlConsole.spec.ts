import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Message } from '@/api/types'
import SqlConsole from './SqlConsole.vue'

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

const msg = (key: string, value: string, offset = 0): Message => ({
  partition: 0, offset, timestamp: 1700000000000, key, value, headers: [],
})

function mountConsole(overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(SqlConsole, {
    props: { tabId: 'tab1', connectionId: 'c', topic: 'orders', partitions: [0, 1] },
  })
  return { wrapper, api }
}

describe('SqlConsole', () => {
  it('renders the console as a full page', () => {
    const { wrapper } = mountConsole()
    expect(wrapper.find('[data-test="sql-console"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="modal-backdrop"]').exists()).toBe(false)
  })

  it('omits the engine selector because the engine is fixed to the source', () => {
    const { wrapper } = mountConsole()
    expect(wrapper.find('[data-test="select-engine"]').exists()).toBe(false)
  })

  it('stretches the sql editor across the toolbar next to the run button', () => {
    const { wrapper } = mountConsole()
    const toolbar = wrapper.find('[data-test="sql-toolbar"]')
    expect(toolbar.find('[data-test="input-sql"]').exists()).toBe(true)
    expect(toolbar.find('[data-test="btn-run"]').exists()).toBe(true)
    expect(toolbar.find('[data-test="sql-field"]').classes()).toContain('grow')
  })

  it('prefills the query with the current topic', () => {
    const { wrapper } = mountConsole()
    expect((wrapper.find('[data-test="input-sql"]').element as HTMLTextAreaElement).value).toContain('orders')
  })

  it('runs a query and applies a WHERE key filter', async () => {
    const { wrapper, api } = mountConsole({
      consumeMessages: vi.fn(async () => [msg('k1', 'v1'), msg('k2', 'v2'), msg('k1', 'v3')]),
    })
    await wrapper.find('[data-test="input-sql"]').setValue("SELECT * FROM orders WHERE key = 'k1'")
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenCalledWith(
      expect.objectContaining({ connection_id: 'c', topic: 'orders', partition: -1, offset: -2 }),
    )
    const rows = wrapper.findAll('[data-test="sql-row"]').map((r) => r.text())
    expect(rows).toHaveLength(2)
    expect(rows[0]).toContain('k1')
    expect(rows[1]).toContain('k1')
  })

  it('applies a LIKE filter and LIMIT', async () => {
    const { wrapper } = mountConsole({
      consumeMessages: vi.fn(async () => [msg('a', 'hello'), msg('b', 'world')]),
    })
    await wrapper.find('[data-test="input-sql"]').setValue("SELECT * FROM orders WHERE value LIKE '%ell%' LIMIT 1")
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('[data-test="sql-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('hello')
  })

  it('shows an error for invalid SQL', async () => {
    const { wrapper } = mountConsole()
    await wrapper.find('[data-test="input-sql"]').setValue('INSERT INTO t VALUES (1)')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="sql-error"]').exists()).toBe(true)
  })


  it('surfaces backend errors', async () => {
    const { wrapper } = mountConsole({
      consumeMessages: vi.fn(async () => {
        throw new Error('cluster down')
      }),
    })
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="sql-error"]').text()).toContain('cluster down')
    })
  })
})
