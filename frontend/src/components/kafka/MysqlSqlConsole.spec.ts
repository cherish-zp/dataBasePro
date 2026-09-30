import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { QUERY_DIR_KEY } from '@/utils/queryDir'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore, type Tab } from '@/store/tabs'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlResultCard from '@/components/common/SqlResultCard.vue'
import MysqlSqlConsole from './MysqlSqlConsole.vue'

// wailsjs 绑定尚未生成 Mysql 系列方法,测试整体替换该模块(vi.mock 会被提升,
// 因此 mocks 必须用 vi.hoisted 创建,否则工厂执行时 TDZ)。
const appMocks = vi.hoisted(() => ({
  MysqlExecute: vi.fn(),
  MysqlPreviewCellUpdate: vi.fn(),
  MysqlUpdateCell: vi.fn(),
  MysqlPreviewDeleteRow: vi.fn(),
  MysqlDeleteRow: vi.fn(),
  ListMysqlTables: vi.fn(),
  ListMysqlDatabases: vi.fn(),
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', () => appMocks)
const app = appMocks

// 绑定生成前 App.d.ts 未声明 Mysql 方法,这里按契约描述显式形状。
interface MysqlColumn {
  name: string
  type: string
  comment?: string
}
interface MysqlStatementResult {
  sql: string
  duration_ms: number
  error?: string
  columns?: MysqlColumn[]
  rows?: (string | null)[][]
  primary_key?: string[]
  source_database?: string
  source_table?: string
  total_rows?: number
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

// 测试统一使用的查询目录(localStorage 注入)与结果区高度 key(两控制台共用)。
const TEST_DIR = '/Users/test/queries'
const RESULTS_HEIGHT_KEY = 'dbclient-sql-results-height'

// SqlEditor 内部由 CM6 创建自己的 .cm-editor,借 findFromDOM 拿到 view 实例
// (与 SqlEditor.spec.ts 同一套方法)。
function cmInput(wrapper: VueWrapper): EditorView {
  const host = wrapper.find('[data-test="mysql-sql-input"] .cm-editor').element as HTMLElement
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
  const content = wrapper.find('[data-test="mysql-sql-input"] .cm-content').element as HTMLElement
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

// 假文件列表(镜像后端 QueryFileInfo 形状,后端返回裸数组)。
const queryFiles = (): { name: string; connection_id: string; size_bytes: number; mod_time_ms: number }[] => [
  { name: '每日报表.sql', connection_id: 'm1', size_bytes: 42, mod_time_ms: 1725840000000 },
  { name: '重试扫描.sql', connection_id: 'm2', size_bytes: 13, mod_time_ms: 1725840100000 },
]

const twoResults = (): MysqlStatementResult[] => [
  { sql: 'SELECT 1', duration_ms: 12, columns: [{ name: 'one', type: 'int' }], rows: [['1'], [null]] },
  { sql: 'SELECT bad', duration_ms: 3, error: 'You have an error in your SQL syntax' },
]

// 挂载时(有 database prop)会先查一次 information_schema.columns 组装补全,
// 运行/重跑类用例的 MysqlExecute mock 都按 sql 内容分发,避免受该次调用干扰。
const columnsQueryResult = (): MysqlStatementResult[] => [
  { sql: 'information_schema', duration_ms: 1, columns: [], rows: [] },
]

// 包装 MysqlExecute 实现:系统表补全查询立即返回,其余交给用例实现。
function withSystemGuard(impl: (req: { sql: string }) => unknown): (req: { sql: string }) => Promise<unknown> {
  return async (req: { sql: string }) => {
    if (req.sql.includes('information_schema.columns')) return columnsQueryResult()
    return impl(req)
  }
}

// 回声实现:每条执行的语句原样回一条单列结果(供 ⌘Enter / run-statement 用例)。
const echoResult = (req: { sql: string }): MysqlStatementResult[] => [
  { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'int' }], rows: [['1']] },
]

describe('MysqlSqlConsole', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    // clearAllMocks 只清调用记录,这里统一恢复默认实现隔离用例。
    app.MysqlExecute.mockImplementation(async () => [] as MysqlStatementResult[])
    app.ListMysqlTables.mockImplementation(async () => [])
    app.MysqlPreviewCellUpdate.mockImplementation(async () => ({
      statement: "UPDATE `users` SET `name` = 'b' WHERE `id` = '1' AND `name` = 'alice' AND `age` = '30' AND `note` IS NULL",
      matched_rows: 1,
    }))
    app.MysqlUpdateCell.mockImplementation(async () => {})
    app.MysqlPreviewDeleteRow.mockImplementation(async () => ({
      statement: "DELETE FROM `shop`.`users` WHERE `id` = '1'",
      matched_rows: 1,
    }))
    app.MysqlDeleteRow.mockImplementation(async () => {})
    app.ListMysqlDatabases.mockResolvedValue(['shop', 'orders'])
    app.ListQueryFiles.mockImplementation(async () => [])
    app.ReadQueryFile.mockImplementation(async () => ({ content: '', connection_id: '' }))
    app.WriteQueryFile.mockImplementation(async () => {})
    app.DeleteQueryFile.mockImplementation(async () => {})
    // composable 的文件列表是模块级共享状态,测试间清空避免串扰。
    useQueryFiles({ connectionId: () => 'm1' }).files.value = []
    localStorage.setItem(QUERY_DIR_KEY, TEST_DIR)
    localStorage.removeItem(RESULTS_HEIGHT_KEY)
    document.body.innerHTML = ''
  })

  // --- 三层补全组装 -----------------------------------------------------------

  describe('三层补全组装', () => {
    it('挂载后拉表清单与 information_schema 列,组装成三层 schema 传给 SqlEditor', async () => {
      app.ListMysqlTables.mockResolvedValue([{ name: 'users' }, { name: 'orders' }])
      app.MysqlExecute.mockResolvedValue([
        {
          sql: 'information_schema',
          duration_ms: 2,
          columns: [
            { name: 'table_name', type: 'varchar' },
            { name: 'column_name', type: 'varchar' },
          ],
          rows: [
            ['users', 'id'],
            ['users', 'name'],
            ['orders', 'id'],
          ],
        },
      ])
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenCalledWith({ connection_id: 'm1', database: 'shop' })
      })
      await vi.waitFor(() => {
        expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([
          { name: 'users', columns: ['id', 'name'] },
          { name: 'orders', columns: ['id'] },
        ])
      })
      // 列清单来自只读系统表查询,库名以字符串字面量内插并按序返回。
      expect(app.MysqlExecute).toHaveBeenCalledWith(
        expect.objectContaining({
          connection_id: 'm1',
          sql: expect.stringContaining(
            'SELECT table_name, column_name FROM information_schema.columns WHERE table_schema = \'shop\' ORDER BY ordinal_position',
          ),
        }),
      )
      wrapper.unmount()
    })

    it('database 为空:先 SELECT DATABASE() 探测当前库,再按探测库组装列', async () => {
      app.MysqlExecute.mockImplementation(async (req: { sql: string }) => {
        if (req.sql.trim().toUpperCase() === 'SELECT DATABASE()') {
          return [
            {
              sql: req.sql,
              duration_ms: 1,
              columns: [{ name: 'DATABASE()', type: 'varchar' }],
              rows: [['shop2']],
            },
          ]
        }
        return [
          {
            sql: req.sql,
            duration_ms: 1,
            columns: [
              { name: 'table_name', type: 'varchar' },
              { name: 'column_name', type: 'varchar' },
            ],
            rows: [['users', 'id']],
          },
        ]
      })
      app.ListMysqlTables.mockResolvedValue([{ name: 'users' }])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1' } })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenCalledWith({ connection_id: 'm1', database: 'shop2' })
      })
      await vi.waitFor(() => {
        expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([{ name: 'users', columns: ['id'] }])
      })
      expect(app.MysqlExecute).toHaveBeenCalledWith(
        expect.objectContaining({ sql: expect.stringContaining("table_schema = 'shop2'") }),
      )
      wrapper.unmount()
    })

    it('SELECT DATABASE() 探测失败:降级为仅表名层(不查列)', async () => {
      app.MysqlExecute.mockRejectedValue(new Error('连接不可用'))
      app.ListMysqlTables.mockResolvedValue([{ name: 'users' }, { name: 'orders' }])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1' } })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenCalledWith({ connection_id: 'm1', database: '' })
      })
      await vi.waitFor(() => {
        expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([{ name: 'users' }, { name: 'orders' }])
      })
      wrapper.unmount()
    })

    it('库名含引号/反斜杠时转义后内插,API 入参保持原样', async () => {
      app.ListMysqlTables.mockResolvedValue([{ name: 't' }])
      app.MysqlExecute.mockImplementation(async (req: { sql: string }) => columnsQueryResult())
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: "sh'op\\" },
      })
      await vi.waitFor(() => {
        expect(app.MysqlExecute).toHaveBeenCalledWith(
          expect.objectContaining({ sql: expect.stringContaining("table_schema = 'sh\\'op\\\\'") }),
        )
      })
      expect(app.ListMysqlTables).toHaveBeenCalledWith({ connection_id: 'm1', database: "sh'op\\" })
      wrapper.unmount()
    })

    it('database prop 变化时重新拉取表清单与列', async () => {
      app.ListMysqlTables.mockResolvedValue([{ name: 'users' }])
      app.MysqlExecute.mockImplementation(async (req: { sql: string }) => columnsQueryResult())
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'a' },
      })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenLastCalledWith({ connection_id: 'm1', database: 'a' })
      })
      await wrapper.setProps({ database: 'b' })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenLastCalledWith({ connection_id: 'm1', database: 'b' })
      })
      wrapper.unmount()
    })
  })

  // --- 运行全部与逐条卡片 ------------------------------------------------------

  it('运行全部:整段脚本发给后端,出现 N 个结果 tab,Tab 条下只渲染 active 一张卡', async () => {
    app.MysqlExecute.mockImplementation(
      withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
    )
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1; SELECT bad', database: 'shop', limit: 500, offset: 0 })
    // Tab 条下方只渲染 active(第 0 个)一张卡:语句原文、耗时、列与行(NULL 单元格)。
    expect(resultTabEls(wrapper)).toHaveLength(2)
    expect(resultCards(wrapper)).toHaveLength(1)
    const card = resultCards(wrapper)[0]
    expect(card.props('statement')).toBe('SELECT 1')
    expect(card.props('durationMs')).toBe(12)
    expect(card.props('columns')).toEqual([{ name: 'one', type: 'int' }])
    expect(card.props('rows')).toEqual([['1'], [null]])
    expect(card.props('error')).toBeFalsy()
    // 点击第二个 tab:切换到错误结果卡。
    await selectTab(wrapper, 1)
    const card2 = resultCards(wrapper)[0]
    expect(card2.props('statement')).toBe('SELECT bad')
    expect(card2.props('error')).toBe('You have an error in your SQL syntax')
    wrapper.unmount()
  })

  it('导出交给 SqlResultCard:exportName 按语句序号命名为 mysql-result-<i>', async () => {
    app.MysqlExecute.mockImplementation(
      withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
    )
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(resultCards(wrapper)[0].props('exportName')).toBe('mysql-result-0')
    await selectTab(wrapper, 1)
    expect(resultCards(wrapper)[0].props('exportName')).toBe('mysql-result-1')
    wrapper.unmount()
  })

  it('运行全部按钮忽略选区,始终执行整段脚本', async () => {
    app.MysqlExecute.mockImplementation(
      withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT 2' ? twoResults() : [])),
    )
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    // 选中第二段 'SELECT 2'(10..18),运行全部仍发整段脚本。
    cmInput(wrapper).dispatch({ selection: { anchor: 10, head: 18 } })
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1; SELECT 2', database: 'shop', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  // --- ⌘Enter 执行当前语句 / ⌘Shift+Enter 运行全部 -----------------------------

  it('runs on Cmd/Ctrl+Enter pressed inside the CodeMirror editor', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1')
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1', database: 'shop', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  it('⌘Enter 无选区时只执行光标所在语句(结果只有一张卡)', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    // 显式把光标放回文档起始 → 执行第一条语句(split 文本含结尾分号)。
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 1 })
    await nextTick()
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1;', database: 'shop', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  it('⌘Enter 按 cursor emit 的最新位置定位语句', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    // 光标落在第二段 'SELECT bad' 内(offset 12 → 1 基 1 行 13 列)。
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 13 })
    await nextTick()
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT bad', database: 'shop', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  it('runs only the selection on Cmd+Enter as well', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    cmInput(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT 1', database: 'shop', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  it('⌘Shift+Enter 运行全部语句', async () => {
    app.MysqlExecute.mockImplementation(
      withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
    )
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await waitForTabs(wrapper, 2)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1; SELECT bad', database: 'shop', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  it('监听 SqlEditor 的 run-statement emit,按单语句逻辑执行', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    wrapper.findComponent(SqlEditor).vm.$emit('run-statement', 'SELECT bad')
    await waitForCards(wrapper, 1)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT bad', database: 'shop', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  // --- 结果区开合与拖拽 --------------------------------------------------------

  it('结果区初始关闭,运行后打开;点击 × 关闭回编辑器铺满,再运行重新打开', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="console-splitter"]').exists()).toBe(false)
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForCards(wrapper, 1)
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="console-splitter"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="results-close"]').exists()).toBe(true)
    // × 关闭:结果区与分隔条一并消失。
    await wrapper.find('[data-test="results-close"]').trigger('click')
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="console-splitter"]').exists()).toBe(false)
    // 再次执行(runAll 或单语句)重新打开结果区。
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForCards(wrapper, 1)
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('分隔条拖拽调整结果区高度并持久化,双击恢复 50/50,重挂载读取持久化高度', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
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
    const wrapper2 = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper2, 'SELECT 1')
    await wrapper2.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForCards(wrapper2, 1)
    expect((wrapper2.find('[data-test="results-pane"]').element as HTMLElement).style.height).toBe('384px')
    wrapper2.unmount()
  })

  // --- 语句状态标记 ------------------------------------------------------------

  it('发起时语句标记置 running,完成后按结果映射 ok/fail 与耗时/错误 detail', async () => {
    let resolveExec: (value: MysqlStatementResult[]) => void = () => {}
    app.MysqlExecute.mockImplementation(async (req: { sql: string }) => {
      if (req.sql.includes('information_schema.columns')) return columnsQueryResult()
      return new Promise<MysqlStatementResult[]>((resolve) => { resolveExec = resolve })
    })
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
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
    await waitForTabs(wrapper, 2)
    expect(editorComp.props('statementMarks')).toEqual([
      { from: 0, status: 'ok', detail: '12 ms' },
      { from: 10, status: 'fail', detail: 'You have an error in your SQL syntax' },
    ])
    wrapper.unmount()
  })

  it('编辑器内容变化后按语句文本重新匹配 marks,匹配不到的丢弃', async () => {
    app.MysqlExecute.mockImplementation(
      withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
    )
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    // 改写第一条语句文本 → 其标记被丢弃;第二条文本未变 → 标记保留并重定位
    // ('SELECT 42;' 比 'SELECT 1;' 长 1 字符,第二段 from 随之变为 11)。
    await typeSql(wrapper, 'SELECT 42; SELECT bad')
    await nextTick()
    expect(wrapper.findComponent(SqlEditor).props('statementMarks')).toEqual([
      { from: 11, status: 'fail', detail: 'You have an error in your SQL syntax' },
    ])
    wrapper.unmount()
  })

  // --- 空态与状态栏 ------------------------------------------------------------

  it('结果区打开但无结果时显示快捷键引导空态卡', async () => {
    app.MysqlExecute.mockImplementation(withSystemGuard(async () => []))
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
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
    app.MysqlExecute.mockImplementation(
      withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
    )
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    const bar = () => wrapper.find('[data-test="console-statusbar"]')
    expect(bar().text()).toContain('行 1 : 列 1')
    expect(bar().text()).toContain('语句 0 条')
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    expect(bar().text()).toContain('语句 2 条')
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 3, col: 5 })
    await nextTick()
    expect(bar().text()).toContain('行 3 : 列 5')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    // 最近耗时 = 最近一次运行各语句耗时之和(12 + 3)。
    expect(bar().text()).toContain('最近耗时 15 ms')
    wrapper.unmount()
  })

  // --- ⌘S 保存全链路 -----------------------------------------------------------

  it('opens the save-name prompt on Cmd/Ctrl+S when no file is open, and cancel writes nothing', async () => {
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
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

  it('saves the editor content as a new query file via the exposed requestSave and refreshes the list', async () => {
    app.ListQueryFiles.mockResolvedValue(queryFiles())
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
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
        connection_id: 'm1',
        database: 'shop',
      })
    })
    // 写入后刷新列表,新文件成为当前打开文件。
    await vi.waitFor(() => {
      expect(app.ListQueryFiles.mock.calls.length).toBeGreaterThan(listCallsBaseline)
    })
    expect(vm.currentFile()).toBe('新文件.sql')
    wrapper.unmount()
  })

  it('overwrites the open file directly on Ctrl+S without prompting', async () => {
    app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'm1' })
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
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
        connection_id: 'm1',
        database: 'shop',
      })
    })
    // 已关联文件 → 直接覆盖,不弹名称输入。
    expect(bodyEl('prompt-dialog')).toBeNull()
    wrapper.unmount()
  })

  // --- 当前库选择器:切换 / 执行带库 / 查询文件记忆库 ---------------------------

  describe('当前库选择器', () => {
    it('命令条渲染选择器,初值为 props.database,选项来自 ListMysqlDatabases', async () => {
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await vi.waitFor(() => {
        expect(app.ListMysqlDatabases).toHaveBeenCalledWith('m1')
      })
      const select = wrapper.find('[data-test="mysql-db-select"]')
      expect(select.exists()).toBe(true)
      await vi.waitFor(() => {
        expect((select.element as HTMLSelectElement).value).toBe('shop')
      })
      // 后端返回的库清单都在选项里(含当前库)。
      const values = Array.from((select.element as HTMLSelectElement).options).map((o) => o.value)
      expect(values).toContain('shop')
      expect(values).toContain('orders')
      wrapper.unmount()
    })

    it('ListMysqlDatabases 失败:静默为空,选择器仍可用且当前库动态补进选项', async () => {
      app.ListMysqlDatabases.mockRejectedValue(new Error('网络错误'))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await vi.waitFor(() => {
        expect(app.ListMysqlDatabases).toHaveBeenCalled()
      })
      const select = wrapper.find('[data-test="mysql-db-select"]')
      expect(select.exists()).toBe(true)
      expect((select.element as HTMLSelectElement).value).toBe('shop')
      wrapper.unmount()
    })

    it('切换库 → ListMysqlTables 以新库重拉三层补全', async () => {
      app.ListMysqlTables.mockResolvedValue([{ name: 'users' }])
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenCalledWith({ connection_id: 'm1', database: 'shop' })
      })
      // 等选项渲染完成再切换:setValue 依赖 option 存在,否则 value 归空误切。
      await vi.waitFor(() => {
        const select = wrapper.find('[data-test="mysql-db-select"]').element as HTMLSelectElement
        expect(Array.from(select.options).some((o) => o.value === 'orders')).toBe(true)
      })
      await wrapper.find('[data-test="mysql-db-select"]').setValue('orders')
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenLastCalledWith({ connection_id: 'm1', database: 'orders' })
      })
      wrapper.unmount()
    })

    it('⌘Enter 执行 payload 携带当前库 database', async () => {
      app.MysqlExecute.mockImplementation(withSystemGuard(echoResult))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT 1')
      pressRunShortcut(wrapper)
      await waitForCards(wrapper, 1)
      expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1', database: 'shop', limit: 500, offset: 0 })
      wrapper.unmount()
    })

    it('⌘S 保存 WriteQueryFile payload 携带当前库 database', async () => {
      app.ListQueryFiles.mockResolvedValue(queryFiles())
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT 42')
      exposedApi(wrapper).requestSave()
      await vi.waitFor(() => {
        expect(bodyEl('prompt-dialog')).not.toBeNull()
      })
      await confirmPrompt('新文件.sql')
      await vi.waitFor(() => {
        expect(app.WriteQueryFile).toHaveBeenCalledWith({
          dir: TEST_DIR,
          name: '新文件.sql',
          content: 'SELECT 42',
          connection_id: 'm1',
          database: 'shop',
        })
      })
      wrapper.unmount()
    })

    // 回归:同名覆盖保存成功后,再点右栏同一文件不得误弹「当前 SQL 未保存,
    // 载入将替换?」——保存成功必须把脏检查快照对齐到刚保存的内容。
    it('同名覆盖保存后再次载入同一文件不弹未保存确认', async () => {
      app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'm1', database: 'shop' })
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      // 打开已关联文件「166[总控].sql」:编辑器与快照都是 SELECT 1。
      exposedApi(wrapper).loadQueryFile('166[总控]')
      await vi.waitFor(() => {
        expect(exposedApi(wrapper).currentFile()).toBe('166[总控].sql')
      })
      // 编辑后同名覆盖保存(⌘S 路径,currentFile 不变)。
      await typeSql(wrapper, 'SELECT 42')
      exposedApi(wrapper).requestSave()
      await vi.waitFor(() => {
        expect(app.WriteQueryFile).toHaveBeenCalledWith(
          expect.objectContaining({ name: '166[总控].sql', content: 'SELECT 42' }),
        )
      })
      await vi.waitFor(() => {
        expect(app.ListQueryFiles).toHaveBeenCalled()
      })
      // 再次点击右栏同一文件:不弹确认,直接重新载入(ReadQueryFile 第二次调用)。
      const readsBefore = app.ReadQueryFile.mock.calls.length
      exposedApi(wrapper).loadQueryFile('166[总控]')
      await vi.waitFor(() => {
        expect(app.ReadQueryFile.mock.calls.length).toBeGreaterThan(readsBefore)
      })
      expect(bodyEl('confirm-dialog')).toBeNull()
      wrapper.unmount()
    })

    it('载入文件头带库的 .sql → 选择器切到该库并重拉补全', async () => {
      app.ListMysqlTables.mockResolvedValue([{ name: 'users' }])
      app.MysqlExecute.mockImplementation(async (req: { sql: string }) => columnsQueryResult())
      app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'm1', database: 'orders' })
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenLastCalledWith({ connection_id: 'm1', database: 'shop' })
      })
      exposedApi(wrapper).loadQueryFile('每日报表.sql')
      await vi.waitFor(() => {
        const select = wrapper.find('[data-test="mysql-db-select"]').element as HTMLSelectElement
        expect(select.value).toBe('orders')
      })
      await vi.waitFor(() => {
        expect(app.ListMysqlTables).toHaveBeenLastCalledWith({ connection_id: 'm1', database: 'orders' })
      })
      wrapper.unmount()
    })

    it('载入未关联库(database 为空串)的文件 → 保持当前库不误切', async () => {
      app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'm1', database: '' })
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      exposedApi(wrapper).loadQueryFile('每日报表.sql')
      await vi.waitFor(() => {
        expect(exposedApi(wrapper).currentFile()).toBe('每日报表.sql')
      })
      await flushPromises()
      const select = wrapper.find('[data-test="mysql-db-select"]').element as HTMLSelectElement
      expect(select.value).toBe('shop')
      // 载入未触发重拉:最后一次 ListMysqlTables 仍是挂载时的 shop。
      expect(app.ListMysqlTables).toHaveBeenLastCalledWith({ connection_id: 'm1', database: 'shop' })
      wrapper.unmount()
    })
  })

  // --- tab 标题跟随当前打开的 SQL 文件 ----------------------------------------

  describe('tab 标题跟随当前 SQL 文件', () => {
    function mountWithTitleTab() {
      // 预置 id 为 'm-tab1' 的 tab,标题为默认值(kind 按契约将由 B 扩展)。
      const tabsStore = useTabsStore()
      tabsStore.openTabs.push({
        id: 'm-tab1',
        kind: 'mysql-sql',
        title: 'SQL 控制台',
        connectionId: 'm1',
      } as unknown as Tab)
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1' } })
      return { wrapper, tabsStore }
    }

    it('载入文件后 tab 标题变为文件名', async () => {
      app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'm1' })
      const { wrapper, tabsStore } = mountWithTitleTab()
      expect(tabsStore.openTabs[0].title).toBe('SQL 控制台')
      exposedApi(wrapper).loadQueryFile('每日报表.sql')
      await vi.waitFor(() => {
        expect(tabsStore.openTabs[0].title).toBe('每日报表.sql')
      })
      wrapper.unmount()
    })

    it('删除当前文件后回退默认标题「SQL 控制台」', async () => {
      app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'm1' })
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

  // --- 草稿恢复与持久化:切 tab 销毁重建后内容/文件关联不丢 --------------------

  describe('草稿恢复与持久化(切 tab 不丢内容)', () => {
    function mountWithDraftTab(draft?: { sql: string; file: string | null; database?: string }) {
      const tabsStore = useTabsStore()
      tabsStore.openTabs.push({
        id: 'm-tab1',
        kind: 'mysql-sql',
        title: 'SQL 控制台',
        connectionId: 'm1',
        database: 'shop',
        draft,
      })
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      return { wrapper, tabsStore }
    }

    it('挂载时从 tab draft 恢复编辑器内容与文件关联,标题跟随文件名,不读盘', async () => {
      const { wrapper, tabsStore } = mountWithDraftTab({ sql: 'SELECT draft', file: '草稿.sql' })
      await vi.waitFor(() => {
        expect(cmInput(wrapper).state.doc.toString()).toBe('SELECT draft')
      })
      expect(tabsStore.openTabs[0].title).toBe('草稿.sql')
      // 恢复只重建文件关联,不走载入链路。
      expect(app.ReadQueryFile).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('无 draft 的 tab 挂载行为不变(空编辑器、默认标题)', () => {
      const { wrapper, tabsStore } = mountWithDraftTab()
      expect(cmInput(wrapper).state.doc.toString()).toBe('')
      expect(tabsStore.openTabs[0].title).toBe('SQL 控制台')
      wrapper.unmount()
    })

    it('编辑内容写回 tab draft,文件关联同步持久化', async () => {
      const { wrapper, tabsStore } = mountWithDraftTab()
      await typeSql(wrapper, 'SELECT 42')
      await vi.waitFor(() => {
        expect(tabsStore.openTabs[0].draft).toEqual({ sql: 'SELECT 42', file: null, database: 'shop' })
      })
      wrapper.unmount()
    })

    // 回归:从 SQL 文件打开的控制台未关联库,手动选择库后切 tab,库选择不得
    // 退回「连接默认数据库」(否则查询因无库上下文报错)。
    it('挂载时恢复 draft 中的库选择,切库后写回 draft', async () => {
      const { wrapper, tabsStore } = mountWithDraftTab({
        sql: 'SELECT 1',
        file: null,
        database: 'orders',
      })
      await vi.waitFor(() => {
        // 挂载补全按恢复的库加载。
        expect(app.ListMysqlTables).toHaveBeenLastCalledWith({ connection_id: 'm1', database: 'orders' })
      })
      const select = wrapper.find('[data-test="mysql-db-select"]')
      expect((select.element as HTMLSelectElement).value).toBe('orders')
      // 库清单异步加载完成后再切库,避免 option 缺失导致选值落空。
      await vi.waitFor(() => {
        expect(select.findAll('option').length).toBeGreaterThanOrEqual(2)
      })
      // 切库后写回 draft.database。
      await select.setValue('shop')
      await vi.waitFor(() => {
        expect(tabsStore.openTabs[0].draft?.database).toBe('shop')
      })
      wrapper.unmount()
    })
  })

  // --- 查询结果行内编辑(仅单表 SELECT 结果可编辑) ---------------------------
  // 编辑 UI 由 SqlResultCard 渲染:双击/提交/取消经卡片事件进入组件状态机,
  // 预览→确认→执行链路不变(确认弹窗仍由本组件渲染)。判定逻辑
  // (parseCHSingleTableSelect)用真实实现,只 mock wailsjs 绑定。
  describe('结果编辑', () => {
    // 单表 SELECT 结果:4 列,首行含 NULL(note)以便覆盖 NULL 原值构造。
    const singleTableSelect = (sql = 'SELECT * FROM users WHERE id = 1 LIMIT 10'): MysqlStatementResult => ({
      sql,
      duration_ms: 5,
      columns: [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'varchar' },
        { name: 'age', type: 'int' },
        { name: 'note', type: 'varchar' },
      ],
      rows: [['1', 'alice', '30', null]],
    })

    async function mountWithResults(results: MysqlStatementResult[]): Promise<VueWrapper> {
      app.MysqlExecute.mockImplementation(withSystemGuard(async () => results))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, results.map((r) => r.sql).join('; '))
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
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
      const wrapper = await mountWithResults([singleTableSelect('SELECT * FROM shop.users WHERE id = 1 LIMIT 10')])
      expect(resultCards(wrapper)[0].props('insertTarget')).toEqual({ database: 'shop', table: 'users' })
      wrapper.unmount()
      const join: MysqlStatementResult = {
        sql: 'SELECT a.id FROM users a JOIN orders b ON a.uid = b.id',
        duration_ms: 1,
        columns: [{ name: 'id', type: 'int' }],
        rows: [['x']],
      }
      const wrapper2 = await mountWithResults([join])
      expect(resultCards(wrapper2)[0].props('insertTarget')).toBeNull()
      wrapper2.unmount()
    })

    it('cell-dblclick 进入编辑(editing 含原值草稿),edit-commit 发起预览', async () => {
      const wrapper = await mountWithResults([singleTableSelect('SELECT * FROM shop.users WHERE id = 1 LIMIT 10')])
      const card = resultCards(wrapper)[0]
      card.vm.$emit('cell-dblclick', 0, 1)
      await nextTick()
      expect(card.props('editing')).toEqual({ row: 0, col: 1, draft: 'alice' })
      card.vm.$emit('edit-commit', 'carol')
      await vi.waitFor(() => {
        expect(app.MysqlPreviewCellUpdate).toHaveBeenCalledTimes(1)
      })
      expect(app.MysqlPreviewCellUpdate).toHaveBeenCalledWith({
        connection_id: 'm1',
        database: 'shop',
        table: 'users',
        set: { column: 'name', value: 'carol' },
        where: [
          { column: 'id', value: '1' },
          { column: 'name', value: 'alice' },
          { column: 'age', value: '30' },
          { column: 'note', value: null },
        ],
      })
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog-message')?.textContent).toContain('匹配 1 行')
      })
      wrapper.unmount()
    })

    it('空输入提交按 NULL 写入', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      await editAndSubmit(wrapper, '')
      expect(app.MysqlPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ set: { column: 'id', value: null } }),
      )
      wrapper.unmount()
    })

    it('匹配多行时确认弹窗追加警示并置危险按钮', async () => {
      app.MysqlPreviewCellUpdate.mockResolvedValue({
        statement: 'UPDATE `users` SET `name` = \'x\' WHERE `age` = \'30\'',
        matched_rows: 3,
      })
      const wrapper = await mountWithResults([singleTableSelect()])
      await editAndSubmit(wrapper, 'x')
      const msg = bodyEl('confirm-dialog-message')?.textContent ?? ''
      expect(msg).toContain('匹配 3 行')
      expect(msg).toContain('命中 3 行')
      expect((bodyEl('confirm-dialog-ok') as HTMLElement).className).toContain('danger')
      wrapper.unmount()
    })

    it('结果携带主键时 where 仅含主键列原值(整行不再参与定位)', async () => {
      const withPk = { ...singleTableSelect('SELECT * FROM shop.users WHERE id = 1 LIMIT 10'), primary_key: ['id'] }
      const wrapper = await mountWithResults([withPk])
      await startEdit(wrapper, 0, 0, 1)
      resultCards(wrapper)[0].vm.$emit('edit-commit', 'carol')
      await vi.waitFor(() => {
        expect(app.MysqlPreviewCellUpdate).toHaveBeenCalledTimes(1)
      })
      expect(app.MysqlPreviewCellUpdate).toHaveBeenCalledWith({
        connection_id: 'm1',
        database: 'shop',
        table: 'users',
        set: { column: 'name', value: 'carol' },
        where: [{ column: 'id', value: '1' }],
      })
      wrapper.unmount()
    })

    it('匹配 0 行:弹窗提示未命中并禁用执行,点击不落库', async () => {
      app.MysqlPreviewCellUpdate.mockResolvedValue({
        statement: 'UPDATE `users` SET `name` = \'x\' WHERE `id` = \'1\'',
        matched_rows: 0,
      })
      const wrapper = await mountWithResults([singleTableSelect()])
      await editAndSubmit(wrapper, 'x')
      const msg = bodyEl('confirm-dialog-message')?.textContent ?? ''
      expect(msg).toContain('匹配 0 行')
      expect(msg).toContain('未命中任何行,数据可能已被修改或不存在')
      const okBtn = bodyEl('confirm-dialog-ok') as HTMLButtonElement
      expect(okBtn.disabled).toBe(true)
      okBtn.click()
      await new Promise((r) => setTimeout(r, 0))
      expect(app.MysqlUpdateCell).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('确认后执行 MysqlUpdateCell 并重跑该条语句原位替换结果,其他语句不受影响', async () => {
      const first = singleTableSelect()
      const second: MysqlStatementResult = {
        sql: 'SELECT 42',
        duration_ms: 1,
        columns: [{ name: 'answer', type: 'int' }],
        rows: [['42']],
      }
      app.MysqlExecute.mockImplementation(
        withSystemGuard(async (req) => {
          // 重跑该条语句:返回更新后的行(编辑的是第 1 列 id)。
          if (req.sql === first.sql) return [{ ...first, rows: [['b', 'alice', '30', null]] }]
          if (req.sql === `${first.sql}; ${second.sql}`) return [first, second]
          return []
        }),
      )
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, `${first.sql}; ${second.sql}`)
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      await editAndSubmit(wrapper, 'b')
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(app.MysqlUpdateCell).toHaveBeenCalledTimes(1)
      })
      // 刷新入参是该条语句的原文(而非整段脚本)。
      await vi.waitFor(() => {
        expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: first.sql, database: 'shop', limit: 500, offset: 0 })
      })
      // 第一条结果被替换为刷新后的行;第二条结果保持原样(切 tab 查看)。
      await vi.waitFor(() => {
        expect(resultCards(wrapper)[0].props('rows')).toEqual([['b', 'alice', '30', null]])
      })
      await selectTab(wrapper, 1)
      expect(resultCards(wrapper)[0].props('rows')).toEqual([['42']])
      wrapper.unmount()
    })

    it('JOIN / GROUP BY 结果只读:cell-dblclick 不进入编辑也不发起预览', async () => {
      const join: MysqlStatementResult = {
        sql: 'SELECT a.id FROM users a JOIN orders b ON a.uid = b.id',
        duration_ms: 1,
        columns: [{ name: 'id', type: 'int' }],
        rows: [['x']],
      }
      const group: MysqlStatementResult = {
        sql: 'SELECT status, count(*) FROM users GROUP BY status',
        duration_ms: 1,
        columns: [
          { name: 'status', type: 'varchar' },
          { name: 'count(*)', type: 'bigint' },
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
      expect(app.MysqlPreviewCellUpdate).not.toHaveBeenCalled()
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
      expect(app.MysqlPreviewCellUpdate).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('取消确认弹窗不执行更新', async () => {
      const wrapper = await mountWithResults([singleTableSelect()])
      await editAndSubmit(wrapper, 'b')
      ;(bodyEl('confirm-dialog-cancel') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).toBeNull()
      })
      expect(app.MysqlUpdateCell).not.toHaveBeenCalled()
      // 结果保持原值。
      expect(resultCards(wrapper)[0].props('rows')).toEqual([['1', 'alice', '30', null]])
      wrapper.unmount()
    })

    it('更新失败时展示错误且不重跑查询', async () => {
      app.MysqlUpdateCell.mockRejectedValue(new Error('模拟更新失败'))
      const wrapper = await mountWithResults([singleTableSelect()])
      const execCalls = app.MysqlExecute.mock.calls.length
      await editAndSubmit(wrapper, 'b')
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="mysql-sql-error"]').text()).toContain('模拟更新失败')
      })
      expect(app.MysqlExecute.mock.calls.length).toBe(execCalls)
      wrapper.unmount()
    })

    it('预览失败时展示错误且不打开确认弹窗', async () => {
      app.MysqlPreviewCellUpdate.mockRejectedValue(new Error('预览失败'))
      const wrapper = await mountWithResults([singleTableSelect()])
      await startEdit(wrapper, 0, 0, 0)
      resultCards(wrapper)[0].vm.$emit('edit-commit', 'b')
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="mysql-sql-error"]').text()).toContain('预览失败')
      })
      expect(bodyEl('confirm-dialog')).toBeNull()
      expect(app.MysqlUpdateCell).not.toHaveBeenCalled()
      wrapper.unmount()
    })
  })

  describe('删除行(单表 SELECT + 主键)', () => {
    // 可删除结果:主键 id + 后端回传的来源库/表,两行数据。
    const deletableSelect = (sql = 'SELECT * FROM users WHERE id = 1 LIMIT 10'): MysqlStatementResult => ({
      sql,
      duration_ms: 5,
      columns: [
        { name: 'id', type: 'int' },
        { name: 'name', type: 'varchar' },
      ],
      rows: [
        ['1', 'alice'],
        ['2', 'bob'],
      ],
      primary_key: ['id'],
      source_database: 'shop',
      source_table: 'users',
    })

    async function mountWithResults(results: MysqlStatementResult[]): Promise<VueWrapper> {
      app.MysqlExecute.mockImplementation(withSystemGuard(async () => results))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, results.map((r) => r.sql).join('; '))
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, results.length)
      return wrapper
    }

    // 行首删除按钮(active 卡内)。
    function rowDeleteBtns(wrapper: VueWrapper) {
      return resultCards(wrapper)[0].findAll('[data-test="btn-row-delete"]')
    }

    async function openDeleteConfirm(wrapper: VueWrapper, row = 0): Promise<void> {
      await rowDeleteBtns(wrapper)[row].trigger('click')
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).not.toBeNull()
      })
    }

    it('启用判定:有主键+来源表的行可删;无主键与非单表结果禁用并给原因', async () => {
      const wrapper = await mountWithResults([deletableSelect()])
      const ok = rowDeleteBtns(wrapper)[0]
      expect(ok.attributes('disabled')).toBeUndefined()
      expect(ok.attributes('title')).toBe('删除该行')
      wrapper.unmount()

      const noPk: MysqlStatementResult = {
        ...deletableSelect('SELECT * FROM logs'),
        primary_key: [],
        source_table: 'logs',
      }
      const wrapper2 = await mountWithResults([noPk])
      const b2 = rowDeleteBtns(wrapper2)[0]
      expect(b2.attributes('disabled')).toBeDefined()
      expect(b2.attributes('title')).toBe('该表无主键,无法定位行')
      wrapper2.unmount()

      const join: MysqlStatementResult = {
        sql: 'SELECT a.id FROM users a JOIN orders b ON a.uid = b.id',
        duration_ms: 1,
        columns: [{ name: 'id', type: 'int' }],
        rows: [['x']],
      }
      const wrapper3 = await mountWithResults([join])
      const b3 = rowDeleteBtns(wrapper3)[0]
      expect(b3.attributes('disabled')).toBeDefined()
      expect(b3.attributes('title')).toBe('仅单表查询可删除:无法定位来源表')
      await b3.trigger('click')
      expect(app.MysqlPreviewDeleteRow).not.toHaveBeenCalled()
      wrapper3.unmount()
    })

    it('点击删除:预览 where 仅含主键列原值,弹窗展示 DELETE 全文与命中行数', async () => {
      app.MysqlPreviewDeleteRow.mockResolvedValue({
        statement: "DELETE FROM `shop`.`users` WHERE `id` = '2'",
        matched_rows: 1,
      })
      const wrapper = await mountWithResults([deletableSelect()])
      await openDeleteConfirm(wrapper, 1)
      expect(app.MysqlPreviewDeleteRow).toHaveBeenCalledTimes(1)
      expect(app.MysqlPreviewDeleteRow).toHaveBeenCalledWith({
        connection_id: 'm1',
        database: 'shop',
        table: 'users',
        where: [{ column: 'id', value: '2' }],
      })
      const msg = bodyEl('confirm-dialog-message')?.textContent ?? ''
      expect(msg).toContain("DELETE FROM `shop`.`users` WHERE `id` = '2'")
      expect(msg).toContain('匹配 1 行')
      wrapper.unmount()
    })

    it('命中多行:弹窗警示且确认按钮禁用,点击不执行', async () => {
      app.MysqlPreviewDeleteRow.mockResolvedValue({
        statement: "DELETE FROM `shop`.`users` WHERE `age` = '30'",
        matched_rows: 3,
      })
      const wrapper = await mountWithResults([deletableSelect()])
      await openDeleteConfirm(wrapper)
      const msg = bodyEl('confirm-dialog-message')?.textContent ?? ''
      expect(msg).toContain('命中 3 行')
      expect(msg).toContain('已禁止执行')
      const okBtn = bodyEl('confirm-dialog-ok') as HTMLButtonElement
      expect(okBtn.disabled).toBe(true)
      okBtn.click()
      await new Promise((r) => setTimeout(r, 0))
      expect(app.MysqlDeleteRow).not.toHaveBeenCalled()
      wrapper.unmount()
    })

    it('确认后执行 MysqlDeleteRow 并重跑该条语句原位替换结果,其他语句不受影响', async () => {
      const first = deletableSelect()
      const second: MysqlStatementResult = {
        sql: 'SELECT 42',
        duration_ms: 1,
        columns: [{ name: 'answer', type: 'int' }],
        rows: [['42']],
      }
      app.MysqlExecute.mockImplementation(
        withSystemGuard(async (req) => {
          // 重跑该条语句:返回删除 id=1 后的行集。
          if (req.sql === first.sql) return [{ ...first, rows: [['2', 'bob']] }]
          if (req.sql === `${first.sql}; ${second.sql}`) return [first, second]
          return []
        }),
      )
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, `${first.sql}; ${second.sql}`)
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      await openDeleteConfirm(wrapper)
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(app.MysqlDeleteRow).toHaveBeenCalledTimes(1)
      })
      expect(app.MysqlDeleteRow).toHaveBeenCalledWith({
        connection_id: 'm1',
        database: 'shop',
        table: 'users',
        where: [{ column: 'id', value: '1' }],
      })
      // 刷新入参是该条语句的原文(而非整段脚本)。
      await vi.waitFor(() => {
        expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: first.sql, database: 'shop', limit: 500, offset: 0 })
      })
      await vi.waitFor(() => {
        expect(resultCards(wrapper)[0].props('rows')).toEqual([['2', 'bob']])
      })
      await selectTab(wrapper, 1)
      expect(resultCards(wrapper)[0].props('rows')).toEqual([['42']])
      wrapper.unmount()
    })

    it('第 2 页删除后按同页 offset 刷新', async () => {
      const paged = { ...deletableSelect(), total_rows: 1000 }
      app.MysqlExecute.mockImplementation(withSystemGuard(async () => [paged]))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, paged.sql)
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      await wrapper.find('[data-test="pager-next"]').trigger('click')
      await vi.waitFor(() => {
        expect(app.MysqlExecute).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 500 }))
      })
      await openDeleteConfirm(wrapper)
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(app.MysqlDeleteRow).toHaveBeenCalledTimes(1)
      })
      // 刷新保持在第 2 页(offset=500),不跳回首页。
      await vi.waitFor(() => {
        expect(app.MysqlExecute).toHaveBeenLastCalledWith(expect.objectContaining({ sql: paged.sql, offset: 500 }))
      })
      wrapper.unmount()
    })

    it('删除失败:错误展示且弹窗保持打开,不刷新查询', async () => {
      app.MysqlDeleteRow.mockRejectedValue(new Error('模拟删除失败'))
      const wrapper = await mountWithResults([deletableSelect()])
      const execCalls = app.MysqlExecute.mock.calls.length
      await openDeleteConfirm(wrapper)
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="mysql-sql-error"]').text()).toContain('模拟删除失败')
      })
      expect(app.MysqlExecute.mock.calls.length).toBe(execCalls)
      wrapper.unmount()
    })

    it('取消确认弹窗不执行删除', async () => {
      const wrapper = await mountWithResults([deletableSelect()])
      await openDeleteConfirm(wrapper)
      ;(bodyEl('confirm-dialog-cancel') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(bodyEl('confirm-dialog')).toBeNull()
      })
      expect(app.MysqlDeleteRow).not.toHaveBeenCalled()
      expect(resultCards(wrapper)[0].props('rows')).toEqual(deletableSelect().rows)
      wrapper.unmount()
    })

    it('预览失败时展示错误且不打开确认弹窗', async () => {
      app.MysqlPreviewDeleteRow.mockRejectedValue(new Error('模拟预览失败'))
      const wrapper = await mountWithResults([deletableSelect()])
      await rowDeleteBtns(wrapper)[0].trigger('click')
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="mysql-sql-error"]').text()).toContain('模拟预览失败')
      })
      expect(bodyEl('confirm-dialog')).toBeNull()
      expect(app.MysqlDeleteRow).not.toHaveBeenCalled()
      wrapper.unmount()
    })
  })

  // --- 结果 Tab 条 + 右键执行菜单 ------------------------------------------------

  describe('结果 Tab 条', () => {
    it('多语句运行出现 N 个 tab,标签取语句前置注释文本', async () => {
      app.MysqlExecute.mockImplementation(withSystemGuard(async () => twoResults()))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, '-- 查询员工总数\nSELECT 1;\n-- 第二条:错误示例\nSELECT bad')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      const tabs = resultTabEls(wrapper)
      expect(tabs[0].text()).toContain('查询员工总数')
      expect(tabs[1].text()).toContain('第二条:错误示例')
      wrapper.unmount()
    })

    it('无前置注释的语句回退「结果 N」,运行全部后 active 指向第 0 个 tab', async () => {
      app.MysqlExecute.mockImplementation(
        withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
      )
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
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
      app.MysqlExecute.mockImplementation(
        withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
      )
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      await selectTab(wrapper, 1)
      const tabs = resultTabEls(wrapper)
      expect(tabs[1].classes()).toContain('active')
      expect(tabs[0].classes()).not.toContain('active')
      expect(resultCards(wrapper)).toHaveLength(1)
      expect(resultCards(wrapper)[0].props('statement')).toBe('SELECT bad')
      wrapper.unmount()
    })

    it('失败 tab 状态:错误语句 tab 状态点为 fail,成功为 ok', async () => {
      app.MysqlExecute.mockImplementation(
        withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
      )
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      const tabs = resultTabEls(wrapper)
      expect(tabs[0].find('.tab-dot.ok').exists()).toBe(true)
      expect(tabs[1].find('.tab-dot.fail').exists()).toBe(true)
      wrapper.unmount()
    })

    it('整段运行链路抛错时全部 tab 置 fail', async () => {
      app.MysqlExecute.mockRejectedValue(new Error('连接已断开'))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT 1; SELECT 2')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      for (const t of resultTabEls(wrapper)) {
        expect(t.find('.tab-dot.fail').exists()).toBe(true)
      }
      wrapper.unmount()
    })

    it('Mysql 卡透传 selectable=true 与结果携带的 primary_key(缺省回退空数组)', async () => {
      const withPk: MysqlStatementResult = {
        sql: 'SELECT * FROM users WHERE id = 1 LIMIT 10',
        duration_ms: 5,
        columns: [{ name: 'id', type: 'int' }],
        rows: [['1']],
        primary_key: ['id'],
      }
      app.MysqlExecute.mockImplementation(withSystemGuard(async () => [withPk]))
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT * FROM users WHERE id = 1 LIMIT 10')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      const card = resultCards(wrapper)[0]
      expect(card.props('selectable')).toBe(true)
      expect(card.props('primaryKey')).toEqual(['id'])
      // 无主键结果:primaryKey 回退空数组,selectable 仍开启(由卡片内部降级)。
      app.MysqlExecute.mockImplementation(withSystemGuard(async () => [
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'one', type: 'int' }], rows: [['1']] },
      ]))
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(resultCards(wrapper)[0].props('primaryKey')).toEqual([])
      wrapper.unmount()
    })
  })

  describe('右键执行菜单接线', () => {
    it('SqlEditor 开启 enable-run-menu', async () => {
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      expect(wrapper.findComponent(SqlEditor).props('enableRunMenu')).toBe(true)
      wrapper.unmount()
    })

    it('三个菜单入口分别触发:选中语句 / 当前语句 / 运行全部', async () => {
      // 单段执行回声一条;整段脚本(运行全部)回两条,供 tab 数断言。
      app.MysqlExecute.mockImplementation(
        withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : echoResult(req))),
      )
      const wrapper = mount(MysqlSqlConsole, {
        props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
      })
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      // 选中第一条 'SELECT 1'(0..8)→ 右键「执行选中语句」按整段选中文本执行。
      cmInput(wrapper).dispatch({ selection: { anchor: 0, head: 8 } })
      await openRunMenu(wrapper)
      expect(wrapper.find('[data-test="menu-run-selection"]').exists()).toBe(true)
      await wrapper.find('[data-test="menu-run-selection"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT 1', database: 'shop', limit: 500, offset: 0 })
      // 无选区右键 →「执行当前语句」:执行光标所在语句(第 2 段)。
      await typeSql(wrapper, 'SELECT 1; SELECT bad')
      wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 13 })
      await nextTick()
      await openRunMenu(wrapper)
      await wrapper.find('[data-test="menu-run-current"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT bad', database: 'shop', limit: 500, offset: 0 })
      // 「运行全部」→ 整段脚本交给后端。
      await openRunMenu(wrapper)
      await wrapper.find('[data-test="menu-run-all"]').trigger('click')
      await waitForTabs(wrapper, 2)
      expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT 1; SELECT bad', database: 'shop', limit: 500, offset: 0 })
      wrapper.unmount()
    })
  })

  // --- 结果区分页(服务端分页,默认 500 条/页) ---------------------------------

  describe('结果区分页', () => {
    const pagedRows = (n: number) => Array.from({ length: n }, (_, i) => [String(i)])

    it('新查询请求带 limit=500&offset=0,精确总数显示「共 N 条 · 第 p/last 页」', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: pagedRows(500), total_rows: 1234 },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'SELECT 1')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT 1', database: 'shop', limit: 500, offset: 0 })
      expect(wrapper.find('[data-test="pager-info"]').text()).toBe('共 1,234 条 · 第 1/3 页')
      wrapper.unmount()
    })

    it('下一页以 offset=500 重放上次脚本,上一页回到 offset=0;翻页不受编辑器影响', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: pagedRows(500), total_rows: -1 },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'SELECT 1')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(wrapper.find('[data-test="pager-info"]').text()).toBe('至少 500 条 · 第 1 页')
      await wrapper.find('[data-test="pager-next"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT 1', database: 'shop', limit: 500, offset: 500 })
      await typeSql(wrapper, 'SELECT 2')
      await wrapper.find('[data-test="pager-prev"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT 1', database: 'shop', limit: 500, offset: 0 })
      wrapper.unmount()
    })

    it('下一页禁用:所有行结果行数都小于每页 500 条', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: [['1']], total_rows: 1 },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'SELECT 1')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect((wrapper.find('[data-test="pager-next"]').element as HTMLButtonElement).disabled).toBe(true)
      expect((wrapper.find('[data-test="pager-prev"]').element as HTMLButtonElement).disabled).toBe(true)
      wrapper.unmount()
    })

    it('fake 结果无 total_rows:显示「第 x-y 条」,不报错', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: [['1'], ['2']] },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'SELECT 1')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(wrapper.find('[data-test="pager-info"]').text()).toBe('第 1-2 条')
      wrapper.unmount()
    })

    it('脚本含 DML(UPDATE …; SELECT …)时隐藏分页条,避免翻页重放重复写库', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'UPDATE t SET x = x + 1 WHERE id = 1', duration_ms: 2 },
        { sql: 'SELECT * FROM t', duration_ms: 1, columns: [{ name: 'x' }], rows: [['1'], ['2']], total_rows: 2 },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'UPDATE t SET x = x + 1 WHERE id = 1; SELECT * FROM t')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 2)
      expect(wrapper.find('[data-test="result-pager"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('WITH 可能是数据修改 CTE,保守隐藏分页条', async () => {
      app.MysqlExecute.mockResolvedValue([
        {
          sql: 'WITH c AS (SELECT 1 AS x) SELECT * FROM c',
          duration_ms: 1,
          columns: [{ name: 'x' }],
          rows: [['1']],
          total_rows: 1,
        },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'WITH c AS (SELECT 1 AS x) SELECT * FROM c')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(wrapper.find('[data-test="result-pager"]').exists()).toBe(false)
      wrapper.unmount()
    })

    it('前导注释不影响只读判定:注释 + SELECT 仍显示分页条,翻页按原脚本重放', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: pagedRows(500), total_rows: 1200 },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, '-- 查询\nSELECT 1')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(wrapper.find('[data-test="result-pager"]').exists()).toBe(true)
      await wrapper.find('[data-test="pager-next"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: '-- 查询\nSELECT 1', database: 'shop', limit: 500, offset: 500 })
      wrapper.unmount()
    })

    it('恰好整页(total_rows=500)时下一页禁用;total_rows=1200 时下一页可用', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: pagedRows(500), total_rows: 500 },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'SELECT 1')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(wrapper.find('[data-test="pager-info"]').text()).toBe('共 500 条 · 第 1/1 页')
      expect((wrapper.find('[data-test="pager-next"]').element as HTMLButtonElement).disabled).toBe(true)
      wrapper.unmount()
      // total=1200 → 共 3 页,本页 500 行,下一页可用。
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: pagedRows(500), total_rows: 1200 },
      ])
      const wrapper2 = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper2, 'SELECT 1')
      await wrapper2.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper2, 1)
      expect((wrapper2.find('[data-test="pager-next"]').element as HTMLButtonElement).disabled).toBe(false)
      wrapper2.unmount()
    })

    it('分页条容器带跨页顺序说明 tooltip', async () => {
      app.MysqlExecute.mockResolvedValue([
        { sql: 'SELECT 1', duration_ms: 1, columns: [{ name: 'x' }], rows: [['1']], total_rows: 1 },
      ])
      const wrapper = mount(MysqlSqlConsole, { props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' } })
      await typeSql(wrapper, 'SELECT 1')
      await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
      await waitForTabs(wrapper, 1)
      expect(wrapper.find('[data-test="result-pager"]').attributes('title')).toBe(
        '跨页分页由数据库 ORDER BY 保证顺序;无排序查询顺序以数据库返回为准',
      )
      wrapper.unmount()
    })
  })
})
