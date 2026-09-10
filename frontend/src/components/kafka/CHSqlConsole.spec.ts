import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type {
  CHStatementResult,
  SaveSavedQueryRequest,
  SavedQuery,
  UpdateSavedQueryRequest,
} from '@/api/types'
import { CSV_MIME, JSONL_MIME, saveFile } from '@/utils/export'
import SqlEditor from '@/components/common/SqlEditor.vue'
import CHSqlConsole from './CHSqlConsole.vue'

// Stub the save trigger but keep the real CSV/JSONL builders, so assertions
// check exactly what the component passes to saveFile.
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
    redisHashSetField: vi.fn(async () => {}),
    redisHashDeleteField: vi.fn(async () => {}),
    redisListSetIndex: vi.fn(async () => {}),
    redisListPush: vi.fn(async () => {}),
    redisListDeleteIndex: vi.fn(async () => {}),
    redisSetAdd: vi.fn(async () => {}),
    redisSetRemove: vi.fn(async () => {}),
    redisZSetAdd: vi.fn(async () => {}),
    redisZSetRemove: vi.fn(async () => {}),
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

const twoStatements = (): CHStatementResult[] => [
  { sql: 'SELECT 1', duration_ms: 12, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1'], [null]] },
  { sql: 'SELECT bad', duration_ms: 3, error: 'Syntax error (multi-statements not allowed)' },
]

const savedQueries = (): SavedQuery[] => [
  {
    id: 'q1',
    name: '每日报表',
    console_type: 'ch-sql',
    connection_id: 'ch1',
    content: 'SELECT date, count() AS c FROM events GROUP BY date',
    created_at: 1700000000000,
    updated_at: 1725840000000,
  },
  {
    id: 'q2',
    name: '失败重试扫描',
    console_type: 'ch-sql',
    connection_id: 'ch1',
    content: 'SELECT * FROM retries WHERE status = 0',
    created_at: 1700000000000,
    updated_at: 1725840100000,
  },
]

// SqlEditor 内部由 CM6 创建自己的 .cm-editor,借 findFromDOM 拿到 view 实例
// (与 SqlEditor.spec.ts 同一套方法)。
function cmInput(wrapper: VueWrapper): EditorView {
  const host = wrapper.find('[data-test="ch-sql-input"] .cm-editor').element as HTMLElement
  const view = EditorView.findFromDOM(host)
  expect(view, 'EditorView.findFromDOM 应能取到实例').not.toBeNull()
  return view as EditorView
}

// typeSql 用 CM dispatch 模拟输入,走 update:modelValue → v-model 回写。
async function typeSql(wrapper: VueWrapper, text: string): Promise<void> {
  const view = cmInput(wrapper)
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
  await nextTick()
}

// PromptDialog / ConfirmDialog teleport 到 body。
function bodyEl(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}

// 展开「查询库」面板并等首条查询渲染(列表为异步拉取)。
async function openQueryLib(wrapper: VueWrapper): Promise<void> {
  await wrapper.find('[data-test="btn-ch-query-lib-toggle"]').trigger('click')
  await vi.waitFor(() => {
    expect(wrapper.find('[data-test="ch-query-item-0"]').exists()).toBe(true)
  })
}

// 在 teleport 弹窗的输入框中输入并确认;等确认按钮从 disabled 变为可用
// (jsdom 会抑制 disabled 按钮上的 click,直接点会被静默吞掉)。
async function confirmPrompt(value: string): Promise<void> {
  const input = bodyEl('prompt-input') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => {
    expect((bodyEl('prompt-confirm') as HTMLButtonElement).disabled).toBe(false)
  })
  ;(bodyEl('prompt-confirm') as HTMLElement).click()
}

