import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { CHStatementResult } from '@/api/types'
import { QUERY_DIR_KEY } from '@/utils/queryDir'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore } from '@/store/tabs'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlResultCard from '@/components/common/SqlResultCard.vue'
import CHSqlConsole from './CHSqlConsole.vue'

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

// 测试统一使用的查询目录(localStorage 注入)与结果区高度 key(两控制台共用)。
const TEST_DIR = '/Users/test/queries'
const RESULTS_HEIGHT_KEY = 'dbclient-sql-results-height'

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

// 在编辑器里按 ⌘/Ctrl+Enter(可带 Shift = 运行全部)。
function pressRunShortcut(
  wrapper: VueWrapper,
  mods: { metaKey?: boolean; ctrlKey?: boolean; shiftKey?: boolean } = { metaKey: true },
): void {
  cmInput(wrapper).contentDOM.dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Enter', ...mods, bubbles: true }),
  )
}

// 运行结果以 SqlResultCard 渲染:按组件实例断言 props。
function resultCards(wrapper: VueWrapper) {
  return wrapper.findAllComponents(SqlResultCard)
}

async function waitForCards(wrapper: VueWrapper, n: number): Promise<void> {
  await vi.waitFor(() => {
    expect(resultCards(wrapper)).toHaveLength(n)
  })
}

// —— 结果 Tab 条(SqlResultTabs)辅助 ——

// 结果 tab 元素(data-test="result-tab-<i>")。
function resultTabEls(wrapper: VueWrapper) {
  return wrapper.findAll('[data-test^="result-tab-"]')
}

// 等待 N 个结果 tab 就绪(全部脱离 running 态 = 本轮运行完成)。
async function waitForTabs(wrapper: VueWrapper, n: number): Promise<void> {
  await vi.waitFor(() => {
    const tabs = resultTabEls(wrapper)
    expect(tabs).toHaveLength(n)
    for (const t of tabs) {
      expect(t.find('.tab-dot.running').exists()).toBe(false)
    }
  })
}

// 点击第 i 个结果 tab 切换 active 卡。
async function selectTab(wrapper: VueWrapper, i: number): Promise<void> {
  await resultTabEls(wrapper)[i].trigger('click')
}

