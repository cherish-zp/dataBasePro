import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Message } from '@/api/types'
import { useSqlHistoryStore } from '@/store/sqlhistory'
import { useTabsStore } from '@/store/tabs'
import { parseSelect } from '@/utils/sql'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, exportCsv, exportJsonl, saveFile } from '@/utils/export'
import { useQueryFiles } from '@/composables/queryFiles'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlConsole from './SqlConsole.vue'

// Stub the DOM download trigger but keep the real CSV/JSONL builders, so the
// assertions check exactly what the component passes to saveFile.
vi.mock('@/utils/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/export')>()
  return { ...actual, downloadFile: vi.fn(), saveFile: vi.fn(async () => {}) }
})

// parseSelect 以可透传的 spy 替换:仅「无表名守卫」用例需要桩掉解析结果
// (模拟 FROM 可省略的解析),其余用例经透传走真实实现。
vi.mock('@/utils/sql', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/sql')>()
  return { ...actual, parseSelect: vi.fn((input: string) => actual.parseSelect(input)) }
})

// vi.mock 会被提升到文件顶部,因此 mocks 必须用 vi.hoisted 创建,
// 否则工厂执行时 queryFileMocks 尚未初始化(TDZ)。
const queryFileMocks = vi.hoisted(() => ({
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...queryFileMocks }
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

const msg = (key: string, value: string, offset = 0): Message => ({
  partition: 0, offset, timestamp: 1700000000000, key, value, headers: [],
})

// --- CodeMirror 驱动(参照 SqlEditor.spec.ts 的 findFromDOM 做法) ---------------

// CM6 会在宿主容器内创建自己的 .cm-editor 元素,借 findFromDOM 拿到 view。
function cmView(wrapper: VueWrapper): EditorView {
  const host = wrapper.find('[data-test="sql-editor-content"] .cm-editor').element as HTMLElement
  const view = EditorView.findFromDOM(host)
  expect(view, 'EditorView.findFromDOM 应能取到实例').not.toBeNull()
  return view as EditorView
}

// 编辑器输入:对 CM 文档做全文替换 → update:modelValue → v-model 回写。
async function setSql(wrapper: VueWrapper, value: string): Promise<void> {
  const view = cmView(wrapper)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } })
  await nextTick()
}

// 编辑器内容断言:走 findComponent(SqlEditor) 暴露的 getValue()。
function editorSql(wrapper: VueWrapper): string {
  const vm = wrapper.findComponent(SqlEditor).vm as unknown as { getValue(): string }
  return vm.getValue()
}

// ⌘Enter/⌘S/IME 用例从 CM 的 contentDOM 触发(冒泡到控制台的 keydown 监听,与真实路径一致)。
function cmContent(wrapper: VueWrapper): DOMWrapper<Element> {
  return wrapper.find('[data-test="sql-editor-content"] .cm-content')
}

// PromptDialog Teleport 到 body,用原生事件驱动(参照 PromptDialog.spec.ts)。
function promptEl(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}
async function confirmPrompt(value: string): Promise<void> {
  const input = promptEl('prompt-input') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
  promptEl('prompt-confirm')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
  await flushPromises()
}

function mountConsole(overrides: Partial<Api> = {}, mountProps: { topic?: string } = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(SqlConsole, {
    props: { tabId: 'tab1', connectionId: 'c', topic: mountProps.topic ?? 'orders', partitions: [0, 1] },
  })
  return { wrapper, api }
}