describe('CHSqlConsole', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
    vi.mocked(saveFile).mockClear()
    document.body.innerHTML = ''
  })

  it('runs SQL typed into the CodeMirror editor and renders one card per statement with rows or error text', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="ch-stmt-card"]')).toHaveLength(2)
    })
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1; SELECT bad' })
    const cards = wrapper.findAll('[data-test="ch-stmt-card"]')
    // 第一条:SQL、耗时、结果网格(NULL 单元格)。
    expect(cards[0].find('[data-test="ch-stmt-sql"]').text()).toBe('SELECT 1')
    expect(cards[0].find('[data-test="ch-stmt-ms"]').text()).toContain('12')
    expect(cards[0].find('[data-test="ch-stmt-error"]').exists()).toBe(false)
    expect(cards[0].findAll('[data-test="ch-stmt-row"]')).toHaveLength(2)
    expect(cards[0].findAll('[data-test="ch-stmt-row"]')[1].findAll('td')[0].text()).toBe('NULL')
    // 第二条:错误文本。
    expect(cards[1].find('[data-test="ch-stmt-sql"]').text()).toBe('SELECT bad')
    expect(cards[1].find('[data-test="ch-stmt-error"]').text()).toBe('Syntax error (multi-statements not allowed)')
    // 错误语句没有结果网格。
    expect(cards[1].find('[data-test="ch-stmt-grid"]').exists()).toBe(false)
  })

  it('exports a statement result via saveFile as CSV and JSONL named ch-result-<i>', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="ch-stmt-card"]')).toHaveLength(2)
    })
    const cards = wrapper.findAll('[data-test="ch-stmt-card"]')
    await cards[0].find('[data-test="btn-ch-export-csv"]').trigger('click')
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(1)
    expect(vi.mocked(saveFile)).toHaveBeenNthCalledWith(1, 'ch-result-0', expect.stringContaining('one'), CSV_MIME)
    await cards[0].find('[data-test="btn-ch-export-jsonl"]').trigger('click')
    expect(vi.mocked(saveFile)).toHaveBeenCalledTimes(2)
    expect(vi.mocked(saveFile)).toHaveBeenNthCalledWith(2, 'ch-result-0', expect.any(String), JSONL_MIME)
    // 错误语句没有导出入口。
    expect(cards[1].find('[data-test="btn-ch-export-csv"]').exists()).toBe(false)
  })

  it('runs on Cmd/Ctrl+Enter pressed inside the CodeMirror editor', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(
      [{ sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] }],
    )
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1')
    // SqlEditor 自身不处理该组合键,事件从 CM contentDOM 冒泡到外层容器。
    cmInput(wrapper).contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    )
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="ch-stmt-card"]')).toHaveLength(1)
    })
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1' })
  })

  it('loads CH tables on mount and passes them to SqlEditor for completion', async () => {
    ;(api.listCHTables as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'events', engine: 'MergeTree', total_rows: 3 },
      { name: 'orders', engine: 'MergeTree', total_rows: 5 },
    ])
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    // 未指定 database → 默认 default 库,且不含 system 表。
    await vi.waitFor(() => {
      expect(api.listCHTables).toHaveBeenCalledWith({ connection_id: 'ch1', database: 'default', show_system: false })
    })
    // 表清单映射为 {name}(列可空)传给编辑器。
    await vi.waitFor(() => {
      expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([{ name: 'events' }, { name: 'orders' }])
    })
    wrapper.unmount()
    // 显式 database prop 透传给 listCHTables。
    const wrapper2 = mount(CHSqlConsole, { props: { connectionId: 'ch2', database: 'metrics' } })
    await vi.waitFor(() => {
      expect(api.listCHTables).toHaveBeenLastCalledWith({ connection_id: 'ch2', database: 'metrics', show_system: false })
    })
    wrapper2.unmount()
  })

  it('fetches ch-sql saved queries on mount and toggles the library panel', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue(savedQueries())
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await vi.waitFor(() => {
      expect(api.listSavedQueries).toHaveBeenCalledWith({ console_type: 'ch-sql', connection_id: 'ch1' })
    })
    // 默认收起;点按钮展开后逐条渲染名称与更新时间。
    expect(wrapper.find('[data-test="ch-query-lib"]').exists()).toBe(false)
    await wrapper.find('[data-test="btn-ch-query-lib-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="ch-query-lib"]').exists()).toBe(true)
    const items = wrapper.findAll('[data-test^="ch-query-item-"]')
    expect(items).toHaveLength(2)
    expect(items[0].text()).toContain('每日报表')
    expect(items[0].text()).toContain(new Date(1725840000000).toLocaleString())
    expect(items[1].text()).toContain('失败重试扫描')
    // 再次点击收起。
    await wrapper.find('[data-test="btn-ch-query-lib-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="ch-query-lib"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('disables save/save-as on an empty editor and delete with nothing loaded', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue(savedQueries())
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await openQueryLib(wrapper)
    const disabled = (id: string): boolean =>
      (wrapper.find(`[data-test="${id}"]`).element as HTMLButtonElement).disabled
    expect(disabled('btn-ch-query-lib-save')).toBe(true)
    expect(disabled('btn-ch-query-lib-save-as')).toBe(true)
    expect(disabled('btn-ch-query-lib-delete')).toBe(true)
  })

  it('loads a saved query into the editor when its entry is clicked', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue(savedQueries())
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await openQueryLib(wrapper)
    await wrapper.find('[data-test="ch-query-item-0"]').trigger('click')
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toBe('SELECT date, count() AS c FROM events GROUP BY date')
    })
  })

  it('saves the current SQL as a new query through the prompt dialog with console_type ch-sql', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue(savedQueries())
    ;(api.saveSavedQuery as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: SaveSavedQueryRequest) =>
        ({ id: 'q9', name: req.name, console_type: 'ch-sql', connection_id: 'ch1', content: req.content, created_at: 1, updated_at: 2 }) as SavedQuery,
    )
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    // 保存/另存为/删除按钮位于查询库面板内,先展开。
    await wrapper.find('[data-test="btn-ch-query-lib-toggle"]').trigger('click')
    await typeSql(wrapper, 'SELECT 42')
    await wrapper.find('[data-test="btn-ch-query-lib-save"]').trigger('click')
    // 未载入任何查询 → 弹名称输入框。
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    await confirmPrompt('我的查询')
    await vi.waitFor(() => {
      expect(api.saveSavedQuery).toHaveBeenCalledWith({
        name: '我的查询',
        console_type: 'ch-sql',
        connection_id: 'ch1',
        content: 'SELECT 42',
      })
    })
    expect(api.updateSavedQuery).not.toHaveBeenCalled()
    // 保存成功后弹窗关闭。
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).toBeNull()
    })
    wrapper.unmount()
  })

  it('updates the loaded query in place when saving with a loaded entry', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue(savedQueries())
    ;(api.updateSavedQuery as ReturnType<typeof vi.fn>).mockImplementation(
      async (req: UpdateSavedQueryRequest) =>
        ({ id: req.id, name: req.name, console_type: 'ch-sql', connection_id: 'ch1', content: req.content, created_at: 1, updated_at: 3 }) as SavedQuery,
    )
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await openQueryLib(wrapper)
    await wrapper.find('[data-test="ch-query-item-0"]').trigger('click')
    await typeSql(wrapper, 'SELECT 99')
    await wrapper.find('[data-test="btn-ch-query-lib-save"]').trigger('click')
    // 已载入 → 不弹窗,直接原地更新。
    expect(bodyEl('prompt-dialog')).toBeNull()
    await vi.waitFor(() => {
      expect(api.updateSavedQuery).toHaveBeenCalledWith({
        id: 'q1',
        name: '每日报表',
        content: 'SELECT 99',
      })
    })
    expect(api.saveSavedQuery).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('save-as always prompts and creates a new query without touching the loaded one', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue(savedQueries())
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await openQueryLib(wrapper)
    await wrapper.find('[data-test="ch-query-item-0"]').trigger('click')
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toContain('events')
    })
    await wrapper.find('[data-test="btn-ch-query-lib-save-as"]').trigger('click')
    // 弹窗预填当前载入的名称。
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    expect((bodyEl('prompt-input') as HTMLInputElement).value).toBe('每日报表')
    await confirmPrompt('每日报表-副本')
    await vi.waitFor(() => {
      expect(api.saveSavedQuery).toHaveBeenCalledWith({
        name: '每日报表-副本',
        console_type: 'ch-sql',
        connection_id: 'ch1',
        content: 'SELECT date, count() AS c FROM events GROUP BY date',
      })
    })
    expect(api.updateSavedQuery).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('deletes the loaded query after confirmation and clears the loaded state', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue(savedQueries())
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await openQueryLib(wrapper)
    await wrapper.find('[data-test="ch-query-item-0"]').trigger('click')
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toContain('events')
    })
    await wrapper.find('[data-test="btn-ch-query-lib-delete"]').trigger('click')
    expect(bodyEl('confirm-dialog')).not.toBeNull()
    const msg = bodyEl('confirm-dialog-message')?.textContent ?? ''
    expect(msg).toContain('每日报表')
    ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(api.deleteSavedQuery).toHaveBeenCalledWith({ id: 'q1' })
      expect(bodyEl('confirm-dialog')).toBeNull()
    })
    // 载入状态已清空(删除后的列表刷新已完成,saving 复位,按钮恢复可用):
    // 再次「保存」回到新建弹窗而不是原地更新。
    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="btn-ch-query-lib-save"]').element as HTMLButtonElement).disabled).toBe(false)
    })
    await wrapper.find('[data-test="btn-ch-query-lib-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    expect(api.updateSavedQuery).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows an error when the query library fails to load', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('查询库加载失败'))
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await wrapper.find('[data-test="btn-ch-query-lib-toggle"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-query-lib-error"]').text()).toBe('查询库加载失败')
    })
    wrapper.unmount()
  })

  it('surfaces save errors in the library panel', async () => {
    ;(api.listSavedQueries as ReturnType<typeof vi.fn>).mockResolvedValue([])
    ;(api.saveSavedQuery as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('保存失败'))
    const wrapper = mount(CHSqlConsole, { props: { connectionId: 'ch1' } })
    await wrapper.find('[data-test="btn-ch-query-lib-toggle"]').trigger('click')
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-ch-query-lib-save"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    await confirmPrompt('会失败的查询')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-query-lib-error"]').text()).toBe('保存失败')
    })
    wrapper.unmount()
  })
})