// 在编辑器内容区右键打开执行菜单(菜单渲染在 SqlEditor 内部)。
async function openRunMenu(wrapper: VueWrapper): Promise<void> {
  const content = wrapper.find('[data-test="ch-sql-input"] .cm-content').element as HTMLElement
  content.dispatchEvent(
    new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 20, clientY: 20 }),
  )
  await nextTick()
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
    localStorage.removeItem(RESULTS_HEIGHT_KEY)
    document.body.innerHTML = ''
  })

  // --- 运行全部与逐条卡片 ------------------------------------------------------

  it('运行全部:整段脚本发给后端,出现 N 个结果 tab,Tab 条下只渲染 active 一张卡', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1; SELECT bad' })
    expect(resultCards(wrapper)).toHaveLength(1)
    // active(第 0 个)卡:语句原文、耗时、列与行(NULL 单元格)。
    const card = resultCards(wrapper)[0]
    expect(card.props('statement')).toBe('SELECT 1')
    expect(card.props('durationMs')).toBe(12)
    expect(card.props('columns')).toEqual([{ name: 'one', type: 'UInt8' }])
    expect(card.props('rows')).toEqual([['1'], [null]])
    expect(card.props('error')).toBeFalsy()
    // 点击第二个 tab:切换到错误结果卡。
    await selectTab(wrapper, 1)
    const card2 = resultCards(wrapper)[0]
    expect(card2.props('statement')).toBe('SELECT bad')
    expect(card2.props('error')).toBe('Syntax error (multi-statements not allowed)')
    wrapper.unmount()
  })

  it('导出交给 SqlResultCard:exportName 按语句序号命名为 ch-result-<i>', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(resultCards(wrapper)[0].props('exportName')).toBe('ch-result-0')
    await selectTab(wrapper, 1)
    expect(resultCards(wrapper)[0].props('exportName')).toBe('ch-result-1')
    wrapper.unmount()
  })

  it('运行全部按钮忽略选区,始终执行整段脚本', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    // 选中第二段 'SELECT 2'(10..18),运行全部仍发整段脚本。
    cmInput(wrapper).dispatch({ selection: { anchor: 10, head: 18 } })
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1; SELECT 2' })
    wrapper.unmount()
  })

  // --- ⌘Enter 执行当前语句 / ⌘Shift+Enter 运行全部 -----------------------------

  it('runs on Cmd/Ctrl+Enter pressed inside the CodeMirror editor', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockImplementation(async (req: { sql: string }) => [
      { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] },
    ])
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1')
    // SqlEditor 自身不处理该组合键时事件从 CM contentDOM 冒泡到外层容器。
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1' })
  })

  it('⌘Enter 无选区时只执行光标所在语句(结果只有一张卡)', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockImplementation(async (req: { sql: string }) => [
      { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] },
    ])
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    // 显式把光标放回文档起始 → 执行第一条语句(split 文本含结尾分号)。
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 1 })
    await nextTick()
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(api.chExecute).toHaveBeenCalledTimes(1)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1;' })
    wrapper.unmount()
  })

  it('⌘Enter 按 cursor emit 的最新位置定位语句', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockImplementation(async (req: { sql: string }) => [
      { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] },
    ])
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    // 光标落在第二段 'SELECT bad' 内(offset 12 → 1 基 1 行 13 列)。
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 13 })
    await nextTick()
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT bad' })
    wrapper.unmount()
  })

  it('runs only the selection on Cmd+Enter as well', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockImplementation(async (req: { sql: string }) => [
      { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] },
    ])
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    cmInput(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1' })
    expect(api.chExecute).toHaveBeenCalledTimes(1)
  })

  it('⌘Shift+Enter 运行全部语句', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await waitForTabs(wrapper, 2)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT 1; SELECT bad' })
    wrapper.unmount()
  })

  it('监听 SqlEditor 的 run-statement emit,按单语句逻辑执行', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockImplementation(async (req: { sql: string }) => [
      { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] },
    ])
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    wrapper.findComponent(SqlEditor).vm.$emit('run-statement', 'SELECT bad')
    await waitForCards(wrapper, 1)
    expect(api.chExecute).toHaveBeenCalledWith({ connection_id: 'ch1', sql: 'SELECT bad' })
    wrapper.unmount()
  })

  // --- 结果区开合与拖拽 --------------------------------------------------------

  it('结果区初始关闭,运行后打开;点击 × 关闭回编辑器铺满,再运行重新打开', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(
      [{ sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] }],
    )
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="console-splitter"]').exists()).toBe(false)
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForCards(wrapper, 1)
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="console-splitter"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="results-close"]').exists()).toBe(true)
    // × 关闭:结果区与分隔条一并消失。
    await wrapper.find('[data-test="results-close"]').trigger('click')
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="console-splitter"]').exists()).toBe(false)
    // 再次执行(runAll 或单语句)重新打开结果区。
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForCards(wrapper, 1)
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('分隔条拖拽调整结果区高度并持久化,双击恢复 50/50,重挂载读取持久化高度', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(
      [{ sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] }],
    )
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForCards(wrapper, 1)
    const pane = () => wrapper.find('[data-test="results-pane"]').element as HTMLElement
    // 默认 320px。
    expect(pane().style.height).toBe('320px')
    const splitter = wrapper.find('[data-test="console-splitter"]')
    // 向上拖 100px → 高度 +100,松开写 localStorage。
    await splitter.trigger('mousedown')
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: -100 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(pane().style.height).toBe('420px')
    expect(localStorage.getItem(RESULTS_HEIGHT_KEY)).toBe('420')
    // 拖过头 → 被窗口高 80% 钳制(jsdom innerHeight 768 → 上限 614)。
    await splitter.trigger('mousedown')
    window.dispatchEvent(new MouseEvent('mousemove', { clientY: -9999 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(pane().style.height).toBe('614px')
    // 双击恢复 50/50(容器无布局高 → 回退窗口高一半 384)。
    await splitter.trigger('dblclick')
    await nextTick()
    expect(pane().style.height).toBe('384px')
    expect(localStorage.getItem(RESULTS_HEIGHT_KEY)).toBe('384')
    wrapper.unmount()
    // 重挂载:从 localStorage 读取持久化高度。
    const wrapper2 = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper2, 'SELECT 1')
    await wrapper2.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForCards(wrapper2, 1)
    expect((wrapper2.find('[data-test="results-pane"]').element as HTMLElement).style.height).toBe('384px')
    wrapper2.unmount()
  })

  // --- 语句状态标记 ------------------------------------------------------------

  it('发起时语句标记置 running,完成后按结果映射 ok/fail 与耗时/错误 detail', async () => {
    let resolveExec: (value: CHStatementResult[]) => void = () => {}
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockImplementation(
      () => new Promise<CHStatementResult[]>((resolve) => { resolveExec = resolve }),
    )
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await nextTick()
    const editorComp = wrapper.findComponent(SqlEditor)
    expect(editorComp.props('statementGutter')).toBe(true)
    expect(editorComp.props('highlightCursorStatement')).toBe(true)
    // from = 段起始 offset:第二段文本起始于 'SELECT 1; ' 之后(offset 10)。
    expect(editorComp.props('statementMarks')).toEqual([
      { from: 0, status: 'running' },
      { from: 10, status: 'running' },
    ])
    resolveExec(twoStatements())
    await waitForTabs(wrapper, 2)
    expect(editorComp.props('statementMarks')).toEqual([
      { from: 0, status: 'ok', detail: '12 ms' },
      { from: 10, status: 'fail', detail: 'Syntax error (multi-statements not allowed)' },
    ])
    wrapper.unmount()
  })

  it('编辑器内容变化后按语句文本重新匹配 marks,匹配不到的丢弃', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    // 改写第一条语句文本 → 其标记被丢弃;第二条文本未变 → 标记保留并重定位
    // ('SELECT 42;' 比 'SELECT 1;' 长 1 字符,第二段 from 随之变为 11)。
    await typeSql(wrapper, 'SELECT 42; SELECT bad')
    await nextTick()
    expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toEqual([
      { from: 11, status: 'fail', detail: 'Syntax error (multi-statements not allowed)' },
    ])
    wrapper.unmount()
  })

  // --- 空态与状态栏 ------------------------------------------------------------

  it('结果区打开但无结果时显示快捷键引导空态卡', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(true)
    })
    const empty = wrapper.find('[data-test="results-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('⌘Enter 执行当前语句')
    expect(empty.text()).toContain('⌘Shift+Enter 运行全部')
    wrapper.unmount()
  })

  it('状态栏显示光标行列、语句条数与最近耗时', async () => {
    ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
    const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
    const bar = () => wrapper.find('[data-test="console-statusbar"]')
    expect(bar().text()).toContain('行 1 : 列 1')
    expect(bar().text()).toContain('语句 0 条')
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    expect(bar().text()).toContain('语句 2 条')
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 3, col: 5 })
    await nextTick()
    expect(bar().text()).toContain('行 3 : 列 5')
    await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    // 最近耗时 = 最近一次运行各语句耗时之和(12 + 3)。
    expect(bar().text()).toContain('最近耗时 15 ms')
    wrapper.unmount()
  })

  // --- 补全 --------------------------------------------------------------------

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

  // --- ⌘S 保存全链路 -----------------------------------------------------------

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

  // 假文件列表(镜像后端 QueryFileInfo 形状,后端返回裸数组)。
  function queryFiles(): { name: string; connection_id: string; size_bytes: number; mod_time_ms: number }[] {
    return [
      { name: '每日报表.sql', connection_id: 'ch1', size_bytes: 42, mod_time_ms: 1725840000000 },
      { name: '重试扫描.sql', connection_id: 'ch2', size_bytes: 13, mod_time_ms: 1725840100000 },
    ]
  }

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
  // 编辑 UI 由 SqlResultCard 渲染:双击/提交/取消经卡片事件进入组件状态机,
  // 预览→确认→执行链路不变(确认弹窗仍由本组件渲染)。判定逻辑
  // (parseCHSingleTableSelect)与 composable 用真实实现,只 mock wailsjs 绑定。
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

    // 运行给定语句并等待每条语句的结果 tab 就绪。
    async function mountWithResults(results: CHStatementResult[]): Promise<VueWrapper> {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(results)
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, results.map((r) => r.sql).join('; '))
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await waitForTabs(wrapper, results.length)
      return wrapper
    }

    // 双击卡片单元格进入编辑。
    async function startEdit(wrapper: VueWrapper, cardIndex: number, row: number, col: number): Promise<void> {
      resultCards(wrapper)[cardIndex].vm.$emit('cell-dblclick', row, col)
      await nextTick()
    }

    // 双击 + 提交,等待确认弹窗出现。
    async function editAndSubmit(wrapper: VueWrapper, value: string): Promise<void> {
      await startEdit(wrapper, 0, 0, 0)
      resultCards(wrapper)[0].vm.$emit('edit-commit', value)
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).not.toBeNull()
      })
    }

    it('insertTarget 由 parseCHSingleTableSelect 判定后传给卡片,复杂查询为 null', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      expect(resultCards(wrapper)[0].props('insertTarget')).toEqual({ database: '', table: 'events' })
      wrapper.unmount()
      const join: CHStatementResult = {
        sql: 'SELECT a.id FROM events a JOIN users b ON a.uid = b.id',
        duration_ms: 1,
        columns: [{ name: 'id', type: 'String' }],
        rows: [['x']],
      }
      const wrapper2 = await mountWithResults([join])
      expect(resultCards(wrapper2)[0].props('insertTarget')).toBeNull()
      wrapper2.unmount()
    })

    it('cell-dblclick 进入编辑(editing 含原值草稿),edit-commit 发起预览', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      const card = resultCards(wrapper)[0]
      card.vm.$emit('cell-dblclick', 0, 1)
      await nextTick()
      expect(card.props('editing')).toEqual({ row: 0, col: 1, draft: 'alice' })
      card.vm.$emit('edit-commit', 'carol')
      await vi.waitFor(() => {
        expect(cellApp.CHPreviewCellUpdate).toHaveBeenCalledTimes(1)
      })
      // database 未限定 → 原样传空串;表名来自解析结果。
      expect(cellApp.CHPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ connection_id: 'ch1', database: '', table: 'events' }),
      )
      wrapper.unmount()
    })

    it('预览入参:set 为编辑列与列类型,where 为整行列原值(NULL→null)', async () => {
      const wrapper = await mountWithResults([singleTableSelect("SELECT * FROM analytics.events WHERE id = 'a' LIMIT 10")])
      // 编辑第 2 列(name),其中 where 需含整行 4 列原值。
      await startEdit(wrapper, 0, 0, 1)
      resultCards(wrapper)[0].vm.$emit('edit-commit', 'carol')
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
      await editAndSubmit(wrapper, '')
      expect(cellApp.CHPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: { column: 'id', type: 'String', value: null } }),
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
      await waitForTabs(wrapper, 2)
      await editAndSubmit(wrapper, 'b')
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      // 刷新入参是该条语句的原文(而非整段脚本)。
      await vi.waitFor(() => {
        expect(exec).toHaveBeenLastCalledWith({ connection_id: 'ch1', sql: first.sql })
      })
      // 第一条结果被替换为刷新后的行;第二条结果保持原样(切 tab 查看)。
      await vi.waitFor(() => {
        expect(resultCards(wrapper)[0].props('rows')).toEqual([['b', 'alice', '30', null]])
      })
      await selectTab(wrapper, 1)
      expect(resultCards(wrapper)[0].props('rows')).toEqual([['42']])
      expect(cellApp.CHUpdateCell).toHaveBeenCalledTimes(1)
      wrapper.unmount()
    })

    it('JOIN / GROUP BY 结果只读:cell-dblclick 不进入编辑也不发起预览', async () => {
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
      for (const i of [0, 1]) {
        if (i > 0) await selectTab(wrapper, i)
        const card = resultCards(wrapper)[0]
        card.vm.$emit('cell-dblclick', 0, 0)
        await nextTick()
        expect(card.props('editing')).toBeNull()
      }
      expect(cellApp.CHPreviewCellUpdate).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('edit-cancel 取消编辑,不发起预览', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      const card = resultCards(wrapper)[0]
      card.vm.$emit('cell-dblclick', 0, 0)
      await nextTick()
      expect(card.props('editing')).not.toBeNull()
      card.vm.$emit('edit-cancel')
      await nextTick()
      expect(card.props('editing')).toBeNull()
      expect(cellApp.CHPreviewCellUpdate).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('取消确认弹窗不执行更新', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      await editAndSubmit(wrapper, 'b')
      ;(bodyEl('confirm-dialog-cancel') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).toBeNull()
      })
      expect(cellApp.CHUpdateCell).not.toHaveBeenCalled()
      // 结果保持原值。
      expect(resultCards(wrapper)[0].props('rows')).toEqual([['a', 'alice', '30', null]])
      wrapper.unmount()
    })

    it('更新失败时展示错误且不重新执行查询', async () => {
      cellApp.CHUpdateCell.mockImplementationOnce(async () => {
        throw new Error('模拟更新失败')
      })
      const wrapper = await mountWithResults([singleTableSelect()])
      const execCalls = (api.chExecute as ReturnType<typeof vi.fn>).mock.calls.length
      await editAndSubmit(wrapper, 'b')
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="ch-sql-error"]').text()).toContain('模拟更新失败')
      })
      expect((api.chExecute as ReturnType<typeof vi.fn>).mock.calls.length).toBe(execCalls)
      wrapper.unmount()
    })
  })

  // --- 结果 Tab 条 + 右键执行菜单 ------------------------------------------------

  describe('结果 Tab 条', () => {
    it('多语句运行出现 N 个 tab,标签取语句前置注释文本', async () => {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, '-- 查询事件总数\nSELECT 1;\n-- 第二条:错误示例\nSELECT bad')
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      const tabs = resultTabEls(wrapper)
      expect(tabs[0].text()).toContain('查询事件总数')
      expect(tabs[1].text()).toContain('第二条:错误示例')
      wrapper.unmount()
    })

    it('无前置注释的语句回退「结果 N」,运行全部后 active 指向第 0 个 tab', async () => {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      const tabs = resultTabEls(wrapper)
      expect(tabs[0].text()).toContain('结果 1')
      expect(tabs[1].text()).toContain('结果 2')
      expect(tabs[0].classes()).toContain('active')
      expect(tabs[1].classes()).not.toContain('active')
      expect(resultCards(wrapper)[0].props('statement')).toBe('SELECT 1')
      wrapper.unmount()
    })

    it('点击 tab 切换 active 卡:仅渲染该条结果,active 类随之移动', async () => {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      await selectTab(wrapper, 1)
      const tabs = resultTabEls(wrapper)
      expect(tabs[1].classes()).toContain('active')
      expect(tabs[0].classes()).not.toContain('active')
      expect(resultCards(wrapper)).toHaveLength(1)
      expect(resultCards(wrapper)[0].props('statement')).toBe('SELECT bad')
      wrapper.unmount()
    })

    it('失败 tab 状态:错误语句 tab 状态点为 fail,成功为 ok;链路抛错全部置 fail', async () => {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      const tabs = resultTabEls(wrapper)
      expect(tabs[0].find('.tab-dot.ok').exists()).toBe(true)
      expect(tabs[1].find('.tab-dot.fail').exists()).toBe(true)
      wrapper.unmount()
      // 链路抛错(整段 reject):发起的 2 个 tab 全部 fail。
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('连接已断开'))
      const wrapper2 = mount(CHSqlConsole, { props: { tabId: 'ch-tab2', connectionId: 'ch1' } })
      await typeSql(wrapper2, 'SELECT 1; SELECT 2')
      await wrapper2.find('[data-test="btn-ch-run"]').trigger('click')
      await waitForTabs(wrapper2, 2)
      for (const t of resultTabEls(wrapper2)) {
        expect(t.find('.tab-dot.fail').exists()).toBe(true)
      }
      wrapper2.unmount()
    })

    it('CH 卡不开启行选择:selectable=false、primaryKey 传空数组', async () => {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockResolvedValue(twoStatements())
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      await wrapper.find('[data-test="btn-ch-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      const card = resultCards(wrapper)[0]
      expect(card.props('selectable')).toBe(false)
      expect(card.props('primaryKey')).toEqual([])
      wrapper.unmount()
    })
  })

  describe('右键执行菜单接线', () => {
    // 单段执行回声一条;整段脚本(运行全部)回两条,供 tab 数断言。
    function mockEchoAndScript(): void {
      ;(api.chExecute as ReturnType<typeof vi.fn>).mockImplementation(async (req: { sql: string }) =>
        req.sql === 'SELECT 1; SELECT bad'
          ? twoStatements()
          : [{ sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'UInt8' }], rows: [['1']] }],
      )
    }

    it('SqlEditor 开启 enable-run-menu', async () => {
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      expect(wrapper.findComponent(SqlEditor).props('enableRunMenu')).toBe(true)
      wrapper.unmount()
    })

    it('三个菜单入口分别触发:选中语句 / 当前语句 / 运行全部', async () => {
      mockEchoAndScript()
      const wrapper = mount(CHSqlConsole, { props: { tabId: 'ch-tab1', connectionId: 'ch1' } })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      // 选中第一条 'SELECT 1'(0..8)→ 右键「执行选中语句」按整段选中文本执行。
      cmInput(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
      await openRunMenu(wrapper)
      expect(wrapper.find('[data-test="menu-run-selection"]').exists()).toBe(true)
      await wrapper.find('[data-test="menu-run-selection"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(api.chExecute).toHaveBeenLastCalledWith({ connection_id: 'ch1', sql: 'SELECT 1' })
      // 无选区右键 →「执行当前语句」:执行光标所在语句(第 2 段)。
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 13 })
      await nextTick()
      await openRunMenu(wrapper)
      await wrapper.find('[data-test="menu-run-current"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(api.chExecute).toHaveBeenLastCalledWith({ connection_id: 'ch1', sql: 'SELECT bad' })
      // 「运行全部」→ 整段脚本交给后端。
      await openRunMenu(wrapper)
      await wrapper.find('[data-test="menu-run-all"]').trigger('click')
      await waitForTabs(wrapper, 2)
      expect(api.chExecute).toHaveBeenLastCalledWith({ connection_id: 'ch1', sql: 'SELECT 1; SELECT bad' })
      wrapper.unmount()
    })
  })
})