describe('SqlConsole', () => {
  // The console persists query history to localStorage; start every test from
  // a clean slate so dropdown contents are deterministic. clearAllMocks wipes
  // call counts but keeps implementations set inside the mock factories.
  beforeEach(() => {
    localStorage.clear()
    vi.clearAllMocks()
  })

  it('renders the console as a full page', () => {
    const { wrapper } = mountConsole()
    expect(wrapper.find('[data-test="sql-console"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="modal-backdrop"]').exists()).toBe(false)
  })

  it('omits the engine selector because the engine is fixed to the source', () => {
    const { wrapper } = mountConsole()
    expect(wrapper.find('[data-test="select-engine"]').exists()).toBe(false)
  })

  it('omits the in-console file panel because saved queries moved to the global right panel', () => {
    const { wrapper } = mountConsole()
    expect(wrapper.find('[data-test="sql-file-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="btn-sql-file-area"]').exists()).toBe(false)
  })

  it('uses the CodeMirror editor inside the toolbar next to the run button', () => {
    const { wrapper } = mountConsole()
    const toolbar = wrapper.find('[data-test="sql-toolbar"]')
    expect(toolbar.find('[data-test="input-sql"]').exists()).toBe(true)
    expect(toolbar.findComponent(SqlEditor).exists()).toBe(true)
    expect(toolbar.find('[data-test="btn-run"]').exists()).toBe(true)
    expect(toolbar.find('[data-test="sql-field"]').classes()).toContain('grow')
  })

  it('prefills the query with the current topic', () => {
    const { wrapper } = mountConsole()
    expect(editorSql(wrapper)).toContain('orders')
  })

  it('maps the connection topics into the editor completion tables', async () => {
    const { wrapper } = mountConsole({
      listTopics: vi.fn(async () => [
        { name: 'orders', partitions: [] },
        { name: 'errors', partitions: [] },
      ]),
    })
    await flushPromises()
    const tables = wrapper.findComponent(SqlEditor).props('tables') as { name: string }[]
    expect(tables.map((t) => t.name)).toEqual(['orders', 'errors'])
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
    expect(editorSql(wrapper)).toBe('SELECT * FROM bad_t81_test LIMIT 100')
    expect(wrapper.findAll('[data-test="sql-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="sql-empty"]').exists()).toBe(true)

    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenLastCalledWith(expect.objectContaining({ topic: 'bad_t81_test' }))
  })

  // Per-topic draft cache (BL-007): switching to a topic with no saved draft
  // still rebinds the template, but the edited query is kept as that topic's
  // draft and restored when switching back.
  it('shows the template for a topic without a saved draft', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, "SELECT * FROM orders WHERE key = 'k1'")
    await wrapper.setProps({ topic: 'bad_t81_test' })
    expect(editorSql(wrapper)).toBe('SELECT * FROM bad_t81_test LIMIT 100')
  })

  it('restores the unrun draft when switching back to the topic', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, "SELECT * FROM orders WHERE key = 'k1'")
    await wrapper.setProps({ topic: 'bad_t81_test' })
    expect(editorSql(wrapper)).toBe('SELECT * FROM bad_t81_test LIMIT 100')
    await wrapper.setProps({ topic: 'orders' })
    expect(editorSql(wrapper)).toBe("SELECT * FROM orders WHERE key = 'k1'")
  })

  it('drops the saved draft when the editor is cleared before switching', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, "SELECT * FROM orders WHERE key = 'k1'")
    await wrapper.setProps({ topic: 'bad_t81_test' })
    await wrapper.setProps({ topic: 'orders' })
    expect(editorSql(wrapper)).toBe("SELECT * FROM orders WHERE key = 'k1'")
    await setSql(wrapper, '   ')
    await wrapper.setProps({ topic: 'bad_t81_test' })
    await wrapper.setProps({ topic: 'orders' })
    expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 100')
  })

  // Clear-on-success must be observable (BL-007): after a successful run the
  // topic's draft is gone, so a full A→B→A round-trip returns to the template
  // instead of resurrecting the just-run SQL via the switch-back watch.
  it('shows the template after a successful run round-trips A→B→A', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await wrapper.setProps({ topic: 'bad_t81_test' })
    await wrapper.setProps({ topic: 'orders' })
    expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 100')
  })

  // Running clears the draft, but editing afterwards is a new pending change
  // that must still survive the round-trip.
  it('restores an edited draft after a run when switching back to the topic', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await setSql(wrapper, 'SELECT * FROM orders LIMIT 20')
    await wrapper.setProps({ topic: 'bad_t81_test' })
    await wrapper.setProps({ topic: 'orders' })
    expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 20')
  })

  // Drafts are keyed by connection, so two sql tabs on different connections
  // that share a topic name do not leak each other's draft.
  it('keeps the draft separate for the same topic on a different connection', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, "SELECT * FROM orders WHERE key = 'k1'")
    await wrapper.setProps({ topic: 'bad_t81_test' })
    await wrapper.setProps({ connectionId: 'other-conn', topic: 'orders' })
    expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 100')
  })

  it('runs a query and applies a WHERE key filter', async () => {
    const { wrapper, api } = mountConsole({
      consumeMessages: vi.fn(async () => [msg('k1', 'v1'), msg('k2', 'v2'), msg('k1', 'v3')]),
    })
    await setSql(wrapper, "SELECT * FROM orders WHERE key = 'k1'")
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
    await setSql(wrapper, "SELECT * FROM orders WHERE value LIKE '%ell%' LIMIT 1")
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    const rows = wrapper.findAll('[data-test="sql-row"]')
    expect(rows).toHaveLength(1)
    expect(rows[0].text()).toContain('hello')
  })

  it('shows an error for invalid SQL', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, 'INSERT INTO t VALUES (1)')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="sql-error"]').exists()).toBe(true)
  })


  it('surfaces backend errors', async () => {
    const { wrapper, api } = mountConsole({
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
    await setSql(wrapper, 'SELECT * FROM orders')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    const toggle = wrapper.find('[data-test="export-toggle"]')
    expect(toggle.attributes('disabled')).toBeUndefined()
    await toggle.trigger('click')
    await wrapper.find('[data-test="export-csv"]').trigger('click')
    expect(vi.mocked(saveFile)).toHaveBeenCalledWith(
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
    await setSql(wrapper, 'SELECT * FROM orders')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="export-toggle"]').trigger('click')
    await wrapper.find('[data-test="export-jsonl"]').trigger('click')
    expect(vi.mocked(saveFile)).toHaveBeenCalledWith(
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
    await setSql(wrapper, 'INSERT INTO t VALUES (1)')
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
    await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await setSql(wrapper, 'SELECT * FROM orders LIMIT 20')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await flushPromises()
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    const items = wrapper.findAll('[data-test="history-item"]')
    expect(items).toHaveLength(2)
    await items[1].trigger('click')
    await flushPromises()
    expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 10')
    expect(api.consumeMessages).toHaveBeenCalledTimes(3)
    expect(api.consumeMessages).toHaveBeenLastCalledWith(expect.objectContaining({ limit: 10 }))
  })

  it('saves the current sql as a named favorite via the inline form', async () => {
    const { wrapper } = mountConsole()
    await setSql(wrapper, "SELECT * FROM orders WHERE key = 'x'")
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
    await setSql(wrapper, '   ')
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="fav-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="fav-name-input"]').exists()).toBe(false)
  })

  it('clears the favorite form when the menu closes before saving', async () => {
    const { wrapper } = mountConsole()
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    await wrapper.find('[data-test="fav-save"]').trigger('click')
    await wrapper.find('[data-test="fav-name-input"]').setValue('half-typed')
    // Cancelling = closing the dropdown; the inline form is dismissed with it.
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    // Reopening the menu and the form must not resurrect the stale draft name.
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    await wrapper.find('[data-test="fav-save"]').trigger('click')
    expect((wrapper.find('[data-test="fav-name-input"]').element as HTMLInputElement).value).toBe('')
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

  // --- ⌘Enter shortcut (4.3) -------------------------------------------------

  it('runs the query on cmd+enter in the editor', async () => {
    const { wrapper, api } = mountConsole({
      consumeMessages: vi.fn(async () => [msg('k1', 'v1')]),
    })
    await cmContent(wrapper).trigger('keydown', { key: 'Enter', metaKey: true })
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenCalledWith(expect.objectContaining({ topic: 'orders' }))
    expect(wrapper.findAll('[data-test="sql-row"]')).toHaveLength(1)
  })

  it('runs the query on ctrl+enter as the non-mac fallback', async () => {
    const { wrapper, api } = mountConsole()
    await cmContent(wrapper).trigger('keydown', { key: 'Enter', ctrlKey: true })
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenCalledWith(expect.objectContaining({ topic: 'orders' }))
  })

  it('does not run on a plain enter', async () => {
    const { wrapper, api } = mountConsole()
    await cmContent(wrapper).trigger('keydown', { key: 'Enter' })
    await flushPromises()
    expect(api.consumeMessages).not.toHaveBeenCalled()
  })

  it('does not run while an IME composition is in progress', async () => {
    const { wrapper, api } = mountConsole()
    await cmContent(wrapper).trigger('keydown', {
      key: 'Enter',
      metaKey: true,
      isComposing: true,
    })
    await flushPromises()
    expect(api.consumeMessages).not.toHaveBeenCalled()
  })

  it('does not run while the legacy IME keyCode 229 is set', async () => {
    const { wrapper, api } = mountConsole()
    await cmContent(wrapper).trigger('keydown', {
      key: 'Enter',
      metaKey: true,
      keyCode: 229,
    })
    await flushPromises()
    expect(api.consumeMessages).not.toHaveBeenCalled()
  })

  it('ignores cmd+enter while a query is already running', async () => {
    let resolve!: (rows: Message[]) => void
    const { wrapper, api } = mountConsole({
      consumeMessages: vi.fn(() => new Promise<Message[]>((r) => { resolve = r })),
    })
    // 第一次 ⌘Enter 开始执行，promise 未决 → running 为 true。
    await cmContent(wrapper).trigger('keydown', { key: 'Enter', metaKey: true })
    // 运行中再按 ⌘Enter 不应重复 fetch / 重复记历史。
    await cmContent(wrapper).trigger('keydown', { key: 'Enter', metaKey: true })
    expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    expect(useSqlHistoryStore().history).toEqual(['SELECT * FROM orders LIMIT 100'])
    // 运行结束后 ⌘Enter 恢复可用。
    resolve([msg('k1', 'v1')])
    await flushPromises()
    await cmContent(wrapper).trigger('keydown', { key: 'Enter', metaKey: true })
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenCalledTimes(2)
  })

  // History/favorites application goes through applyQuery; like the ⌘Enter
  // guard it must not start a second fetch while a query is in flight.
  it('ignores a history item click while a query is already running', async () => {
    let resolve!: (rows: Message[]) => void
    const { wrapper, api } = mountConsole({
      consumeMessages: vi.fn(() => new Promise<Message[]>((r) => { resolve = r })),
    })
    await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    await wrapper.findAll('[data-test="history-item"]')[0].trigger('click')
    expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    // 运行结束后再点历史项 → 正常触发。
    resolve([msg('k1', 'v1')])
    await flushPromises()
    await wrapper.findAll('[data-test="history-item"]')[0].trigger('click')
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenCalledTimes(2)
  })

  it('ignores a favorite item click while a query is already running', async () => {
    let resolve!: (rows: Message[]) => void
    const { wrapper, api } = mountConsole({
      consumeMessages: vi.fn(() => new Promise<Message[]>((r) => { resolve = r })),
    })
    useSqlHistoryStore().saveFavorite('fav1', 'SELECT * FROM orders LIMIT 5')
    await wrapper.find('[data-test="btn-run"]').trigger('click')
    await wrapper.find('[data-test="history-toggle"]').trigger('click')
    await wrapper.find('[data-test="fav-item"]').trigger('click')
    expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 100')
    resolve([msg('k1', 'v1')])
    await flushPromises()
    await wrapper.find('[data-test="fav-item"]').trigger('click')
    await flushPromises()
    expect(api.consumeMessages).toHaveBeenCalledTimes(2)
  })

  // --- 查询文件(全局右栏契约) ------------------------------------------------
  // 保存/载入/删除由共享 composable 驱动(不 mock 本体),文件列表展示在全局
  // 右栏(Layout 层),本组件经 defineExpose 暴露能力、并承载确认弹窗与脏检查。
  // 后端走 App.ListQueryFiles/ReadQueryFile/WriteQueryFile/DeleteQueryFile
  // (vi.mock 替换 wailsjs 模块);目录来自 getQueryDir()。
  const fileDir = '~/.db-client/queries'

  // 组件暴露给全局右栏的查询文件能力。
  interface ExposedQueryFileApi {
    requestSave(): void
    requestSaveAs(): void
    loadQueryFile(name: string): void
    askRemoveCurrentFile(): void
    currentFile(): string | null
  }
  function exposedApi(wrapper: VueWrapper): ExposedQueryFileApi {
    return wrapper.vm as unknown as ExposedQueryFileApi
  }

  // 把模块内的四方法替换为可控 mock(vi.mock 提升到顶部,此处仅重配置实现)。
  // ListQueryFiles 返回裸数组、条目名带 .sql 后缀(与后端绑定一致);
  // ReadQueryFile 按名返回文件内容,供「载入回填」断言。
  function mockFileBackend(
    files: Array<{ name: string; connection_id: string; content?: string }>,
    opts: { failList?: boolean } = {},
  ): void {
    queryFileMocks.ListQueryFiles.mockImplementation(async () => {
      if (opts.failList) {
        throw new Error('查询目录不可用')
      }
      return files.map((f) => ({
        name: f.name,
        connection_id: f.connection_id,
        size_bytes: 10,
        mod_time_ms: 1700000000000,
      }))
    })
    queryFileMocks.ReadQueryFile.mockImplementation(async (req: { name: string }) => {
      const f = files.find((x) => x.name === req.name)
      return { content: f?.content ?? '', connection_id: f?.connection_id ?? '' }
    })
  }

  const file = (name: string, connection_id: string, content = '') => ({ name, connection_id, content })

  describe('查询文件(全局右栏契约)', () => {
    beforeEach(() => {
      // composable 的文件列表是模块级共享状态,测试间清空避免串扰
      // (探针实例只用于重置/填充共享列表,不 mock 本体)。
      useQueryFiles({ connectionId: () => 'c' }).files.value = []
    })

    afterEach(() => {
      document.body.innerHTML = ''
    })

    it('Cmd+S 未关联文件 → 弹「保存查询」名称输入,取消则不写入', async () => {
      mockFileBackend([])
      const { wrapper } = mountConsole()
      await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
      await cmContent(wrapper).trigger('keydown', { key: 's', metaKey: true })
      expect(promptEl('prompt-dialog')).not.toBeNull()
      expect(promptEl('prompt-title')?.textContent).toBe('保存查询')
      expect(queryFileMocks.WriteQueryFile).not.toHaveBeenCalled()
      ;(promptEl('prompt-cancel') as HTMLElement).click()
      await flushPromises()
      expect(promptEl('prompt-dialog')).toBeNull()
      expect(queryFileMocks.WriteQueryFile).not.toHaveBeenCalled()
    })

    it('IME 组合中的 Cmd+S 不触发保存', async () => {
      const { wrapper } = mountConsole()
      await cmContent(wrapper).trigger('keydown', { key: 's', metaKey: true, isComposing: true })
      expect(promptEl('prompt-dialog')).toBeNull()
      expect(queryFileMocks.WriteQueryFile).not.toHaveBeenCalled()
    })

    it('Ctrl+S 已关联文件 → 直接覆盖写同名文件,不弹任何输入', async () => {
      mockFileBackend([file('近一小时错误.sql', 'c', 'SELECT * FROM errors LIMIT 10')])
      const { wrapper } = mountConsole()
      const vm = exposedApi(wrapper)
      // 未关联文件时空编辑器不脏 → 经右栏入口免确认载入。
      await setSql(wrapper, '')
      vm.loadQueryFile('近一小时错误.sql')
      await flushPromises()
      expect(vm.currentFile()).toBe('近一小时错误.sql')
      await setSql(wrapper, 'SELECT * FROM errors LIMIT 5')
      await cmContent(wrapper).trigger('keydown', { key: 's', ctrlKey: true })
      await flushPromises()
      expect(queryFileMocks.WriteQueryFile).toHaveBeenCalledWith(
        expect.objectContaining({ name: '近一小时错误.sql', content: 'SELECT * FROM errors LIMIT 5' }),
      )
      expect(promptEl('prompt-dialog')).toBeNull()
    })

    it('requestSave 命中重名 → 覆盖确认弹窗,确认后才写入', async () => {
      mockFileBackend([file('已存在.sql', 'c', '旧内容')])
      // 重名判断基于 composable 的共享列表,先用探针拉取刷新。
      await useQueryFiles({ connectionId: () => 'c' }).refreshFiles()
      const { wrapper } = mountConsole()
      await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
      exposedApi(wrapper).requestSave()
      await nextTick()
      expect(promptEl('prompt-dialog')).not.toBeNull()
      await confirmPrompt('已存在')
      // 重名 → 覆盖确认弹窗,此时尚未写入。
      expect(queryFileMocks.WriteQueryFile).not.toHaveBeenCalled()
      const dialog = promptEl('confirm-dialog')
      expect(dialog).not.toBeNull()
      expect(dialog?.textContent).toContain('文件已存在')
      ;(promptEl('confirm-dialog-ok') as HTMLElement).click()
      await flushPromises()
      expect(queryFileMocks.WriteQueryFile).toHaveBeenCalledWith({
        dir: fileDir,
        name: '已存在.sql',
        content: 'SELECT * FROM orders LIMIT 10',
        connection_id: 'c',
      })
      expect(exposedApi(wrapper).currentFile()).toBe('已存在.sql')
    })

    it('requestSave 输入新名 → 直接写入并记录为当前文件', async () => {
      mockFileBackend([])
      const { wrapper } = mountConsole()
      await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
      exposedApi(wrapper).requestSave()
      await nextTick()
      await confirmPrompt('新查询')
      expect(queryFileMocks.WriteQueryFile).toHaveBeenCalledWith({
        dir: fileDir,
        name: '新查询.sql',
        content: 'SELECT * FROM orders LIMIT 10',
        connection_id: 'c',
      })
      expect(promptEl('confirm-dialog')).toBeNull()
      expect(exposedApi(wrapper).currentFile()).toBe('新查询.sql')
    })

    it('requestSaveAs → 弹「另存查询」名称输入,取消不写入', async () => {
      mockFileBackend([])
      const { wrapper } = mountConsole()
      exposedApi(wrapper).requestSaveAs()
      await nextTick()
      expect(promptEl('prompt-title')?.textContent).toBe('另存查询')
      ;(promptEl('prompt-cancel') as HTMLElement).click()
      await flushPromises()
      expect(queryFileMocks.WriteQueryFile).not.toHaveBeenCalled()
    })

    it('loadQueryFile 编辑器无未保存内容 → 直接读取回填并记住当前文件', async () => {
      mockFileBackend([file('订单采样.sql', 'c', 'SELECT * FROM orders LIMIT 50')])
      const { wrapper, api } = mountConsole()
      const vm = exposedApi(wrapper)
      expect(vm.currentFile()).toBeNull()
      await setSql(wrapper, '')
      vm.loadQueryFile('订单采样.sql')
      await flushPromises()
      expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 50')
      expect(vm.currentFile()).toBe('订单采样.sql')
      expect(promptEl('confirm-dialog')).toBeNull()
      // 载入只回填不执行。
      expect(api.consumeMessages).not.toHaveBeenCalled()
    })

    it('loadQueryFile 有未保存内容 → 先弹确认,确认后才读取回填', async () => {
      mockFileBackend([
        file('近一小时错误.sql', 'c', 'SELECT * FROM errors LIMIT 10'),
        file('订单采样.sql', 'c', 'SELECT * FROM orders LIMIT 50'),
      ])
      const { wrapper } = mountConsole()
      const vm = exposedApi(wrapper)
      await setSql(wrapper, '')
      vm.loadQueryFile('近一小时错误.sql')
      await flushPromises()
      expect(editorSql(wrapper)).toBe('SELECT * FROM errors LIMIT 10')
      // 编辑产生未保存改动 → 再载入其他文件先弹确认,不立即读文件。
      await setSql(wrapper, 'SELECT * FROM errors LIMIT 999')
      vm.loadQueryFile('订单采样.sql')
      await nextTick()
      const dialog = promptEl('confirm-dialog')
      expect(dialog).not.toBeNull()
      expect(dialog?.textContent).toContain('当前 SQL 未保存')
      expect(queryFileMocks.ReadQueryFile).toHaveBeenCalledTimes(1)
      ;(promptEl('confirm-dialog-ok') as HTMLElement).click()
      await flushPromises()
      expect(queryFileMocks.ReadQueryFile).toHaveBeenCalledTimes(2)
      expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 50')
    })

    it('覆盖保存后基线同步:再载入其他文件不再弹未保存确认', async () => {
      mockFileBackend([
        file('近一小时错误.sql', 'c', 'SELECT * FROM errors LIMIT 10'),
        file('订单采样.sql', 'c', 'SELECT * FROM orders LIMIT 50'),
      ])
      const { wrapper } = mountConsole()
      const vm = exposedApi(wrapper)
      await setSql(wrapper, '')
      vm.loadQueryFile('近一小时错误.sql')
      await flushPromises()
      await setSql(wrapper, 'SELECT * FROM errors LIMIT 20')
      // ⌘S 覆盖保存 → 编辑器内容成为已保存基线。
      await cmContent(wrapper).trigger('keydown', { key: 's', metaKey: true })
      await flushPromises()
      expect(queryFileMocks.WriteQueryFile).toHaveBeenCalledTimes(1)
      // 基线已同步 → 载入另一文件不弹确认、直接读取。
      vm.loadQueryFile('订单采样.sql')
      await nextTick()
      expect(promptEl('confirm-dialog')).toBeNull()
      expect(queryFileMocks.ReadQueryFile).toHaveBeenCalledTimes(2)
      await flushPromises()
      expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 50')
    })

    it('askRemoveCurrentFile → 删除确认 → DeleteQueryFile 并清空编辑器', async () => {
      mockFileBackend([file('近一小时错误.sql', 'c', 'SELECT * FROM errors LIMIT 10')])
      const { wrapper } = mountConsole()
      const vm = exposedApi(wrapper)
      await setSql(wrapper, '')
      vm.loadQueryFile('近一小时错误.sql')
      await flushPromises()
      vm.askRemoveCurrentFile()
      await nextTick()
      expect(promptEl('confirm-dialog')).not.toBeNull()
      ;(promptEl('confirm-dialog-ok') as HTMLElement).click()
      await flushPromises()
      expect(queryFileMocks.DeleteQueryFile).toHaveBeenCalledWith({ dir: fileDir, name: '近一小时错误.sql' })
      expect(editorSql(wrapper)).toBe('')
      expect(vm.currentFile()).toBeNull()
    })
  })

  // --- tab 标题跟随当前打开的 SQL 文件 ----------------------------------------
  // 控制台把 tabs store 中自己的 tab 重命名为当前关联文件名;未关联时保持
  // 默认标题(有 topic 为「SQL · <topic>」,否则「SQL 查询」)。
  describe('tab 标题跟随当前 SQL 文件', () => {
    function mountWithTitleTab() {
      setActivePinia(createPinia())
      setApi(fakeApi())
      // 预置 id 为 'tab1' 的 tab(mountConsole 默认 tabId),标题为默认值。
      const tabsStore = useTabsStore()
      tabsStore.openTabs.push({
        id: 'tab1', kind: 'sql', title: 'SQL · orders', connectionId: 'c', topic: 'orders', partitions: [0, 1],
      })
      const wrapper = mount(SqlConsole, {
        props: { tabId: 'tab1', connectionId: 'c', topic: 'orders', partitions: [0, 1] },
      })
      return { wrapper, tabsStore }
    }

    afterEach(() => {
      document.body.innerHTML = ''
    })

    it('载入文件后 tab 标题变为文件名', async () => {
      mockFileBackend([file('某文件.sql', 'c', 'SELECT * FROM orders LIMIT 50')])
      const { wrapper, tabsStore } = mountWithTitleTab()
      expect(tabsStore.openTabs[0].title).toBe('SQL · orders')
      // 有 topic 的控制台带模板,先清空避免载入确认。
      await setSql(wrapper, '')
      exposedApi(wrapper).loadQueryFile('某文件.sql')
      await flushPromises()
      expect(tabsStore.openTabs[0].title).toBe('某文件.sql')
      wrapper.unmount()
    })

    it('删除当前文件后回退默认标题', async () => {
      mockFileBackend([file('某文件.sql', 'c', 'SELECT * FROM orders LIMIT 50')])
      const { wrapper, tabsStore } = mountWithTitleTab()
      await setSql(wrapper, '')
      exposedApi(wrapper).loadQueryFile('某文件.sql')
      await flushPromises()
      exposedApi(wrapper).askRemoveCurrentFile()
      await nextTick()
      expect(promptEl('confirm-dialog')).not.toBeNull()
      ;(promptEl('confirm-dialog-ok') as HTMLElement).click()
      await flushPromises()
      expect(exposedApi(wrapper).currentFile()).toBeNull()
      expect(tabsStore.openTabs[0].title).toBe('SQL · orders')
      wrapper.unmount()
    })

    it('保存为新文件后 tab 标题变为新文件名', async () => {
      mockFileBackend([])
      const { wrapper, tabsStore } = mountWithTitleTab()
      await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
      exposedApi(wrapper).requestSave()
      await nextTick()
      await confirmPrompt('新查询')
      await flushPromises()
      expect(tabsStore.openTabs[0].title).toBe('新查询.sql')
      wrapper.unmount()
    })

    it('无 topic 的 tab 未关联文件时默认标题为「SQL 查询」', async () => {
      setActivePinia(createPinia())
      setApi(fakeApi())
      const tabsStore = useTabsStore()
      tabsStore.openTabs.push({ id: 'tab2', kind: 'sql', title: 'SQL 查询', connectionId: 'c', partitions: [] })
      const wrapper = mount(SqlConsole, {
        props: { tabId: 'tab2', connectionId: 'c', topic: '', partitions: [] },
      })
      mockFileBackend([file('某文件.sql', 'c', 'SELECT 1')])
      exposedApi(wrapper).loadQueryFile('某文件.sql')
      await flushPromises()
      expect(tabsStore.openTabs[0].title).toBe('某文件.sql')
      wrapper.unmount()
    })
  })

  // --- 无 topic 的 tab(顶栏「新建查询」打开) ---------------------------------
  describe('无 topic', () => {
    it('以空编辑器打开并给出 FROM 子句 placeholder', () => {
      const { wrapper } = mountConsole({}, { topic: '' })
      expect(editorSql(wrapper)).toBe('')
      expect(wrapper.findComponent(SqlEditor).props('placeholder')).toBe('输入 SQL,表名写在 FROM 子句')
    })

    it('切回有 topic 的 tab → 回填模板且 placeholder 消失', async () => {
      const { wrapper } = mountConsole({}, { topic: '' })
      await wrapper.setProps({ topic: 'orders' })
      expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 100')
      expect(wrapper.findComponent(SqlEditor).props('placeholder')).toBeUndefined()
    })

    it('SQL 无表名且无 topic → 提示写 FROM 子句,不执行也不记历史', async () => {
      const { wrapper, api } = mountConsole({}, { topic: '' })
      // 当前 parseSelect 不接受无 FROM 的查询;此处桩掉解析结果,
      // 专测控制台对「解析成功但无表名」的守卫(解析演进为可省略 FROM 后同样可达)。
      vi.mocked(parseSelect).mockImplementationOnce(() => ({ topic: null, where: [], limit: null, error: null }))
      await setSql(wrapper, 'SELECT 1')
      await wrapper.find('[data-test="btn-run"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="sql-error"]').text()).toContain('SQL 中未找到表名')
      expect(api.consumeMessages).not.toHaveBeenCalled()
      expect(useSqlHistoryStore().history).toEqual([])
    })
  })
})
