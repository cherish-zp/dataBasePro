import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { CHStatementResult } from '@/api/types'
import { CSV_MIME, JSONL_MIME, saveFile } from '@/utils/export'
import { QUERY_DIR_KEY } from '@/utils/queryDir'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore } from '@/store/tabs'
import SqlEditor from '@/components/common/SqlEditor.vue'
import CHSqlConsole from './CHSqlConsole.vue'

// Stub the save trigger but keep the real CSV/JSONL builders, so assertions
// check exactly what the component passes to saveFile.
vi.mock('@/utils/export', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/utils/export')>()
  return { ...actual, downloadFile: vi.fn(), saveFile: vi.fn(async () => {}) }
})

// 查询文件走后端 App 绑定;组件经共享 composable 调用这四个方法,测试里
// 整体替换该模块(不 mock composable 本体)。结果行内编辑经 chCellUpdate
// composable 调用预览/更新两个绑定,同样只 mock 绑定层。
vi.mock('../../../wailsjs/go/backend/App', () => ({
  ListQueryFiles: vi.fn(async () => []),
  ReadQueryFile: vi.fn(async () => ({ content: '', connection_id: '' })),
  WriteQueryFile: vi.fn(async () => {}),
  DeleteQueryFile: vi.fn(async () => {}),
  CHPreviewCellUpdate: vi.fn(async () => ({ statement: '', matched_rows: 0 })),
  CHUpdateCell: vi.fn(async () => {}),
}))

import * as App from '../../../wailsjs/go/backend/App'

// 断言出的文件方法 mock(生成绑定前 App.d.ts 未声明,需显式形状)。
interface FileAppMocks {
  ListQueryFiles: ReturnType<typeof vi.fn>
  ReadQueryFile: ReturnType<typeof vi.fn>
  WriteQueryFile: ReturnType<typeof vi.fn>
  DeleteQueryFile: ReturnType<typeof vi.fn>
}
const fileApp = App as unknown as FileAppMocks

// 结果行内编辑的绑定方法 mock(生成绑定前 App.d.ts 未声明,需显式形状)。
interface CellUpdateAppMocks {
  CHPreviewCellUpdate: ReturnType<typeof vi.fn>
  CHUpdateCell: ReturnType<typeof vi.fn>
}
const cellApp = App as unknown as FileAppMocks & CellUpdateAppMocks

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

// 假文件列表(镜像后端 QueryFileInfo 形状,后端返回裸数组)。
const queryFiles = (): { name: string; connection_id: string; size_bytes: number; mod_time_ms: number }[] => [
  { name: '每日报表.sql', connection_id: 'ch1', size_bytes: 42, mod_time_ms: 1725840000000 },
  { name: '重试扫描.sql', connection_id: 'ch2', size_bytes: 13, mod_time_ms: 1725840100000 },
]

// 测试统一使用的查询目录(localStorage 注入)。
const TEST_DIR = '/Users/test/queries'

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

// 在编辑器里按 ⌘S / Ctrl+S(事件从 CM contentDOM 冒泡到外层容器)。
function pressSaveShortcut(wrapper: VueWrapper, mods: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true }): void {
  cmInput(wrapper).contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 's', ...mods, bubbles: true }),
  )
}

