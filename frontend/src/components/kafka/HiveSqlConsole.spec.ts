import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { nextTick } from 'vue'
import { EditorView } from '@codemirror/view'
import { createPinia, setActivePinia } from 'pinia'
import { QUERY_DIR_KEY } from '@/utils/queryDir'
import { useQueryFiles } from '@/composables/queryFiles'
import { useTabsStore, type Tab } from '@/store/tabs'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { HiveStatementResult } from '@/api/types'
import SqlEditor from '@/components/common/SqlEditor.vue'
import SqlResultCard from '@/components/common/SqlResultCard.vue'
// 查询文件链路走 wailsjs 绑定(ListQueryFiles 等),测试层替换该模块;
// vi.mock 提升,fn 须用 vi.hoisted 创建避免 TDZ。
const appMocks = vi.hoisted(() => ({
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../wailsjs/go/backend/App')>()
  return { ...actual, ...appMocks }
})
const app = appMocks

import HiveSqlConsole from './HiveSqlConsole.vue'

// 组件经 getApi() 可选链调用,测试用 setApi 注入 fake API。
const hiveExecute = vi.fn()
const listHiveDatabases = vi.fn()
const listHiveTables = vi.fn()

function fakeApi(): Api {
  return {
    hiveExecute,
    listHiveDatabases,
    listHiveTables,
  } as unknown as Api
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

// 测试统一使用的查询目录(localStorage 注入)与结果区高度 key。
const TEST_DIR = '/Users/test/queries'
const RESULTS_HEIGHT_KEY = 'dbclient-sql-results-height'

// SqlEditor 内部由 CM6 创建自己的 .cm-editor,借 findFromDOM 拿到 view 实例。
function cmInput(wrapper: VueWrapper): EditorView {
  const host = wrapper.find('[data-test="hive-sql-input"] .cm-editor').element as HTMLElement
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
function pressSaveShortcut(wrapper: VueWrapper): void {
  cmInput(wrapper).contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 's', metaKey: true, bubbles: true }))
}

