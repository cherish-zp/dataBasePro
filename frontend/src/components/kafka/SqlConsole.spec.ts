import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises, type VueWrapper, type DOMWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Message, SavedQuery } from '@/api/types'
import { useSqlHistoryStore } from '@/store/sqlhistory'
import { CSV_MIME, JSONL_MIME, MESSAGE_EXPORT_COLUMNS, exportCsv, exportJsonl, saveFile } from '@/utils/export'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlConsole from './SqlConsole.vue'

// Stub the DOM download trigger but keep the real CSV/JSONL builders, so the
// assertions check exactly what the component passes to saveFile.
vi.mock('@/utils/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/export')>()
  return { ...actual, downloadFile: vi.fn(), saveFile: vi.fn(async () => {}) }
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

// 查询库条目样例(镜像 model.SavedQuery)。
const saved = (id: string, name: string, content: string): SavedQuery => ({
  id,
  name,
  console_type: 'kafka-sql',
  connection_id: 'c',
  content,
  created_at: 1700000000000,
  updated_at: 1700000100000,
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

// ⌘Enter/IME 用例从 CM 的 contentDOM 触发(冒泡到控制台的 keydown 监听,与真实路径一致)。
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

  // --- 查询库(保存的查询,按连接隔离) ----------------------------------------

  describe('查询库', () => {
    // PromptDialog Teleport 到 body;每个用例后清掉残留,避免串扰后续断言。
    afterEach(() => {
      document.body.innerHTML = ''
    })

    it('默认折叠,点击切换按钮打开面板并拉取当前连接的查询列表', async () => {
      const { wrapper, api } = mountConsole({
        listSavedQueries: vi.fn(async () => [saved('q1', '近一小时错误', 'SELECT * FROM errors')]),
      })
      expect(wrapper.find('[data-test="query-lib"]').exists()).toBe(false)
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      expect(api.listSavedQueries).toHaveBeenCalledWith({ console_type: 'kafka-sql', connection_id: 'c' })
      const panel = wrapper.find('[data-test="query-lib"]')
      expect(panel.exists()).toBe(true)
      expect(panel.text()).toContain('查询库')
      expect(panel.text()).toContain('保存的查询按连接隔离')
      const items = wrapper.findAll('[data-test^="query-item-"]')
      expect(items).toHaveLength(1)
      expect(items[0].text()).toContain('近一小时错误')
      expect(items[0].text()).toContain(new Date(1700000100000).toLocaleString())
      // 再次点击 → 折叠。
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      expect(wrapper.find('[data-test="query-lib"]').exists()).toBe(false)
    })

    it('新 SQL → 保存 → 弹名称输入 → 确认 → saveSavedQuery payload 正确并刷新列表', async () => {
      let calls = 0
      const { wrapper, api } = mountConsole({
        listSavedQueries: vi.fn(async () => (calls++ > 0 ? [saved('q1', '我的查询', 'SELECT * FROM orders LIMIT 10')] : [])),
        saveSavedQuery: vi.fn(async (q: { name: string; content: string }) => saved('q1', q.name, q.content)),
      })
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      await setSql(wrapper, 'SELECT * FROM orders LIMIT 10')
      await wrapper.find('[data-test="btn-query-save"]').trigger('click')
      // 弹出名称输入对话框。
      expect(promptEl('prompt-dialog')).not.toBeNull()
      await confirmPrompt('我的查询')
      expect(api.saveSavedQuery).toHaveBeenCalledWith({
        name: '我的查询',
        console_type: 'kafka-sql',
        connection_id: 'c',
        content: 'SELECT * FROM orders LIMIT 10',
      })
      // 保存后刷新列表 → 第 2 次 listSavedQueries,新条目出现且被标记为已载入。
      expect(api.listSavedQueries).toHaveBeenCalledTimes(2)
      expect(wrapper.findAll('[data-test^="query-item-"]')).toHaveLength(1)
      expect(wrapper.find('[data-test="btn-query-delete"]').attributes('disabled')).toBeUndefined()
    })

    it('已载入条目 → 保存直接 updateSavedQuery(带 id)并刷新列表', async () => {
      const { wrapper, api } = mountConsole({
        listSavedQueries: vi.fn(async () => [saved('q1', '近一小时错误', 'SELECT * FROM errors')]),
      })
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      await wrapper.findAll('[data-test^="query-item-"]')[0].trigger('click')
      await setSql(wrapper, 'SELECT * FROM errors LIMIT 5')
      await wrapper.find('[data-test="btn-query-save"]').trigger('click')
      await flushPromises()
      expect(api.updateSavedQuery).toHaveBeenCalledWith({
        id: 'q1',
        name: '近一小时错误',
        content: 'SELECT * FROM errors LIMIT 5',
      })
      expect(api.saveSavedQuery).not.toHaveBeenCalled()
      // 直接更新不弹名称输入。
      expect(promptEl('prompt-dialog')).toBeNull()
      expect(api.listSavedQueries).toHaveBeenCalledTimes(2)
    })

    it('另存为强制弹出名称输入并新建条目', async () => {
      const { wrapper, api } = mountConsole({
        listSavedQueries: vi.fn(async () => [saved('q1', '近一小时错误', 'SELECT * FROM errors')]),
        saveSavedQuery: vi.fn(async (q: { name: string; content: string }) => saved('q2', q.name, q.content)),
      })
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      await wrapper.findAll('[data-test^="query-item-"]')[0].trigger('click')
      await setSql(wrapper, 'SELECT * FROM errors LIMIT 5')
      await wrapper.find('[data-test="btn-query-save-as"]').trigger('click')
      expect(promptEl('prompt-dialog')).not.toBeNull()
      await confirmPrompt('精简版')
      expect(api.saveSavedQuery).toHaveBeenCalledWith({
        name: '精简版',
        console_type: 'kafka-sql',
        connection_id: 'c',
        content: 'SELECT * FROM errors LIMIT 5',
      })
      expect(api.updateSavedQuery).not.toHaveBeenCalled()
      expect(api.listSavedQueries).toHaveBeenCalledTimes(2)
    })

    it('单击条目把 SQL 载入编辑器并记住该条目', async () => {
      const { wrapper, api } = mountConsole({
        listSavedQueries: vi.fn(async () => [
          saved('q1', '近一小时错误', 'SELECT * FROM errors'),
          saved('q2', '订单采样', 'SELECT * FROM orders LIMIT 50'),
        ]),
      })
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      // 未载入任何条目 → 删除不可用。
      expect(wrapper.find('[data-test="btn-query-delete"]').attributes('disabled')).toBeDefined()
      await wrapper.findAll('[data-test^="query-item-"]')[1].trigger('click')
      expect(editorSql(wrapper)).toBe('SELECT * FROM orders LIMIT 50')
      expect(wrapper.find('[data-test="btn-query-delete"]').attributes('disabled')).toBeUndefined()
      // 单击条目只载入不执行。
      expect(api.consumeMessages).not.toHaveBeenCalled()
    })

    it('删除已载入条目 → deleteSavedQuery + 列表刷新 + 清空已载入状态', async () => {
      const { wrapper, api } = mountConsole({
        listSavedQueries: vi.fn(async () => [saved('q1', '近一小时错误', 'SELECT * FROM errors')]),
      })
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      await wrapper.findAll('[data-test^="query-item-"]')[0].trigger('click')
      await wrapper.find('[data-test="btn-query-delete"]').trigger('click')
      await flushPromises()
      expect(api.deleteSavedQuery).toHaveBeenCalledWith({ id: 'q1' })
      expect(api.listSavedQueries).toHaveBeenCalledTimes(2)
      expect(wrapper.find('[data-test="btn-query-delete"]').attributes('disabled')).toBeDefined()
    })

    it('listSavedQueries 失败 → 错误显示在面板内', async () => {
      const { wrapper } = mountConsole({
        listSavedQueries: vi.fn(async () => {
          throw new Error('查询库不可用')
        }),
      })
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      expect(wrapper.find('[data-test="query-lib-error"]').text()).toContain('查询库不可用')
    })

    it('切换连接保持编辑器 SQL,仅刷新列表并清空已载入状态', async () => {
      const { wrapper, api } = mountConsole({
        listSavedQueries: vi.fn(async () => [saved('q1', '近一小时错误', 'SELECT * FROM errors')]),
      })
      await wrapper.find('[data-test="btn-query-lib-toggle"]').trigger('click')
      await flushPromises()
      await wrapper.findAll('[data-test^="query-item-"]')[0].trigger('click')
      expect(editorSql(wrapper)).toBe('SELECT * FROM errors')
      await wrapper.setProps({ connectionId: 'other' })
      await flushPromises()
      // SQL 内容保持不动。
      expect(editorSql(wrapper)).toBe('SELECT * FROM errors')
      // 列表按新连接刷新。
      expect(api.listSavedQueries).toHaveBeenLastCalledWith({ console_type: 'kafka-sql', connection_id: 'other' })
      // 已载入状态清空 → 旧连接条目不能再被 update/删除。
      expect(wrapper.find('[data-test="btn-query-delete"]').attributes('disabled')).toBeDefined()
    })
  })
})