// PromptDialog / ConfirmDialog teleport 到 body。
function bodyEl(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
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
    vi.clearAllMocks()
    // clearAllMocks 不清除 factory 里 set 的实现,但会清 mockResolvedValue
    // 之外的调用记录;为隔离用例覆盖,这里统一恢复默认实现。
    fileApp.ListQueryFiles.mockImplementation(async () => [])
    fileApp.ReadQueryFile.mockImplementation(async () => ({ content: '', connection_id: '' }))
    fileApp.WriteQueryFile.mockImplementation(async () => {})
    fileApp.DeleteQueryFile.mockImplementation(async () => {})
    // 行内编辑绑定:预览默认返回一条 ALTER 语句与匹配 1 行;更新成功。
    cellApp.CHPreviewCellUpdate.mockImplementation(async () => ({
      statement: "ALTER TABLE events UPDATE id = 'b' WHERE id = 'a' AND name = 'alice' AND age = '30' AND note IS NULL",
      matched_rows: 1,
    }))
    cellApp.CHUpdateCell.mockImplementation(async () => {})
    // composable 的文件列表是模块级共享状态,测试间清空避免串扰
    // (探针实例不 mock 本体,只用它重置/填充共享列表)。
    useQueryFiles({ connectionId: () => 'ch1' }).files.value = []
    localStorage.setItem(QUERY_DIR_KEY, TEST_DIR)
    document.body.innerHTML = ''
  })

  it('runs SQL typed into the CodeMirror editor and renders one card per statement with rows or error text', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
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
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
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
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
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
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
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
    const wrapper2 = mount(CHSqlConsole, { props: { tabId: 'ch-tab2', connectionId: 'ch2', database: 'metrics' } })
    await vi.waitFor(() => {
      expect(api.listCHTables).toHaveBeenLastCalledWith({ connection_id: 'ch2', database: 'metrics', show_system: false })
    })
    wrapper2.unmount()
  })

  it('runs only the selected text when the editor has a selection', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(
      [{ sql: 'SELECT 2', duration_ms: 2, columns: [{ name: 'two', type: 'UInt8' }], rows: [['2']] }],
    )
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    // 选中第二段 'SELECT 2'(10..18),运行按钮应只执行选中文本。
    cmInput(wrapper).dispatch({ selection: { anchor: 10, head: 18 } })
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="ch-stmt-card"]')).toHaveLength(1)
    })
    expect(api.chExecute).toHaveBeenCalledTimes(1)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 2' })
  })

  it('runs only the selection on Cmd+Enter as well', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(
      [{ sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] }],
    )
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    cmInput(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
    cmInput(wrapper).contentDOM.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', metaKey: true, bubbles: true }),
    )
    await vi.waitFor(() => {
      expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1' })
    })
    expect(api.chExecute).toHaveBeenCalledTimes(1)
  })

  it('opens the save-name prompt on Cmd/Ctrl+S when no file is open, and cancel writes nothing', async () => {
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 42')
    pressSaveShortcut(wrapper)
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    expect(bodyEl('prompt-title')?.textContent).toBe('保存查询')
    // 取消 → 只关弹窗,不写入。
    ;(bodyEl('prompt-cancel') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).toBeNull()
    })
    expect(fileApp.WriteQueryFile).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('saves the editor content as a new query file via the exposed requestSave and refreshes the list', async () => {
    fileApp.ListQueryFiles.mockResolvedValue(queryFiles())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 42')
    const vm = exposedApi(wrapper)
    expect(vm.currentFile()).toBeNull()
    vm.requestSave()
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    // 基线:确认前的所有列表拉取都发生在此时(以其后新增的调用证明刷新)。
    const listCallsBaseline = fileApp.ListQueryFiles.mock.calls.length
    await confirmPrompt('新文件.sql')
    await vi.waitFor(() => {
      expect(fileApp.WriteQueryFile).toHaveBeenCalledWith({
        dir: TEST_DIR,
        name: '新文件.sql',
        content: 'SELECT 42',
        connection_id: 'ch1',
      })
    })
    // 写入后刷新列表,新文件成为当前打开文件。
    await vi.waitFor(() => {
      expect(fileApp.ListQueryFiles.mock.calls.length).toBeGreaterThan(listCallsBaseline)
    })
    expect(vm.currentFile()).toBe('新文件.sql')
    wrapper.unmount()
  })

  it('overwrites the open file directly on Ctrl+S without prompting', async () => {
    fileApp.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'ch1' })
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    const vm = exposedApi(wrapper)
    // 编辑器为空 → 不脏,直接载入,不弹确认。
    vm.loadQueryFile('每日报表.sql')
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toBe('SELECT 1')
    })
    expect(vm.currentFile()).toBe('每日报表.sql')
    await typeSql(wrapper, 'SELECT updated')
    pressSaveShortcut(wrapper, { ctrlKey: true })
    await vi.waitFor(() => {
      expect(fileApp.WriteQueryFile).toHaveBeenCalledWith({
        dir: TEST_DIR,
        name: '每日报表.sql',
        content: 'SELECT updated',
        connection_id: 'ch1',
      })
    })
    // 已关联文件 → 直接覆盖,不弹名称输入。
    expect(bodyEl('prompt-dialog')).toBeNull()
    wrapper.unmount()
  })

  it('asks for overwrite confirmation when saving as an existing name, then writes', async () => {
    fileApp.ListQueryFiles.mockResolvedValue(queryFiles())
    // 重名判断基于 composable 的共享列表,先用探针拉取刷新。
    await useQueryFiles({ connectionId: () => 'ch1' }).refreshFiles()
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 42')
    exposedApi(wrapper).requestSaveAs()
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    expect(bodyEl('prompt-title')?.textContent).toBe('另存查询')
    await confirmPrompt('每日报表.sql')
    // 重名 → 弹覆盖确认。
    await vi.waitFor(() => {
      expect(bodyEl('confirm-dialog')).not.toBeNull()
    })
    expect(bodyEl('confirm-dialog-message')?.textContent).toContain('覆盖')
    ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(fileApp.WriteQueryFile).toHaveBeenCalledWith({
        dir: TEST_DIR,
        name: '每日报表.sql',
        content: 'SELECT 42',
        connection_id: 'ch1',
      })
    })
    await vi.waitFor(() => {
      expect(exposedApi(wrapper).currentFile()).toBe('每日报表.sql')
    })
    wrapper.unmount()
  })

  it('guards the exposed loadQueryFile with an unsaved-content confirmation', async () => {
    fileApp.ReadQueryFile.mockResolvedValue({ content: 'SELECT from file', connection_id: 'ch1' })
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT draft')
    // 无关联文件但已有未保存内容 → 先弹载入确认。
    exposedApi(wrapper).loadQueryFile('每日报表.sql')
    await vi.waitFor(() => {
      expect(bodyEl('confirm-dialog')).not.toBeNull()
    })
    expect(bodyEl('confirm-dialog-message')?.textContent).toContain('未保存')
    expect(fileApp.ReadQueryFile).not.toHaveBeenCalled()
    // 确认后才真正读文件并回填编辑器。
    ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(fileApp.ReadQueryFile).toHaveBeenCalledWith({ dir: TEST_DIR, name: '每日报表.sql' })
    })
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toBe('SELECT from file')
    })
    expect(exposedApi(wrapper).currentFile()).toBe('每日报表.sql')
    wrapper.unmount()
  })

  it('removes the current file via the exposed askRemoveCurrentFile after confirmation', async () => {
    fileApp.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'ch1' })
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    const vm = exposedApi(wrapper)
    vm.loadQueryFile('每日报表.sql')
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toBe('SELECT 1')
    })
    vm.askRemoveCurrentFile()
    await vi.waitFor(() => {
      expect(bodyEl('confirm-dialog')).not.toBeNull()
    })
    expect(bodyEl('confirm-dialog-message')?.textContent).toContain('每日报表.sql')
    ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(fileApp.DeleteQueryFile).toHaveBeenCalledWith({ dir: TEST_DIR, name: '每日报表.sql' })
    })
    // 删除当前打开文件 → 编辑器清空、当前文件名清空。
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toBe('')
    })
    expect(vm.currentFile()).toBeNull()
    wrapper.unmount()
  })

  // --- tab 标题跟随当前打开的 SQL 文件 ----------------------------------------
  // 控制台把 tabs store 中自己的 tab 重命名为当前关联文件名;未关联时保持
  // 默认标题「SQL 控制台」。
  describe('tab 标题跟随当前 SQL 文件', () => {
    function mountWithTitleTab() {
      // 预置 id 为 'ch-tab1' 的 tab,标题为默认值。
      const tabsStore = useTabsStore()
      tabsStore.openTabs.push({ id: 'ch-tab1', kind: 'ch-sql', title: 'SQL 控制台', connectionId: 'ch1' })
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      return { wrapper, tabsStore }
    }

    it('载入文件后 tab 标题变为文件名', async () => {
      fileApp.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'ch1' })
      const { wrapper, tabsStore } = mountWithTitleTab()
      expect(tabsStore.openTabs[0].title).toBe('SQL 控制台')
      exposedApi(wrapper).loadQueryFile('每日报表.sql')
      await vi.waitFor(() => {
        expect(tabsStore.openTabs[0].title).toBe('每日报表.sql')
      })
      wrapper.unmount()
    })

    it('删除当前文件后回退默认标题「SQL 控制台」', async () => {
      fileApp.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'ch1' })
      const { wrapper, tabsStore } = mountWithTitleTab()
      exposedApi(wrapper).loadQueryFile('每日报表.sql')
      await vi.waitFor(() => {
        expect(tabsStore.openTabs[0].title).toBe('每日报表.sql')
      })
      exposedApi(wrapper).askRemoveCurrentFile()
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).not.toBeNull()
      })
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(exposedApi(wrapper).currentFile()).toBeNull()
      })
      expect(tabsStore.openTabs[0].title).toBe('SQL 控制台')
      wrapper.unmount()
    })

    it('保存为新文件后 tab 标题变为新文件名', async () => {
      const { wrapper, tabsStore } = mountWithTitleTab()
      await typeSql(wrapper, 'SELECT 42')
      exposedApi(wrapper).requestSave()
      await vi.waitFor(() => {
        expect(bodyEl('prompt-dialog')).not.toBeNull()
      })
      await confirmPrompt('新文件.sql')
      await vi.waitFor(() => {
        expect(tabsStore.openTabs[0].title).toBe('新文件.sql')
      })
      wrapper.unmount()
    })
  })

  // --- 查询结果行内编辑(仅单表 SELECT 结果可编辑) ---------------------------
  // 双击单元格 → 行内输入 → 回车 → 确认弹窗(展示 ALTER 语句与匹配行数)→
  // 确认执行后重新执行该条语句刷新结果。composable/parser 用真实实现,
  // 只 mock wailsjs 绑定(CHPreviewCellUpdate / CHUpdateCell)。
  describe('结果编辑', () => {
    // 单表 SELECT 结果:4 列,首行含 NULL(note)以便覆盖 NULL 原值构造。
    const singleTableSelect = (sql = "SELECT * FROM events WHERE id = 'a' LIMIT 10"): CHStatementResult => ({
      sql,
      duration_ms: 5,
      columns: [
        { name: 'id', type: 'String' },
        { name: 'name', type: 'String' },
        { name: 'age', type: 'UInt8' },
        { name: 'note', type: 'Nullable(String)' },
      ],
      rows: [['a', 'alice', '30', null]],
    })

    // 运行给定语句并等待每条语句的结果卡片渲染完成。
    async function mountWithResults(results: CHStatementResult[]): Promise<VueWrapper> {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(results)
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, results.map((r) => r.sql).join('; '))
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await vi.waitFor(() => {
        expect(wrapper.findAll('[data-test="ch-stmt-card"]')).toHaveLength(results.length)
      })
      return wrapper
    }

    // 第 card 张结果卡片第 row 行第 col 列的数据单元格。
    function cellTd(wrapper: VueWrapper, card: number, row: number, col: number) {
      return wrapper
        .findAll('[data-test="ch-stmt-card"]')[card]
        .findAll('[data-test="ch-stmt-row"]')[row]
        .findAll('td')[col]
    }

    // 双击单元格并在行内输入框中输入文本(不提交)。
    async function startEdit(wrapper: VueWrapper, text: string): Promise<void> {
      await cellTd(wrapper, 0, 0, 0).trigger('dblclick')
      const editor = wrapper.find('[data-test="ch-cell-editor"]')
      ;(editor.element as HTMLInputElement).value = text
      await editor.trigger('input')
    }

    // 行内回车提交,等待确认弹窗出现。
    async function submitAndOpenConfirm(wrapper: VueWrapper): Promise<void> {
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).not.toBeNull()
      })
    }

    it('单表 SELECT 结果双击出现行内编辑框,回车后确认弹窗展示 ALTER 语句与匹配行数', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      await startEdit(wrapper, 'b')
      await submitAndOpenConfirm(wrapper)
      expect(bodyEl('confirm-dialog-message')?.textContent).toContain('ALTER TABLE events UPDATE')
      expect(bodyEl('confirm-dialog-message')?.textContent).toContain('匹配 1 行')
      // database 未限定 → 原样传空串;表名来自解析结果。
      expect(cellApp.CHPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ connection_id: 'ch1', database: '', table: 'events' }),
      )
      wrapper.unmount()
    })

    it('确认后重新执行该条语句并替换其结果,其他语句结果不受影响', async () => {
      const first = singleTableSelect()
      const second: CHStatementResult = {
        sql: 'SELECT 42',
        duration_ms: 1,
        columns: [{ name: 'answer', type: 'UInt8' }],
        rows: [['42']],
      }
      const exec = api.chExecute as ReturnType<typeof vi.fn>
      exec.mockResolvedValueOnce([first, second])
      // 确认成功后的刷新:仅重跑第一条语句,返回更新后的行。
      exec.mockResolvedValueOnce([{ ...first, rows: [['b', 'alice', '30', null]] }])
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, `${first.sql}; ${second.sql}`)
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await vi.waitFor(() => {
        expect(wrapper.findAll('[data-test="ch-stmt-card"]')).toHaveLength(2)
      })
      await startEdit(wrapper, 'b')
      await submitAndOpenConfirm(wrapper)
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      // 刷新入参是该条语句的原文(而非整段脚本)。
      await vi.waitFor(() => {
        expect(exec).toHaveBeenLastCalledWith({ connection_id: 'ch1', sql: first.sql })
      })
      // 第一条结果被替换为刷新后的行;第二条结果保持原样。
      await vi.waitFor(() => {
        expect(cellTd(wrapper, 0, 0, 0).text()).toBe('b')
      })
      expect(cellTd(wrapper, 1, 0, 0).text()).toBe('42')
      expect(cellApp.CHUpdateCell).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('预览入参:set 为编辑列与列类型,where 为整行列原值(NULL→null)', async () => {
      const wrapper = await mountWithResults([singleTableSelect("SELECT * FROM analytics.events WHERE id = 'a' LIMIT 10")])
      // 编辑第 2 列(name),其中 where 需含整行 4 列原值。
      await cellTd(wrapper, 0, 0, 1).trigger('dblclick')
      const editor = wrapper.find('[data-test="ch-cell-editor"]')
      ;(editor.element as HTMLInputElement).value = 'carol'
      await editor.trigger('input')
      await editor.trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(cellApp.CHPreviewCellUpdate).toHaveBeenCalledTimes(1)
      })
      expect(cellApp.CHPreviewCellUpdate).toHaveBeenCalledWith({
        connection_id: 'ch1',
        database: 'analytics',
        table: 'events',
        set: { column: 'name', type: 'String', value: 'carol' },
        where: [
          { column: 'id', type: 'String', value: 'a' },
          { column: 'name', type: 'String', value: 'alice' },
          { column: 'age', type: 'UInt8', value: '30' },
          { column: 'note', type: 'Nullable(String)', value: null },
        ],
      })
      wrapper.unmount()
    })

    it('空输入提交按 NULL 写入', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      await startEdit(wrapper, '')
      await submitAndOpenConfirm(wrapper)
      expect(cellApp.CHPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: { column: 'id', type: 'String', value: null } }),
      )
      wrapper.unmount()
    })

    it('JOIN / GROUP BY 查询结果只读:双击无编辑框', async () => {
      const join: CHStatementResult = {
        sql: 'SELECT a.id FROM events a JOIN users b ON a.uid = b.id',
        duration_ms: 1,
        columns: [{ name: 'id', type: 'String' }],
        rows: [['x']],
      }
      const group: CHStatementResult = {
        sql: 'SELECT status, count() FROM events GROUP BY status',
        duration_ms: 1,
        columns: [
          { name: 'status', type: 'String' },
          { name: 'count()', type: 'UInt64' },
        ],
        rows: [['ok', '2']],
      }
      const wrapper = await mountWithResults([join, group])
      for (const card of [0, 1]) {
        const td = cellTd(wrapper, card, 0, 0)
        await td.trigger('dblclick')
        expect(td.find('[data-test="ch-cell-editor"]').exists()).toBe(false)
        expect(td.attributes('title')).toContain('仅单表查询结果可编辑')
      }
      expect(cellApp.CHPreviewCellUpdate).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('Esc / blur 取消编辑不发起预览', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      await cellTd(wrapper, 0, 0, 0).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.esc')
      expect(wrapper.find('[data-test="ch-cell-editor"]').exists()).toBe(false)
      // blur 同样取消:再次进入编辑后失焦,编辑框消失。
      await cellTd(wrapper, 0, 0, 0).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('blur')
      expect(wrapper.find('[data-test="ch-cell-editor"]').exists()).toBe(false)
      expect(cellApp.CHPreviewCellUpdate).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('取消确认弹窗不执行更新', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      await startEdit(wrapper, 'b')
      await submitAndOpenConfirm(wrapper)
      ;(bodyEl('confirm-dialog-cancel') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).toBeNull()
      })
      expect(cellApp.CHUpdateCell).not.toHaveBeenCalled()
      // 结果保持原值。
      expect(cellTd(wrapper, 0, 0, 0).text()).toBe('a')
      wrapper.unmount()
    })

    it('更新失败时展示错误且不重新执行查询', async () => {
      cellApp.CHUpdateCell.mockImplementationOnce(async () => {
        throw new Error('模拟更新失败')
      })
      const wrapper = await mountWithResults([singleTableSelect()])
      await startEdit(wrapper, 'b')
      await submitAndOpenConfirm(wrapper)
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="ch-sql-error"]').text()).toContain('模拟更新失败')
      })
      expect(api.chExecute).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })
  })
})
