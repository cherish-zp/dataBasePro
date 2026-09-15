import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { QUERY_DIR_KEY } from '@/utils/queryDir'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore, type Tab } from '@/store/tabs'
import { useToastStore } from '@/store/toast'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlResultCard from '@/components/common/SqlResultCard.vue'
import EsSqlConsole from './EsSqlConsole.vue'

// wailsjs 绑定尚未生成 Es 系列方法,测试整体替换该模块(vi.mock 会被提升,
// 因此 mocks 必须用 vi.hoisted 创建,否则工厂执行时 TDZ)。
const appMocks = vi.hoisted(() => ({
  ESExecute: vi.fn(),
  ListESIndices: vi.fn(),
  ESDsl: vi.fn(),
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', () => appMocks)
const app = appMocks

// 绑定生成前 App.d.ts 未声明 ES 方法,这里按契约描述显式形状。
interface EsStatementResult {
  sql: string
  duration_ms: number
  error?: string
  columns?: { name: string; type: string; comment?: string }[]
  rows?: (string | null)[][]
}

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

// 测试统一使用的查询目录(localStorage 注入)与结果区高度 key(各控制台共用)。
const TEST_DIR = '/Users/test/queries'
const RESULTS_HEIGHT_KEY = 'dbclient-sql-results-height'

// SqlEditor 内部由 CM6 创建自己的 .cm-editor,借 findFromDOM 拿到 view 实例
// (与 SqlEditor.spec.ts 同一套方法)。
function cmInput(wrapper: VueWrapper): EditorView {
  const host = wrapper.find('[data-test="es-sql-input"] .cm-editor').element as HTMLElement
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
function pressSaveShortcut(
  wrapper: VueWrapper,
  mods: { metaKey?: boolean; ctrlKey?: boolean } = { metaKey: true },
): void {
  cmInput(wrapper).contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ...mods, bubbles: true }))
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

// —— DSL 模式专用辅助 ——

// 切换 SQL/DSL 分段按钮。
async function switchMode(wrapper: VueWrapper, mode: 'sql' | 'dsl'): Promise<void> {
  await wrapper.find(`[data-test="es-mode-${mode}"]`).trigger('click')
}

// DSL 结果卡(组件内自渲染,非 SqlResultCard)。
function dslCards(wrapper: VueWrapper) {
  return wrapper.findAll('[data-test="es-dsl-card"]')
}

async function waitForDslCards(wrapper: VueWrapper, n: number): Promise<void> {
  await vi.waitFor(() => {
    expect(dslCards(wrapper)).toHaveLength(n)
  })
}

// 两请求 DSL 文本:请求间空行分隔(通用样例,行号/offset 已知)。
const dslTwoRequests = 'GET /_cat/indices\n\nPOST /idx/_search\n{"query":{"match_all":{}}}'

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

// 假文件列表(镜像后端 QueryFileInfo 形状,后端返回裸数组)。
const queryFiles = (): { name: string; connection_id: string; size_bytes: number; mod_time_ms: number }[] => [
  { name: '每日报表.sql', connection_id: 'e1', size_bytes: 42, mod_time_ms: 1725840000000 },
]

const twoResults = (): EsStatementResult[] => [
  {
    sql: 'SELECT 1',
    duration_ms: 12,
    columns: [{ name: 'one', type: 'bigint' }],
    rows: [['1'], [null]],
  },
  { sql: 'SELECT bad', duration_ms: 3, error: ' ES 版本过低或端点不可用' },
]

// 回声实现:每条执行的语句原样回一条单列结果(供 ⌘Enter / run-statement 用例)。
const echoResult = (req: { sql: string }): EsStatementResult[] => [
  { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'bigint' }], rows: [['1']] },
]

