import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
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
  ListMysqlTables: vi.fn(),
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

  it('运行全部:整段脚本发给后端,每条语句渲染一张 SqlResultCard', async () => {
    app.MysqlExecute.mockImplementation(
      withSystemGuard(async (req) => (req.sql === 'SELECT 1; SELECT bad' ? twoResults() : [])),
    )
    const wrapper = mount(MysqlSqlConsole, {
      props: { tabId: 'm-tab1', connectionId: 'm1', database: 'shop' },
    })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-mysql-run"]').trigger('click')
    await waitForCards(wrapper, 2)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1; SELECT bad' })
    const cards = resultCards(wrapper)
    // 第一条:语句原文、耗时、列与行(NULL 单元格)都经 props 传入卡片。
    expect(cards[0].props('statement')).toBe('SELECT 1')
    expect(cards[0].props('durationMs')).toBe(12)
    expect(cards[0].props('columns')).toEqual([{ name: 'one', type: 'int' }])
    expect(cards[0].props('rows')).toEqual([['1'], [null]])
    expect(cards[0].props('error')).toBeFalsy()
    // 第二条:错误文本经 error prop 传入,由卡片渲染错误卡。
    expect(cards[1].props('statement')).toBe('SELECT bad')
    expect(cards[1].props('error')).toBe('You have an error in your SQL syntax')
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
    await waitForCards(wrapper, 2)
    const cards = resultCards(wrapper)
    expect(cards[0].props('exportName')).toBe('mysql-result-0')
    expect(cards[1].props('exportName')).toBe('mysql-result-1')
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
    await waitForCards(wrapper, 2)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1; SELECT 2' })
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
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1' })
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
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1;' })
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
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT bad' })
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
    expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: 'SELECT 1' })
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
    await waitForCards(wrapper, 2)
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT 1; SELECT bad' })
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
    expect(app.MysqlExecute).toHaveBeenCalledWith({ connection_id: 'm1', sql: 'SELECT bad' })
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
    await waitForCards(wrapper, 2)
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
    await waitForCards(wrapper, 2)
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
    await waitForCards(wrapper, 2)
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
      })
    })
    // 已关联文件 → 直接覆盖,不弹名称输入。
    expect(bodyEl('prompt-dialog')).toBeNull()
    wrapper.unmount()
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
      await waitForCards(wrapper, results.length)
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
      await waitForCards(wrapper, 2)
      await editAndSubmit(wrapper, 'b')
      ;(bodyEl('confirm-dialog-ok') as HTMLElement).click()
      await vi.waitFor(() => {
        expect(app.MysqlUpdateCell).toHaveBeenCalledTimes(1)
      })
      // 刷新入参是该条语句的原文(而非整段脚本)。
      await vi.waitFor(() => {
        expect(app.MysqlExecute).toHaveBeenLastCalledWith({ connection_id: 'm1', sql: first.sql })
      })
      // 第一条结果被替换为刷新后的行;第二条结果保持原样。
      await vi.waitFor(() => {
        expect(resultCards(wrapper)[0].props('rows')).toEqual([['b', 'alice', '30', null]])
      })
      expect(resultCards(wrapper)[1].props('rows')).toEqual([['42']])
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
        const card = resultCards(wrapper)[i]
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
})