// 在编辑器里按 ⌘/Ctrl+Enter(可带 Shift = 运行全部)。
function pressRunShortcut(
  wrapper: VueWrapper,
  mods: { metaKey?: boolean; shiftKey?: boolean } = { metaKey: true },
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

// —— 结果 Tab 条辅助 ——

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

// PromptDialog / ConfirmDialog teleport 到 body。
function bodyEl(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}

// 在 teleport 弹窗的输入框中输入并确认;等确认按钮从 disabled 变为可用。
async function confirmPrompt(value: string): Promise<void> {
  const input = bodyEl('prompt-input') as HTMLInputElement
  input.value = value
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await vi.waitFor(() => {
    expect((bodyEl('prompt-confirm') as HTMLButtonElement).disabled).toBe(false)
  })
  ;(bodyEl('prompt-confirm') as HTMLElement).click()
}

const twoResults = (): HiveStatementResult[] => [
  { sql: 'SELECT 1', duration_ms: 12, columns: [{ name: 'one', type: 'int' }], rows: [['1'], [null]], total_rows: 2 },
  { sql: 'SELECT bad', duration_ms: 3, error: 'ParseException line 1:0 cannot recognize input' },
]

// 回声实现:每条执行的语句原样回一条单列结果。
const echoResult = (req: { sql: string }): HiveStatementResult[] => [
  { sql: req.sql, duration_ms: 1, columns: [{ name: 'one', type: 'int' }], rows: [['1']], total_rows: 1 },
]

function mountConsole(
  props: { tabId?: string; connectionId?: string; database?: string } = {},
): VueWrapper {
  return mount(HiveSqlConsole, {
    props: {
      tabId: props.tabId ?? 'h-tab1',
      connectionId: props.connectionId ?? 'h1',
      database: props.database,
    },
  })
}

describe('HiveSqlConsole', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.clearAllMocks()
    hiveExecute.mockImplementation(async () => [] as HiveStatementResult[])
    listHiveTables.mockImplementation(async () => [])
    listHiveDatabases.mockResolvedValue(['default', 'ods'])
    app.ListQueryFiles.mockImplementation(async () => [])
    app.ReadQueryFile.mockImplementation(async () => ({ content: '', connection_id: '' }))
    app.WriteQueryFile.mockImplementation(async () => {})
    app.DeleteQueryFile.mockImplementation(async () => {})
    // composable 的文件列表是模块级共享状态,测试间清空避免串扰。
    useQueryFiles({ connectionId: () => 'h1' }).files.value = []
    localStorage.setItem(QUERY_DIR_KEY, TEST_DIR)
    localStorage.removeItem(RESULTS_HEIGHT_KEY)
    document.body.innerHTML = ''
    setApi(fakeApi())
  })

  // --- 执行与结果渲染 ---------------------------------------------------------

  it('运行全部:payload 携带 database/limit/offset,出现 N 个结果 tab 与一张 active 卡', async () => {
    hiveExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT bad' ? twoResults() : echoResult(req),
    )
    const wrapper = mountConsole({ database: 'ods' })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    await wrapper.find('[data-test="btn-hive-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(hiveExecute).toHaveBeenCalledWith({ connection_id: 'h1', sql: 'SELECT 1; SELECT bad', database: 'ods', limit: 500, offset: 0 })
    expect(resultTabEls(wrapper)).toHaveLength(2)
    expect(resultCards(wrapper)).toHaveLength(1)
    const card = resultCards(wrapper)[0]
    expect(card.props('statement')).toBe('SELECT 1')
    expect(card.props('rows')).toEqual([['1'], [null]])
    expect(card.props('exportName')).toBe('hive-result-0')
    // 切到第二个 tab:错误结果卡。
    await resultTabEls(wrapper)[1].trigger('click')
    expect(resultCards(wrapper)[0].props('error')).toBe('ParseException line 1:0 cannot recognize input')
    wrapper.unmount()
  })

  it('⌘Enter 无选区时执行光标所在语句;⌘Shift+Enter 运行全部', async () => {
    hiveExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT bad' ? twoResults() : echoResult(req),
    )
    const wrapper = mountConsole({ database: 'ods' })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    wrapper.findComponent(SqlEditor).vm.$emit('cursor', { line: 1, col: 13 })
    await nextTick()
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(hiveExecute).toHaveBeenLastCalledWith({ connection_id: 'h1', sql: 'SELECT bad', database: 'ods', limit: 500, offset: 0 })

    pressRunShortcut(wrapper, { metaKey: true, shiftKey: true })
    await waitForTabs(wrapper, 2)
    expect(hiveExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ sql: 'SELECT 1; SELECT bad', offset: 0 }),
    )
    wrapper.unmount()
  })

  it('监听 SqlEditor 的 run-statement emit,按单语句逻辑执行', async () => {
    hiveExecute.mockImplementation(echoResult)
    const wrapper = mountConsole({ database: 'ods' })
    await typeSql(wrapper, 'SELECT 1; SELECT bad')
    wrapper.findComponent(SqlEditor).vm.$emit('run-statement', 'SELECT bad')
    await waitForCards(wrapper, 1)
    expect(hiveExecute).toHaveBeenLastCalledWith({ connection_id: 'h1', sql: 'SELECT bad', database: 'ods', limit: 500, offset: 0 })
    wrapper.unmount()
  })

  it('执行失败:错误进错误区,语句标记置 fail', async () => {
    hiveExecute.mockRejectedValue(new Error('HiveServer2 连接失败'))
    const wrapper = mountConsole({ database: 'ods' })
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-hive-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="hive-sql-error"]').text()).toContain('HiveServer2 连接失败')
    })
    wrapper.unmount()
  })

  it('挂载后拉表清单组装表名层补全(Hive 无列层),失败降级为空', async () => {
    listHiveTables.mockResolvedValue([{ name: 'events' }, { name: 'users' }])
    const wrapper = mountConsole({ database: 'ods' })
    await vi.waitFor(() => {
      expect(listHiveTables).toHaveBeenCalledWith({ connection_id: 'h1', database: 'ods' })
    })
    await vi.waitFor(() => {
      expect(wrapper.findComponent(SqlEditor).props('tables')).toEqual([{ name: 'events' }, { name: 'users' }])
    })
    wrapper.unmount()

    listHiveTables.mockRejectedValue(new Error('表清单失败'))
    const wrapper2 = mountConsole({ database: 'ods' })
    await vi.waitFor(() => {
      expect(wrapper2.findComponent(SqlEditor).props('tables')).toEqual([])
    })
    wrapper2.unmount()
  })

  // --- 分页:重放翻页与三态信息 -----------------------------------------------

  it('分页:精确总数三态信息与 lastRequest 重放翻页', async () => {
    const paged = (offsetReq: { offset: number }): HiveStatementResult[] => [
      {
        sql: 'SELECT 1',
        duration_ms: 5,
        columns: [{ name: 'one', type: 'int' }],
        rows: Array.from({ length: offsetReq.offset === 0 ? 500 : 300 }, () => ['x']),
        total_rows: 800,
      },
    ]
    hiveExecute.mockImplementation(async (req: { sql: string; offset: number }) => paged(req))
    const wrapper = mountConsole({ database: 'ods' })
    await typeSql(wrapper, 'SELECT 1')
    await wrapper.find('[data-test="btn-hive-run"]').trigger('click')
    await waitForCards(wrapper, 1)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="result-pager"]').exists()).toBe(true)
    })
    // 精确总数:共 800 条 · 第 1/2 页;下一页重放 lastRequest + offset 500。
    expect(wrapper.find('[data-test="pager-info"]').text()).toContain('共 800 条')
    expect(wrapper.find('[data-test="pager-info"]').text()).toContain('第 1/2 页')
    await wrapper.find('[data-test="pager-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(hiveExecute).toHaveBeenLastCalledWith(
        expect.objectContaining({ sql: 'SELECT 1', database: 'ods', limit: 500, offset: 500 }),
      )
    })
    expect(wrapper.find('[data-test="pager-info"]').text()).toContain('第 2/2 页')
    // 末页下一页禁用;上一页回到第 1 页。
    expect((wrapper.find('[data-test="pager-next"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="pager-prev"]').trigger('click')
    await vi.waitFor(() => {
      expect(hiveExecute).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
    })
    wrapper.unmount()
  })

  it('含 DML 的脚本不显示分页条(重放会重复执行)', async () => {
    hiveExecute.mockImplementation(echoResult)
    const wrapper = mountConsole({ database: 'ods' })
    await typeSql(wrapper, 'INSERT INTO events SELECT * FROM staging')
    await wrapper.find('[data-test="btn-hive-run"]').trigger('click')
    await waitForCards(wrapper, 1)
    expect(wrapper.find('[data-test="result-pager"]').exists()).toBe(false)
    wrapper.unmount()
  })

  // --- 库选择器 ---------------------------------------------------------------

  it('库选择器:初值 props.database,选项来自 listHiveDatabases,切库重拉补全并重置标记', async () => {
    listHiveTables.mockResolvedValue([{ name: 'events' }])
    const wrapper = mountConsole({ database: 'ods' })
    await vi.waitFor(() => {
      expect(listHiveDatabases).toHaveBeenCalledWith('h1')
    })
    const select = wrapper.find('[data-test="hive-db-select"]')
    expect((select.element as HTMLSelectElement).value).toBe('ods')
    await vi.waitFor(() => {
      const el = select.element as HTMLSelectElement
      expect(Array.from(el.options).some((o) => o.value === 'default')).toBe(true)
    })
    await select.setValue('default')
    await vi.waitFor(() => {
      expect(listHiveTables).toHaveBeenLastCalledWith({ connection_id: 'h1', database: 'default' })
    })
    // 切库后执行 payload 携带新库。
    hiveExecute.mockImplementation(echoResult)
    await typeSql(wrapper, 'SELECT 1')
    pressRunShortcut(wrapper)
    await waitForCards(wrapper, 1)
    expect(hiveExecute).toHaveBeenLastCalledWith(
      expect.objectContaining({ sql: 'SELECT 1', database: 'default' }),
    )
    wrapper.unmount()
  })

  it('listHiveDatabases 失败:静默为空,选择器仍显示当前库', async () => {
    listHiveDatabases.mockRejectedValue(new Error('网络错误'))
    const wrapper = mountConsole({ database: 'ods' })
    await vi.waitFor(() => {
      expect(listHiveDatabases).toHaveBeenCalled()
    })
    const select = wrapper.find('[data-test="hive-db-select"]')
    expect((select.element as HTMLSelectElement).value).toBe('ods')
    wrapper.unmount()
  })

  // --- 查询文件:保存(⌘S,携带库)/ 载入(文件头恢复库)/ tab 标题 -------------

  it('⌘S 保存新文件:WriteQueryFile payload 携带当前库,保存后成为当前文件', async () => {
    const wrapper = mountConsole({ database: 'ods' })
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
        connection_id: 'h1',
        database: 'ods',
      })
    })
    expect(exposedApi(wrapper).currentFile()).toBe('新文件.sql')
    wrapper.unmount()
  })

  it('载入文件头带库的 .sql → 选择器切到该库;tab 标题跟随文件名', async () => {
    const tabsStore = useTabsStore()
    tabsStore.openTabs.push({
      id: 'h-tab1',
      kind: 'hive-sql',
      title: 'SQL 控制台',
      connectionId: 'h1',
    } as unknown as Tab)
    listHiveTables.mockResolvedValue([{ name: 'events' }])
    app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'h1', database: 'dwd' })
    const wrapper = mountConsole()
    expect(tabsStore.openTabs[0].title).toBe('SQL 控制台')
    exposedApi(wrapper).loadQueryFile('每日报表.sql')
    await vi.waitFor(() => {
      expect(tabsStore.openTabs[0].title).toBe('每日报表.sql')
    })
    await vi.waitFor(() => {
      const select = wrapper.find('[data-test="hive-db-select"]').element as HTMLSelectElement
      expect(select.value).toBe('dwd')
    })
    // 载入按文件头的库重拉补全。
    await vi.waitFor(() => {
      expect(listHiveTables).toHaveBeenLastCalledWith({ connection_id: 'h1', database: 'dwd' })
    })
    wrapper.unmount()
  })

  it('载入未关联库(空串)的文件保持当前库不误切', async () => {
    listHiveTables.mockResolvedValue([{ name: 'events' }])
    app.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'h1', database: '' })
    const wrapper = mountConsole({ database: 'ods' })
    exposedApi(wrapper).loadQueryFile('每日报表.sql')
    await vi.waitFor(() => {
      expect(exposedApi(wrapper).currentFile()).toBe('每日报表.sql')
    })
    await new Promise((r) => setTimeout(r, 0))
    const select = wrapper.find('[data-test="hive-db-select"]').element as HTMLSelectElement
    expect(select.value).toBe('ods')
    // 未切库:最后一次 listHiveTables 仍是挂载时的 ods。
    expect(listHiveTables).toHaveBeenLastCalledWith({ connection_id: 'h1', database: 'ods' })
    wrapper.unmount()
  })

  // --- 草稿持久化:切 tab 销毁重建后内容/文件关联/库选择不丢 -------------------

  it('挂载恢复 tab draft(sql/file/database),编辑后写回 setTabDraft', async () => {
    const tabsStore = useTabsStore()
    tabsStore.openTabs.push({
      id: 'h-tab1',
      kind: 'hive-sql',
      title: 'SQL 控制台',
      connectionId: 'h1',
      database: 'ods',
      draft: { sql: 'SELECT draft', file: '草稿.sql', database: 'dwd' },
    } as unknown as Tab)
    listHiveTables.mockResolvedValue([{ name: 'events' }])
    const wrapper = mountConsole({ database: 'ods' })
    // 编辑器内容与库选择从 draft 恢复(不读盘),补全按恢复的库加载。
    await vi.waitFor(() => {
      expect(cmInput(wrapper).state.doc.toString()).toBe('SELECT draft')
    })
    expect(app.ReadQueryFile).not.toHaveBeenCalled()
    await vi.waitFor(() => {
      expect(listHiveTables).toHaveBeenLastCalledWith({ connection_id: 'h1', database: 'dwd' })
    })
    expect(tabsStore.openTabs[0].title).toBe('草稿.sql')
    // 编辑内容写回 tab draft。
    await typeSql(wrapper, 'SELECT 42')
    await vi.waitFor(() => {
      expect(tabsStore.openTabs[0].draft).toEqual({ sql: 'SELECT 42', file: '草稿.sql', database: 'dwd' })
    })
    wrapper.unmount()
  })

  // --- 结果区与状态栏 ---------------------------------------------------------

  it('结果区初始关闭,运行后打开;状态栏显示语句条数与最近耗时', async () => {
    hiveExecute.mockImplementation(async (req: { sql: string }) =>
      req.sql === 'SELECT 1; SELECT 2'
        ? [
            { sql: 'SELECT 1', duration_ms: 12, columns: [{ name: 'one', type: 'int' }], rows: [['1']] },
            { sql: 'SELECT 2', duration_ms: 3, columns: [{ name: 'two', type: 'int' }], rows: [['2']] },
          ]
        : [],
    )
    const wrapper = mountConsole({ database: 'ods' })
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="console-splitter"]').exists()).toBe(false)
    await typeSql(wrapper, 'SELECT 1; SELECT 2')
    const bar = () => wrapper.find('[data-test="console-statusbar"]')
    expect(bar().text()).toContain('语句 2 条')
    await wrapper.find('[data-test="btn-hive-run"]').trigger('click')
    await waitForTabs(wrapper, 2)
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(true)
    // 最近耗时 = 12 + 3。
    expect(bar().text()).toContain('最近耗时 15 ms')
    // × 关闭回编辑器铺满。
    await wrapper.find('[data-test="results-close"]').trigger('click')
    expect(wrapper.find('[data-test="results-pane"]').exists()).toBe(false)
    wrapper.unmount()
  })
})