describe('EsSqlConsole', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // clearAllMocks 只清调用记录,这里统一恢复默认实现隔离用例。
    app.ESExecute.mockImplementation(async () => [] as EsStatementResult[])
    app.ListESIndices.mockImplementation(async () => [])
    // ESDsl 契约:任意 HTTP 响应(含 4xx/5xx)都 resolve {status, body},仅传输层错误 reject。
    app.ESDsl.mockImplementation(async () => ({ status: 200, body: '{}' }))
    app.ListQueryFiles.mockImplementation(async () => [])
    app.ReadQueryFile.mockImplementation(async () => ({ content: '', connection_id: '' }))
    app.WriteQueryFile.mockImplementation(async () => {})
    app.DeleteQueryFile.mockImplementation(async () => {})
    // composable 的文件列表是模块级共享状态,测试间清空避免串扰。
    useQueryFiles({ connectionId: () => 'e1' }).files.value = []
    localStorage.setItem(QUERY_DIR_KEY, TEST_DIR)
    localStorage.removeItem(RESULTS_HEIGHT_KEY)
    document.body.innerHTML = ''
  })

  // --- 索引补全拉取 -----------------------------------------------------------

  it('挂载后拉取索引清单,组装成仅索引名一层的 schema 传给 SqlEditor', async () => {
    app.ListESIndices.mockResolvedValue([
      { name: 'logs-2024', docs_count: 10, store_size_bytes: 1024 },
      { name: 'metrics', docs_count: 2, store_size_bytes: 2048 },
    ])
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await vi.waitFor(() => {
      expect(app.ListESIndices).toHaveBeenCalledWith('e1')
    })
    // ES 无 DESCRIBE 惯例:补全只到索引名,不带列。
    await vi.waitFor(() => {
      expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([
        { name: 'logs-2024' },
        { name: 'metrics' },
      ])
    })
    // 挂载阶段没有其他绑定调用(无库探测/列查询)。
    expect(app.ESExecute).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('ListESIndices 失败:静默降级为无补全,不影响编辑', async () => {
    app.ListESIndices.mockRejectedValue(new Error('连接不可用'))
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await vi.waitFor(() => {
      expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([])
    })
    expect(wrapper.find('[data-test="es-sql-error"]').exists()).toBe(false)
    wrapper.unmount()
  })

  // --- 运行全部与逐条卡片 ------------------------------------------------------

  it('运行全部:整段脚本发给后端(payload 不带 database),每条语句渲染一张只读 SqlResultCard', async () => {
    app.ESExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [],
    )
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await waitForCards(wrapper, 2)
    // toHaveBeenCalledWith 为整体深度相等:断言 payload 不携带 database 字段。
    expect(app.ESExecute).toHaveBeenCalledWith({ connection_id: 'e1', sql: 'SELECT 1; SELECT bad' })
    const cards = resultCards(wrapper)
    // 第一条:语句原文、耗时、列与行(NULL 单元格)都经 props 传入卡片。
    expect(cards[0].props('statement')).toBe('SELECT 1')
    expect(cards[0].props('durationMs')).toBe(12)
    expect(cards[0].props('columns')).toEqual([{ name: 'one', type: 'bigint' }])
    expect(cards[0].props('rows')).toEqual([['1'], [null]])
    expect(cards[0].props('error')).toBeFalsy()
    // 第二条:错误文本经 error prop 传入,由卡片渲染错误卡。
    expect(cards[1].props('statement')).toBe('SELECT bad')
    expect(cards[1].props('error')).toBe(' ES 版本过低或端点不可用')
    wrapper.unmount()
  })

  it('结果卡只读:insertTarget 恒 null、exportName 按序命名,双击不进入编辑', async () => {
    app.ESExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [],
    )
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await waitForCards(wrapper, 2)
    const cards = resultCards(wrapper)
    expect(cards[0].props('insertTarget')).toBeNull()
    expect(cards[1].props('insertTarget')).toBeNull()
    expect(cards[0].props('exportName')).toBe('es-result-0')
    expect(cards[1].props('exportName')).toBe('es-result-1')
    // 控制台不接编辑事件:对卡片发双击,editing prop 保持 null,无任何反应。
    cards[0].vm.$emit('cell-dblclick', 0, 0)
    await nextTick()
    expect(cards[0].props('editing')).toBeNull()
    wrapper.unmount()
  })

  it('运行全部按钮忽略选区,始终执行整段脚本', async () => {
    app.ESExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT 2' ? twoResults() : [],
    )
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    // 选中第二段 'SELECT 2'(10..18),运行全部仍发整段脚本。
    cmInput(wrapper).dispatch({ selection: { anchor: 10, head: 18 } })
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await waitForCards(wrapper, 2)
    expect(app.ESExecute).toHaveBeenCalledWith({ connection_id: 'e1', sql: 'SELECT 1; SELECT 2' })
    wrapper.unmount()
  })

  it('结果区打开但无结果时显示快捷键引导空态卡', async () => {
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(true)
    })
    const empty = wrapper.find('[data-test="results-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toContain('⌘Enter 执行当前语句')
    expect(empty.text()).toContain('⌘Shift+Enter 运行全部')
    // × 关闭结果区回编辑器铺满。
    await wrapper.find('[data-test="results-close"]').trigger('click')
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })

  // --- ⌘Enter 执行当前语句 / ⌘Shift+Enter 运行全部 -----------------------------

  it('⌘Enter 无选区时只执行光标所在语句', async () => {
    app.ESExecute.mockImplementation(echoResult)
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    // 显式把光标放回文档起始 → 执行第一条语句(split 文本含结尾分号)。
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 1 })
    await nextTick()
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(app.ESExecute).toHaveBeenCalledWith({ connection_id: 'e1', sql: 'SELECT 1;' })
    wrapper.unmount()
  })

  it('⌘Enter 按 cursor emit 的最新位置定位语句;有选区时执行选中文本', async () => {
    app.ESExecute.mockImplementation(echoResult)
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    // 光标落在第二段 'SELECT bad' 内(offset 12 → 1 基 1 行 13 列)。
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 13 })
    await nextTick()
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(app.ESExecute).toHaveBeenLastCalledWith({ connection_id: 'e1', sql: 'SELECT bad' })
    // 选中第一段 'SELECT 1'(0..8)→ ⌘Enter 执行选中文本。
    cmInput(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(app.ESExecute).toHaveBeenLastCalledWith({ connection_id: 'e1', sql: 'SELECT 1' })
    wrapper.unmount()
  })

  it('⌘Shift+Enter 运行全部语句', async () => {
    app.ESExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [],
    )
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await waitForCards(wrapper, 2)
    expect(app.ESExecute).toHaveBeenCalledWith({ connection_id: 'e1', sql: 'SELECT 1; SELECT bad' })
    wrapper.unmount()
  })

  // --- 语句状态标记 ------------------------------------------------------------

  it('发起时语句标记置 running,完成后按结果映射 ok/fail 与耗时/错误 detail', async () => {
    let resolveExec: (value: EsStatementResult[]) => void = () => {}
    app.ESExecute.mockImplementation(
      async () => new Promise<EsStatementResult[]>((resolve) => { resolveExec = resolve }),
    )
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await nextTick()
    const editorComp = wrapper.findComponent(SqlEditor)
    expect(editorComp.props('statementGutter')).toBe(true)
    expect(editorComp.props('highlightCursorStatement')).toBe(true)
    // from = 段起始 offset:第二段文本起始于 'SELECT 1; ' 之后(offset 10)。
    expect(editorComp.props('statementMarks')).toEqual([
      { from: 0, status: 'running' },
      { from: 10, status: 'running' },
    ])
    resolveExec(twoResults())
    await waitForCards(wrapper, 2)
    expect(editorComp.props('statementMarks')).toEqual([
      { from: 0, status: 'ok', detail: '12 ms' },
      { from: 10, status: 'fail', detail: ' ES 版本过低或端点不可用' },
    ])
    wrapper.unmount()
  })

  it('编辑器内容变化后按语句文本重新匹配 marks,匹配不到的丢弃', async () => {
    app.ESExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [],
    )
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await waitForCards(wrapper, 2)
    // 改写第一条语句文本 → 其标记被丢弃;第二条文本未变 → 标记保留并重定位
    // ('SELECT 42;' 比 'SELECT 1;' 长 1 字符,第二段 from 随之变为 11)。
    await typeSql(wrapper, 'SELECT 42; SELECT bad')
    await nextTick()
    expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toEqual([
      { from: 11, status: 'fail', detail: ' ES 版本过低或端点不可用' },
    ])
    wrapper.unmount()
  })

  it('链路抛错(如服务端低于 6.3)时控制台顶部错误条展示,标记置 fail', async () => {
    app.ESExecute.mockRejectedValue(new Error('ES SQL 端点不可用:服务端版本过低'))
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-sql-error"]').text()).toContain('服务端版本过低')
    })
    expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toEqual([
      { from: 0, status: 'fail', detail: 'ES SQL 端点不可用:服务端版本过低' },
    ])
    wrapper.unmount()
  })

  // --- 状态栏 ------------------------------------------------------------

  it('状态栏显示光标行列、语句条数与最近耗时', async () => {
    app.ESExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [],
    )
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    const bar = () => wrapper.find('[data-test="console-statusbar"]')
    expect(bar().text()).toContain('行 1 : 列 1')
    expect(bar().text()).toContain('语句 0 条')
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    expect(bar().text()).toContain('语句 2 条')
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 3, col: 5 })
    await nextTick()
    expect(bar().text()).toContain('行 3 : 列 5')
    await wrapper.find('[data-test="btn-es-run"]').trigger('click')
    await waitForCards(wrapper, 2)
    // 最近耗时 = 最近一次运行各语句耗时之和(12 + 3)。
    expect(bar().text()).toContain('最近耗时 15 ms')
    wrapper.unmount()
  })

  // --- ⌘S 保存全链路 -----------------------------------------------------------

  it('无关联文件时 ⌘S 打开名称弹窗,取消不写盘', async () => {
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 42')
    pressSaveShortcut(wrapper)
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    expect(bodyEl('prompt-title')?.textContent).toBe('保存查询')
    ;(bodyEl('prompt-cancel') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).toBeNull()
    })
    expect(app.WriteQueryFile).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('保存为新文件:WriteQueryFile payload 不带 database 字段,写入后刷新列表并关联', async () => {
    app.ListQueryFiles.mockResolvedValue(queryFiles())
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    await typeSql(wrapper, 'SELECT 42')
    const vm = exposedApi(wrapper)
    expect(vm.currentFile()).toBeNull()
    vm.requestSave()
    await vi.waitFor(() => {
      expect(bodyEl('prompt-dialog')).not.toBeNull()
    })
    const listCallsBaseline = app.ListQueryFiles.mock.calls.length
    await confirmPrompt('新文件.sql')
    await vi.waitFor(() => {
      expect(app.WriteQueryFile).toHaveBeenCalledWith({
        dir: TEST_DIR,
        name: '新文件.sql',
        content: 'SELECT 42',
        connection_id: 'e1',
      })
    })
    // 写入后刷新列表,新文件成为当前打开文件。
    await vi.waitFor(() => {
      expect(app.ListQueryFiles.mock.calls.length).toBeGreaterThan(listCallsBaseline)
    })
    expect(vm.currentFile()).toBe('新文件.sql')
    wrapper.unmount()
  })

  it('已关联文件时 ⌘S 直接覆盖,不弹名称输入', async () => {
    app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'e1' })
    const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
    const vm = exposedApi(wrapper)
    vm.loadQueryFile('每日报表.sql')
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toBe('SELECT 1')
    })
    expect(vm.currentFile()).toBe('每日报表.sql')
    await typeSql(wrapper, 'SELECT updated')
    pressSaveShortcut(wrapper, { ctrlKey: true })
    await vi.waitFor(() => {
      expect(app.WriteQueryFile).toHaveBeenCalledWith({
        dir: TEST_DIR,
        name: '每日报表.sql',
        content: 'SELECT updated',
        connection_id: 'e1',
      })
    })
    // 已关联文件 → 直接覆盖,不弹名称输入。
    expect(bodyEl('prompt-dialog')).toBeNull()
    wrapper.unmount()
  })

  // --- tab 标题跟随当前打开的 SQL 文件 ----------------------------------------

  describe('tab 标题跟随当前 SQL 文件', () => {
    function mountWithTitleTab() {
      // 预置 id 为 'e-tab1' 的 tab,标题为默认值。
      const tabsStore = useTabsStore()
      tabsStore.openTabs.push({
        id: 'e-tab1',
        kind: 'es-sql',
        title: 'SQL 控制台',
        connectionId: 'e1',
      } as Tab)
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      return { wrapper, tabsStore }
    }

    it('载入文件后 tab 标题变为文件名,删除当前文件后回退默认标题', async () => {
      app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'e1' })
      const { wrapper, tabsStore } = mountWithTitleTab()
      expect(tabsStore.openTabs[0].title).toBe('SQL 控制台')
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

  // --- DSL 模式(Kibana Dev Tools 风格) ---------------------------------------

  describe('DSL 模式', () => {
    it('默认 SQL 模式;分段按钮切换 active,DSL 下补全传空、编辑器内容保持不动,marks 清空', async () => {
      app.ListESIndices.mockResolvedValue([
        { name: 'logs-2024', docs_count: 10, store_size_bytes: 1024 },
      ])
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await vi.waitFor(() => {
        expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([{ name: 'logs-2024' }])
      })
      const sqlBtn = wrapper.find('[data-test="es-mode-sql"]')
      const dslBtn = wrapper.find('[data-test="es-mode-dsl"]')
      expect(sqlBtn.classes()).toContain('active')
      expect(dslBtn.classes()).not.toContain('active')

      await typeSql(wrapper, 'GET /a')
      // 先在 SQL 模式制造一条标记,切 DSL 后应被清空。
      app.ESExecute.mockResolvedValue([{ sql: 'GET /a', duration_ms: 5, columns: [], rows: [] }])
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await vi.waitFor(() => {
        expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toHaveLength(1)
      })

      await switchMode(wrapper, 'dsl')
      expect(sqlBtn.classes()).not.toContain('active')
      expect(dslBtn.classes()).toContain('active')
      // DSL 模式:路径补全无意义 → 传空;编辑器内容保持不动。
      expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([])
      expect(cmInput(wrapper).state.doc.toString()).toBe('GET /a')
      // marks 清空。
      expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toEqual([])

      await switchMode(wrapper, 'sql')
      expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([{ name: 'logs-2024' }])
      expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toEqual([])
      wrapper.unmount()
    })

    it('DSL 空态引导卡展示 DSL 快捷键提示', async () => {
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await typeSql(wrapper, 'SELECT 1')
      // SQL 模式跑一次空结果,打开结果区展示 SQL 空态文案。
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="results-empty"]').text()).toContain('⌘Enter 执行当前语句')
      })
      await switchMode(wrapper, 'dsl')
      expect(wrapper.find('[data-test="results-empty"]').text()).toContain('GET /索引/_search')
      expect(wrapper.find('[data-test="results-empty"]').text()).toContain('⌘Enter 执行当前请求')
      wrapper.unmount()
    })

    it('运行全部:逐请求解析并调用 ESDsl(method/path/body 断言),每请求一张结果卡', async () => {
      app.ESDsl
        .mockResolvedValueOnce({ status: 200, body: '{"took":1}' })
        .mockResolvedValueOnce({ status: 200, body: '{"acknowledged":true}' })
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, dslTwoRequests)
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await waitForDslCards(wrapper, 2)
      expect(app.ESDsl).toHaveBeenNthCalledWith(1, {
        connection_id: 'e1',
        method: 'GET',
        path: '/_cat/indices',
        body: '',
      })
      expect(app.ESDsl).toHaveBeenNthCalledWith(2, {
        connection_id: 'e1',
        method: 'POST',
        path: '/idx/_search',
        body: '{"query":{"match_all":{}}}',
      })
      const cards = dslCards(wrapper)
      expect(cards[0].find('[data-test="es-dsl-card-title"]').text()).toBe('GET /_cat/indices')
      expect(cards[0].find('[data-test="es-dsl-card-meta"]').text()).toContain('HTTP 200')
      expect(cards[0].find('[data-test="es-dsl-card-meta"]').text()).toMatch(/ms$/)
      // 状态栏请求条数随 DSL 模式切换。
      expect(wrapper.find('[data-test="statusbar-statements"]').text()).toContain('请求 2 条')
      wrapper.unmount()
    })

    it('结果卡正文 pretty JSON(2 空格缩进),2xx 卡绿色、带复制原始 body 按钮', async () => {
      app.ESDsl.mockResolvedValue({ status: 200, body: '{"took":1,"hits":{"total":0}}' })
      const writeText = vi.fn().mockResolvedValue(undefined)
      Object.assign(navigator, { clipboard: { writeText } })
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, 'GET /_cat/indices')
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await waitForDslCards(wrapper, 1)
      const card = dslCards(wrapper)[0]
      expect(card.classes()).toContain('ok')
      expect(card.find('[data-test="es-dsl-result"]').text()).toBe('{\n  "took": 1,\n  "hits": {\n    "total": 0\n  }\n}')
      await card.find('[data-test="es-dsl-copy"]').trigger('click')
      await vi.waitFor(() => {
        expect(writeText).toHaveBeenCalledWith('{"took":1,"hits":{"total":0}}')
      })
      wrapper.unmount()
    })

    it('4xx/5xx 也正常展示:失败色 + HTTP 状态 + 响应正文,不进顶部错误条', async () => {
      app.ESDsl.mockResolvedValue({ status: 404, body: '{"error":"index_not_found"}' })
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, 'GET /nope/_search')
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await waitForDslCards(wrapper, 1)
      const card = dslCards(wrapper)[0]
      expect(card.classes()).toContain('fail')
      expect(card.find('[data-test="es-dsl-card-meta"]').text()).toContain('HTTP 404')
      expect(card.find('[data-test="es-dsl-result"]').text()).toContain('index_not_found')
      expect(wrapper.find('[data-test="es-sql-error"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('传输层错误(reject)→ 该请求卡展示错误并置失败色', async () => {
      app.ESDsl.mockRejectedValue(new Error('连接被拒绝'))
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, 'GET /a')
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await waitForDslCards(wrapper, 1)
      const card = dslCards(wrapper)[0]
      expect(card.classes()).toContain('fail')
      expect(card.find('[data-test="es-dsl-card-meta"]').text()).toContain('连接被拒绝')
      expect(wrapper.find('[data-test="es-sql-error"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('解析错误 → 错误卡(原始文本段 + 解析错误信息),不发起 ESDsl 调用', async () => {
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, '{"no":"verb"}')
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await waitForDslCards(wrapper, 1)
      expect(app.ESDsl).not.toHaveBeenCalled()
      const card = dslCards(wrapper)[0]
      expect(card.classes()).toContain('fail')
      expect(card.find('[data-test="es-dsl-card-meta"]').text()).toContain('解析不出 DSL 请求')
      expect(card.find('[data-test="es-dsl-result"]').text()).toBe('{"no":"verb"}')
      wrapper.unmount()
    })

    it('⌘Enter 无选区时按光标行定位当前请求(1 基 startLine)', async () => {
      app.ESDsl.mockResolvedValue({ status: 200, body: '{}' })
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, dslTwoRequests)
      // 光标落在第 3 行(第二个请求的 method 行)。
      wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 3, col: 1 })
      await nextTick()
      pressRunShortcut(wrapper)
      await waitForDslCards(wrapper, 1)
      expect(app.ESDsl).toHaveBeenCalledTimes(1)
      expect(app.ESDsl).toHaveBeenCalledWith({
        connection_id: 'e1',
        method: 'POST',
        path: '/idx/_search',
        body: '{"query":{"match_all":{}}}',
      })
      // 光标在第 1 行 → 第一个请求。
      app.ESDsl.mockClear()
      wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 1 })
      await nextTick()
      pressRunShortcut(wrapper)
      await waitForDslCards(wrapper, 1)
      expect(app.ESDsl).toHaveBeenCalledWith({
        connection_id: 'e1',
        method: 'GET',
        path: '/_cat/indices',
        body: '',
      })
      wrapper.unmount()
    })

    it('⌘Enter 有选区时整体解析选中文本;⌘Shift+Enter 运行全部;gutter ▶ 走同管道', async () => {
      app.ESDsl.mockResolvedValue({ status: 200, body: '{}' })
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, dslTwoRequests)
      // 选区为第一个请求文本(0..17)→ 只执行该请求。
      cmInput(wrapper).dispatch({ selection: { anchor: 0, head: 17 } })
      pressRunShortcut(wrapper)
      await waitForDslCards(wrapper, 1)
      expect(app.ESDsl).toHaveBeenCalledTimes(1)
      expect(app.ESDsl).toHaveBeenCalledWith({
        connection_id: 'e1',
        method: 'GET',
        path: '/_cat/indices',
        body: '',
      })
      // ⌘Shift+Enter → 全部请求。
      app.ESDsl.mockClear()
      pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
      await waitForDslCards(wrapper, 2)
      expect(app.ESDsl).toHaveBeenCalledTimes(2)
      // gutter ▶(emit 携带 SQL 段文本,DSL 模式下按 DSL 解析执行)。
      app.ESDsl.mockClear()
      wrapper.findComponent(SqlEditor).vm.$emit('run-statement', dslTwoRequests)
      await waitForDslCards(wrapper, 2)
      expect(app.ESDsl).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    })

    it('DSL 执行后按 startLine 写语句标记,detail 为 HTTP 状态/错误', async () => {
      app.ESDsl
        .mockResolvedValueOnce({ status: 200, body: '{"took":1}' })
        .mockResolvedValueOnce({ status: 404, body: '{"error":"not_found"}' })
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, dslTwoRequests)
      await wrapper.find('[data-test="btn-es-run"]').trigger('click')
      await waitForDslCards(wrapper, 2)
      // 第二请求 method 行在第 3 行:from = 17('GET /_cat/indices') + 1 + 1(空行) = 19。
      expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toEqual([
        { from: 0, status: 'ok', detail: 'HTTP 200' },
        { from: 19, status: 'fail', detail: 'HTTP 404' },
      ])
      wrapper.unmount()
    })

    it('⌘S 在 DSL 模式下保存 DSL 文本到查询文件', async () => {
      app.ListQueryFiles.mockResolvedValue(queryFiles())
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      await typeSql(wrapper, dslTwoRequests)
      pressSaveShortcut(wrapper)
      await vi.waitFor(() => {
        expect(bodyEl('prompt-dialog')).not.toBeNull()
      })
      await confirmPrompt('dsl查询.sql')
      await vi.waitFor(() => {
        expect(app.WriteQueryFile).toHaveBeenCalledWith({
          dir: TEST_DIR,
          name: 'dsl查询.sql',
          content: dslTwoRequests,
          connection_id: 'e1',
        })
      })
      wrapper.unmount()
    })

    // 回归:模式按连接记忆,SQL 必败时自动切 DSL 并播种模板(用户报告的
    // 「SQL 运行报无 SQL 能力」「▶ 报解析失败」两个问题的行为锁定)。
    it('模式按连接记忆:切到 DSL 后重新挂载仍是 DSL', async () => {
      localStorage.removeItem('es-console-mode:e1')
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await switchMode(wrapper, 'dsl')
      wrapper.unmount()
      const again = mount(EsSqlConsole, { props: { tabId: 'e-tab2', connectionId: 'e1' } })
      expect(again.find('[data-test="es-mode-dsl"]').classes()).toContain('active')
      again.unmount()
      localStorage.removeItem('es-console-mode:e1')
    })

    it('切换到 DSL 时,编辑器内容解析不出 DSL 请求则播种起始模板', async () => {
      localStorage.removeItem('es-console-mode:e1')
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await typeSql(wrapper, 'select * from t;')
      await switchMode(wrapper, 'dsl')
      expect(cmInput(wrapper).state.doc.toString()).toBe('GET /_cat/indices?format=json\n')
      wrapper.unmount()
      localStorage.removeItem('es-console-mode:e1')
    })

    it('SQL 模式下服务端报「无 SQL 能力」时自动切换到 DSL 并提示', async () => {
      localStorage.removeItem('es-console-mode:e1')
      const toast = useToastStore()
      const wrapper = mount(EsSqlConsole, { props: { tabId: 'e-tab1', connectionId: 'e1' } })
      await typeSql(wrapper, 'SELECT 1')
      app.ESExecute.mockRejectedValue(new Error('该服务端无 SQL 能力(检测到 version=6.1.0)'))
      await pressRunShortcut(wrapper)
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="es-mode-dsl"]').classes()).toContain('active')
      })
      expect(toast.message).toContain('已切换到 DSL 模式')
      // 编辑器被播种为 DSL 起始模板,不再残留必败的 SQL 文本。
      expect(cmInput(wrapper).state.doc.toString()).toBe('GET /_cat/indices?format=json\n')
      wrapper.unmount()
      localStorage.removeItem('es-console-mode:e1')
    })
  })
})
