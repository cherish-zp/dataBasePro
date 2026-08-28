import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Message } from '@/api/types'
import { useSqlHistoryStore } from '@/store/sqlhistory'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, downloadFile, exportCsv, exportJsonl } from '@/utils/export'
import SqlConsole from './SqlConsole.vue'

// Stub the DOM download trigger but keep the real CSV/JSONL builders, so the
// assertions check exactly what the component passes to downloadFile.
vi.mock('@/utils/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/export')>()
  return { ...actual, downloadFile: vi.fn() }
})

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
  // The console persists query history to localStorage; start every test from
  // a clean slate so dropdown contents are deterministic.
  beforeEach(() => localStorage.clear())

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

  // Tab switch reuses the mounted console (only props change), so the topic
  // watcher must rebind the editor template and wipe stale results.
  it('rebinds the query and clears results when the tab switches topic', async () => {
    const { wrapper, api } = mountConsole({
      consumeMessages: vi.fn(async () => [msg('k1', 'v1')]),
    })
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.findAll('[data-test="sql-row"]')).toHaveLength(1)

    await wrapper.setProps({ topic: 'bad_t81_test' })
    expect((wrapper.find('[data-test="input-sql"]').element as HTMLTextAreaElement).value).toBe(
      'SELECT * FROM bad_t81_test LIMIT 100',
    )
    expect(wrapper.findAll('[data-test="sql-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="sql-empty"]').exists()).toBe(true)

    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenLastCalledWith(expect.objectContaining({ topic: 'bad_t81_test' }))
  })

  // Documents current watcher semantics: an in-progress user edit is discarded
  // on topic change (no dirty-state guard), so any future guard would surface
  // here instead of silently changing behavior.
  it('overwrites a user-edited query when the topic changes', async () => {
    const { wrapper } = mountConsole()
    await wrapper.find('[data-test="input-sql"]').setValue("SELECT * FROM orders WHERE key = 'k1'")
    await wrapper.setProps({ topic: 'bad_t81_test' })
    expect((wrapper.find('[data-test="input-sql"]').element as HTMLTextAreaElement).value).toBe(
      'SELECT * FROM bad_t81_test LIMIT 100',
    )
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

  it('renders a disabled export control until results exist', () => {
    const { wrapper } = mountConsole()
    const toggle = wrapper.find('[data-test="export-toggle"]')
    expect(toggle.exists()).toBe(true)
    expect(toggle.attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="export-csv"]').exists()).toBe(false)
  })

  it('exports query results as CSV via the dropdown', async () => {
    const messages: Message[] = [msg('中文键', 'a,b'), msg('k2', 'v2')]
    const { wrapper } = mountConsole({
      consumeMessages: vi.fn(async () => messages),
    })
    await wrapper.find('[data-test="input-sql"]').setValue('SELECT * FROM orders')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    const toggle = wrapper.find('[data-test="export-toggle"]')
    expect(toggle.attributes('disabled')).toBeUndefined()
    await toggle.trigger('click')
    await wrapper.find('[data-test="export-csv"]').trigger('click')
    expect(vi.mocked(downloadFile)).toHaveBeenCalledWith(
      'query-results',
      exportCsv(messages, MESSAGE_EXPORT_COLUMNS),
      CSV_MIME,
    )
  })

  it('exports query results as JSONL via the dropdown', async () => {
    const messages: Message[] = [msg('k1', 'v1')]
    const { wrapper } = mountConsole({
      consumeMessages: vi.fn(async () => messages),
    })
    await wrapper.find('[data-test="input-sql"]').setValue('SELECT * FROM orders')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="export-toggle"]').trigger('click')
    await wrapper.find('[data-test="export-jsonl"]').trigger('click')
    expect(vi.mocked(downloadFile)).toHaveBeenCalledWith(
      'query-results',
      exportJsonl(messages),
      JSONL_MIME,
    )
  })

  it('records an executed query into the history store', async () => {
    const { wrapper } = mountConsole()
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(useSqlHistoryStore().history).toEqual(['SELECT * FROM orders LIMIT 100'])
  })

  it('does not record a query that fails to parse', async () => {
    const { wrapper } = mountConsole()
    await wrapper.find('[data-test="input-sql"]').setValue('INSERT INTO t VALUES (1)')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="sql-error"]').exists()).toBe(true)
    expect(useSqlHistoryStore().history).toEqual([])
  })

  it('opens the history/favorites dropdown with both sections', async () => {
    const { wrapper } = mountConsole()
    expect(wrapper.find('[data-test="history-pop"]').exists()).toBe(false)
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    const pop = wrapper.find('[data-test="history-pop"]')
    expect(pop.exists()).toBe(true)
    expect(pop.text()).toContain('历史')
    expect(pop.text()).toContain('收藏')
    expect(wrapper.find('[data-test="history-empty"]').exists()).toBe(true)
  })

  it('refills the editor and re-executes from a history item', async () => {
    const { wrapper, api } = mountConsole()
    await wrapper.find('[data-test="input-sql"]').setValue('SELECT * FROM orders LIMIT 10')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="input-sql"]').setValue('SELECT * FROM orders LIMIT 20')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    const items = wrapper.findAll('[data-test="history-item"]')
    expect(items).toHaveLength(2)
    await items[1].trigger('click')
    await flushPromises()
    expect((wrapper.find('[data-test="input-sql"]').element as HTMLTextAreaElement).value).toBe(
      'SELECT * FROM orders LIMIT 10',
    )
    expect(api.consumeMessages).toHaveBeenCalledTimes(3)
    expect(api.consumeMessages).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10 }))
  })

  it('saves the current sql as a named favorite via the inline form', async () => {
    const { wrapper } = mountConsole()
    await wrapper.find('[data-test="input-sql"]').setValue("SELECT * FROM orders WHERE key = 'x'")
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    const save = wrapper.find('[data-test="fav-save"]')
    expect(save.attributes('disabled')).toBeUndefined()
    await save.trigger('click')
    const input = wrapper.find('[data-test="fav-name-input"]')
    expect(input.exists()).toBe(true)
    await input.setValue('recent-errors')
    await input.trigger('keydown.enter')
    expect(useSqlHistoryStore().favorites).toEqual([
      { name: 'recent-errors', sql: "SELECT * FROM orders WHERE key = 'x'" },
    ])
    expect(wrapper.find('[data-test="fav-item"]').text()).toContain('recent-errors')
  })

  it('disables saving while the editor is empty', async () => {
    const { wrapper } = mountConsole()
    await wrapper.find('[data-test="input-sql"]').setValue('   ')
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="fav-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="fav-name-input"]').exists()).toBe(false)
  })

  it('removes a favorite from the dropdown', async () => {
    const { wrapper, api } = mountConsole()
    useSqlHistoryStore().saveFavorite('top-errors', 'SELECT * FROM errors')
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="fav-item"]').text()).toContain('top-errors')
    await wrapper.find('[data-test="fav-remove"]').trigger('click')
    expect(useSqlHistoryStore().favorites).toEqual([])
    expect(wrapper.find('[data-test="fav-item"]').exists()).toBe(false)
    expect(api.consumeMessages).not.toHaveBeenCalled()
  })
})
