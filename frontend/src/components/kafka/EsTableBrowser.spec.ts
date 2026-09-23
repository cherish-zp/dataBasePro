import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { mount, DOMWrapper, flushPromises, type VueWrapper } from '@vue/test-utils'
import { useToastStore } from '@/store/toast'
import EsTableBrowser from './EsTableBrowser.vue'

// Es* 绑定尚未由 wails generate module 生成:组件按显式形状断言直连
// wailsjs,因此测试只在 wailsjs 模块层 mock(vi.mock 提升到文件顶部,fn
// 须用 vi.hoisted 创建避免 TDZ)。
const wailsMocks = vi.hoisted(() => ({
  // 分页取数:返回列/行/总行数/引擎(契约形状,首列为 _id)。
  ESPageRows: vi.fn(),
  // 索引映射字段(旧空态竖排字段面板的数据源;面板已移除,保留 mock
  // 以断言空结果不再拉取映射)。
  ESMapping: vi.fn(),
  // 显式刷新索引(POST /{index}/_refresh):手动刷新与写后自动刷新共用,
  // 恒在 ESPageRows 重取之前调用。
  EsRefreshIndex: vi.fn(),
  // 读取整文档 JSON。
  ESGetDoc: vi.fn(),
  // 整文档替换(PUT _doc)。
  ESPutDoc: vi.fn(),
  // 新增文档(id 留空 = POST 自动生成;非空 = PUT 指定/覆盖)。
  EsCreateDoc: vi.fn(),
  // 字段级部分更新(POST _update)。
  ESUpdateCell: vi.fn(),
  // 删除单文档。
  ESDeleteDoc: vi.fn(),
  // 清空索引全部文档(_delete_by_query)。
  ESDeleteByQuery: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...wailsMocks }
})

const pageRows = wailsMocks.ESPageRows

// ESPageRows 契约形状:首列 _id(type '_id'),其余列来自映射字段;
// 2 行含一个 NULL 字段值。
const page = (over: Record<string, unknown> = {}) => ({
  columns: [
    { name: '_id', type: '_id', comment: '' },
    { name: 'name', type: 'text', comment: '名称' },
    { name: 'age', type: 'long', comment: '' },
  ],
  rows: [
    ['doc-1', 'alice', '30'],
    ['doc-2', null, '25'],
  ],
  total_rows: 12345,
  primary_key: ['_id'],
  engine: 'users-index',
  ...over,
})

// 200 行:下一页按钮只在整页数据时可点。
const fullPage = (over: Record<string, unknown> = {}) => ({
  ...page(over),
  rows: Array.from({ length: 200 }, (_, i) => [`doc-${i}`, 'x', String(i)]),
})

// ConfirmDialog / JSON 弹窗均 Teleport 到 body。
function bodyDialog(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}
function confirmDialog(): HTMLElement | null {
  return bodyDialog('confirm-dialog')
}
function clickBody(testId: string): void {
  bodyDialog(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// 网格外框总是渲染,等待需落在真实数据上:等列头出现。
async function waitCols(wrapper: VueWrapper, n = 3): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-test="es-col"]')).toHaveLength(n)
  })
}

// 第 r 行第 c 列单元格(data-test="es-cell")。
function cellAt(wrapper: VueWrapper, row: number, col: number): DOMWrapper<Element> {
  return wrapper.findAll('[data-test="es-row"]')[row].findAll('[data-test="es-cell"]')[col]
}

function mountBrowser(
  props: { connectionId: string; index: string } = { connectionId: 'es1', index: 'users-index' },
  attach = false,
) {
  return mount(EsTableBrowser, { props, ...(attach ? { attachTo: document.body } : {}) })
}

describe('EsTableBrowser', () => {
  beforeEach(() => {
    // 新增文档成功后的 toast 走全局 Pinia store:挂载前激活独立实例。
    setActivePinia(createPinia())
    document.body.innerHTML = ''
    for (const fn of Object.values(wailsMocks)) fn.mockReset()
  })

  it('首屏:拉取第一页并渲染 _id 只读首列、行数据与汇总条', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    expect(pageRows).toHaveBeenCalledWith({
      connection_id: 'es1',
      index: 'users-index',
      asc: true,
      limit: 200,
      offset: 0,
    })
    const cols = wrapper.findAll('[data-test="es-col"]')
    expect(cols.map((c) => c.find('[data-test="es-col-name"]').text())).toEqual(['_id', 'name', 'age'])
    expect(cols.map((c) => c.find('[data-test="es-col-type"]').text())).toEqual(['_id', 'text', 'long'])
    // 注释仅非空时渲染第三行。
    expect(cols.map((c) => c.find('[data-test="es-col-comment"]').exists())).toEqual([false, true, false])
    // 行渲染与 NULL 单元格。
    const rows = wrapper.findAll('[data-test="es-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].findAll('[data-test="es-cell"]').map((c) => c.text())).toContain('alice')
    const nullCell = cellAt(wrapper, 1, 1)
    expect(nullCell.text()).toBe('NULL')
    expect(nullCell.classes()).toContain('cell-null')
    // _id 单元格:等宽只读样式、悬停提示「文档 _id」。
    const idCell = cellAt(wrapper, 0, 0)
    expect(idCell.find('[data-test="es-id-value"]').text()).toBe('doc-1')
    expect(idCell.classes()).toContain('cell-readonly')
    expect(idCell.attributes('title')).toBe('文档 _id')
    // 汇总条:索引名、引擎(=索引)、近似行数(千分位)。
    expect(wrapper.find('[data-test="es-summary-index"]').text()).toBe('users-index')
    expect(wrapper.find('[data-test="es-summary-engine"]').text()).toBe('users-index')
    expect(wrapper.find('[data-test="es-summary-rows"]').text()).toContain('12,345')
    // 有数据时不渲染映射字段面板。
    expect(wrapper.find('[data-test="es-fields-panel"]').exists()).toBe(false)
  })

  it('分页:下一页/上一页以 200 步进 offset,首页禁用上一页', async () => {
    pageRows.mockResolvedValue(fullPage())
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="es-row"]')).toHaveLength(200)
    })
    expect((wrapper.find('[data-test="btn-es-prev"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="btn-es-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200, limit: 200 }))
    })
    expect(wrapper.find('[data-test="es-page-label"]').text()).toContain('2')
    await wrapper.find('[data-test="btn-es-prev"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
    })
  })

  it('点列头排序下发 order_by,同列翻转、换列升序;_id 列头不可排序', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const cols = wrapper.findAll('[data-test="es-col"]')
    await cols[1].trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'name', asc: true, offset: 0 }))
    })
    await cols[1].trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'name', asc: false }))
    })
    // 换列默认升序。
    await cols[2].trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'age', asc: true }))
    })
    // _id 列头点击不触发排序请求。
    const calls = pageRows.mock.calls.length
    await cols[0].trigger('click')
    expect(pageRows.mock.calls.length).toBe(calls)
  })

  it('不可排序字段:服务端报错在错误区透出', async () => {
    pageRows.mockResolvedValueOnce(page()).mockRejectedValueOnce(new Error('Sort not supported on [name]'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.findAll('[data-test="es-col"]')[1].trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-error"]').text()).toContain('Sort not supported on [name]')
    })
  })

  it('WHERE 过滤应用后随请求下发并回到第一页', async () => {
    pageRows.mockResolvedValue(fullPage())
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="es-row"]')).toHaveLength(200)
    })
    await wrapper.find('[data-test="btn-es-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
    await wrapper.find('[data-test="es-where"]').setValue('name:alice AND age > 18')
    await wrapper.find('[data-test="btn-es-apply"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: 'name:alice AND age > 18', offset: 0 }),
      )
    })
  })

  it('刷新按钮:点击先 EsRefreshIndex 再重取当前页', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.EsRefreshIndex.mockResolvedValue(undefined)
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const btn = wrapper.find('[data-test="es-refresh"]')
    expect(btn.exists()).toBe(true)
    expect(btn.classes()).toContain('ghost')
    expect(btn.text()).toBe('刷新')
    await btn.trigger('click')
    await vi.waitFor(() => {
      expect(wailsMocks.EsRefreshIndex).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index' })
      // 分页重取一次(初始 1 次 + 刷新 1 次)。
      expect(pageRows.mock.calls.length).toBe(2)
    })
    // 显式 _refresh 恒在取数之前(写后立即可见的前提)。
    expect(wailsMocks.EsRefreshIndex.mock.invocationCallOrder[0]).toBeLessThan(
      pageRows.mock.invocationCallOrder[pageRows.mock.invocationCallOrder.length - 1],
    )
  })

  it('刷新按钮:_refresh 失败仍重取数据(best-effort 不报错)', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.EsRefreshIndex.mockRejectedValue(new Error('refresh: HTTP 503'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-refresh"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows.mock.calls.length).toBe(2)
    })
    expect(wrapper.find('[data-test="es-error"]').exists()).toBe(false)
  })

  it('空结果(过滤无匹配):仍渲染数据表,表头横排,表内空态提示', async () => {
    // 后端分页即使零行也返回映射列(_id + 映射字段):只要列在就渲染表格,
    // 不再把整表替换成竖排字段面板(与 MySQL 浏览器行为一致)。
    pageRows.mockResolvedValue(page({ rows: [], total_rows: 0 }))
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="es-col"]')).toHaveLength(3)
    })
    expect(wrapper.find('[data-test="es-grid"]').exists()).toBe(true)
    const cols = wrapper.findAll('[data-test="es-col"]')
    expect(cols.map((c) => c.find('[data-test="es-col-name"]').text())).toEqual(['_id', 'name', 'age'])
    // 竖排字段面板移除(映射字段已作为表头可见),也不再拉取 ESMapping。
    expect(wrapper.find('[data-test="es-fields-panel"]').exists()).toBe(false)
    expect(wailsMocks.ESMapping).not.toHaveBeenCalled()
    // 空态提示保留在表格内部一行。
    const emptyInGrid = wrapper.find('[data-test="es-grid"] [data-test="es-grid-empty"]')
    expect(emptyInGrid.exists()).toBe(true)
    expect(emptyInGrid.text()).toContain('无匹配文档')
    expect(wrapper.findAll('[data-test="es-row"]')).toHaveLength(0)
  })

  it('无列信息兜底:渲染空态提示而非网格', async () => {
    pageRows.mockResolvedValue(page({ rows: [], total_rows: 0, columns: [] }))
    const wrapper = mountBrowser()
    // flushPromises 等首次分页完全落定再断言:首帧(请求未发出)与加载态
    // 都会出现中间 DOM 形态,waitFor 会在首帧空态上提前通过导致竞态。
    await flushPromises()
    expect(wrapper.find('[data-test="es-grid-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="es-grid"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="es-fields-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="es-grid-empty"]').text()).toContain('暂无文档')
  })

  it('字段编辑全链路:回车弹 _update 预览,确认后 ESUpdateCell 并刷新当前页', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESUpdateCell.mockResolvedValue(undefined)
    // attachTo:document.body 使输入框进入文档,自动聚焦才改变 activeElement。
    const wrapper = mountBrowser(undefined, true)
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="es-cell-editor"]')
    expect(editor.exists()).toBe(true)
    // 输入框承载原始值并自动聚焦。
    expect((editor.element as HTMLInputElement).value).toBe('alice')
    expect(document.activeElement).toBe(editor.element)
    await editor.setValue('alice2')
    await editor.trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    // 预览展示将执行的 _update 语义。
    expect(msg).toContain('POST /users-index/_update/doc-1 {"doc":{"name":"alice2"}}')
    const callsBefore = pageRows.mock.calls.length
    clickBody('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.ESUpdateCell).toHaveBeenCalledWith({
        connection_id: 'es1',
        index: 'users-index',
        id: 'doc-1',
        column: 'name',
        value: 'alice2',
      })
    })
    // 确认成功后刷新当前页:ESPageRows 再调用一次。
    await vi.waitFor(() => {
      expect(pageRows.mock.calls.length).toBe(callsBefore + 1)
    })
    // 写后自动刷新:先显式 _refresh 再取数,写入即刻可见。
    expect(wailsMocks.EsRefreshIndex).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index' })
    expect(wailsMocks.EsRefreshIndex.mock.invocationCallOrder[0]).toBeLessThan(
      pageRows.mock.invocationCallOrder[pageRows.mock.invocationCallOrder.length - 1],
    )
  })

  it('更新失败:弹窗保持打开且错误显示在弹窗内,取消后错误仍留在页面错误区', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESUpdateCell.mockRejectedValue(new Error('elasticsearch update: HTTP 400: illegal_argument_exception'))
    const wrapper = mountBrowser(undefined, true)
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="es-cell-editor"]')
    await editor.setValue('bad value')
    await editor.trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    clickBody('confirm-dialog-ok')
    await vi.waitFor(() => {
      // 弹窗保持打开,错误直接显示在弹窗内(用户点确认后立刻可见)。
      const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
      expect(msg).toContain('执行失败')
      expect(msg).toContain('illegal_argument_exception')
    })
    // 页面错误区同步显示,关闭弹窗后仍然可见(不被遮罩吞掉)。
    expect(wrapper.find('[data-test="es-error"]').text()).toContain('illegal_argument_exception')
    // 取消(关闭弹窗)不清错误:页面错误区保留服务端原因。
    clickBody('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(document.body.querySelector('[data-test="confirm-dialog"]')).toBeNull()
    })
    expect(wrapper.find('[data-test="es-error"]').text()).toContain('illegal_argument_exception')
    // 写操作本身失败:不触发刷新,也不重取数据。
    expect(wailsMocks.EsRefreshIndex).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('写后自动刷新 best-effort:_refresh 失败不阻断重取、不报错', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESUpdateCell.mockResolvedValue(undefined)
    wailsMocks.EsRefreshIndex.mockRejectedValue(new Error('refresh: HTTP 503'))
    const wrapper = mountBrowser(undefined, true)
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="es-cell-editor"]')
    await editor.setValue('alice2')
    await editor.trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    clickBody('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.ESUpdateCell).toHaveBeenCalled()
      // _refresh 被忽略后仍重取分页。
      expect(pageRows.mock.calls.length).toBe(2)
    })
    // 失败不进错误区:数据可见性最坏延迟到 ES 自身刷新周期。
    expect(wrapper.find('[data-test="es-error"]').exists()).toBe(false)
  })

  it('NULL 单元格双击为空输入,清空提交写 null', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESUpdateCell.mockResolvedValue(undefined)
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    // 第二行 name 原值为 NULL:双击得到空输入框。
    await cellAt(wrapper, 1, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="es-cell-editor"]')
    expect((editor.element as HTMLInputElement).value).toBe('')
    await editor.trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('POST /users-index/_update/doc-2 {"doc":{"name":null}}')
    clickBody('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.ESUpdateCell).toHaveBeenCalledWith({
        connection_id: 'es1',
        index: 'users-index',
        id: 'doc-2',
        column: 'name',
        value: null,
      })
    })
  })

  it('_id 列双击不可编辑,不发起任何请求', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 0).trigger('dblclick')
    expect(wrapper.find('[data-test="es-cell-editor"]').exists()).toBe(false)
    expect(wailsMocks.ESUpdateCell).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('编辑 Esc/blur 取消不发起任何请求', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser(undefined, true)
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="es-cell-editor"]')
    expect((editor.element as HTMLInputElement).value).toBe('alice')
    expect(document.activeElement).toBe(editor.element)
    await editor.trigger('keydown.esc')
    expect(wrapper.find('[data-test="es-cell-editor"]').exists()).toBe(false)
    expect(wailsMocks.ESUpdateCell).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
    // blur 同样退出编辑。
    await cellAt(wrapper, 0, 2).trigger('dblclick')
    await wrapper.find('[data-test="es-cell-editor"]').trigger('blur')
    expect(wrapper.find('[data-test="es-cell-editor"]').exists()).toBe(false)
    expect(wailsMocks.ESUpdateCell).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('编辑确认弹窗取消:不执行、不刷新', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    await wrapper.find('[data-test="es-cell-editor"]').setValue('alice2')
    await wrapper.find('[data-test="es-cell-editor"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    clickBody('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
    expect(wailsMocks.ESUpdateCell).not.toHaveBeenCalled()
    // 未执行也就不刷新:仍只有初始 1 次分页请求。
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('整文档 JSON:打开加载格式化 JSON,保存走 ESPutDoc 并刷新', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESGetDoc.mockResolvedValue({ doc_json: '{"_index":"users-index","name":"alice","age":30}' })
    wailsMocks.ESPutDoc.mockResolvedValue(undefined)
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-json-0"]').trigger('click')
    await vi.waitFor(() => {
      expect(wailsMocks.ESGetDoc).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index', id: 'doc-1' })
    })
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    const editorEl = bodyDialog('es-doc-json-editor') as HTMLTextAreaElement
    expect(editorEl.value).toBe(JSON.stringify({ _index: 'users-index', name: 'alice', age: 30 }, null, 2))
    await new DOMWrapper(editorEl).setValue('{"name":"alice2"}')
    clickBody('es-doc-json-save')
    await vi.waitFor(() => {
      expect(wailsMocks.ESPutDoc).toHaveBeenCalledWith({
        connection_id: 'es1',
        index: 'users-index',
        id: 'doc-1',
        doc_json: '{"name":"alice2"}',
      })
    })
    // 保存成功后刷新当前页并关闭弹窗。
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
    })
    // 写后自动刷新:先显式 _refresh 再取数。
    expect(wailsMocks.EsRefreshIndex).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index' })
    expect(wailsMocks.EsRefreshIndex.mock.invocationCallOrder[0]).toBeLessThan(
      pageRows.mock.invocationCallOrder[pageRows.mock.invocationCallOrder.length - 1],
    )
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).toBeNull()
    })
  })

  it('整文档 JSON 保存语法错误:错误区展示且弹窗保持打开', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESGetDoc.mockResolvedValue({ doc_json: '{"name":"alice"}' })
    wailsMocks.ESPutDoc.mockRejectedValue(new Error('JSON 语法错误(400)'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-json-0"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    clickBody('es-doc-json-save')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-error"]').text()).toContain('JSON 语法错误(400)')
    })
    // 弹窗保持打开以便修正,不刷新。
    expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('JSON 编辑取消:关闭弹窗不发起写请求、不刷新', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESGetDoc.mockResolvedValue({ doc_json: '{"name":"alice"}' })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-json-0"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    clickBody('es-doc-json-cancel')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).toBeNull()
    })
    expect(wailsMocks.ESPutDoc).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('新增文档:工具栏按钮打开新增弹窗,draft 由映射字段骨架生成', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    expect(wrapper.find('[data-test="es-doc-create"]').exists()).toBe(true)
    await wrapper.find('[data-test="es-doc-create"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    // 标题为「新增文档」(编辑态为「编辑文档 JSON」)。
    expect(bodyDialog('es-doc-json-title')?.textContent).toContain('新增文档')
    // 骨架:name(text)→ null,age(long)→ 0,_id 列不进入骨架。
    expect((bodyDialog('es-doc-json-editor') as HTMLTextAreaElement).value).toBe(
      '{\n  "name": null,\n  "age": 0\n}',
    )
    // _id 输入框:placeholder「留空自动生成」,初始为空。
    const idInput = bodyDialog('es-doc-create-id') as HTMLInputElement
    expect(idInput).not.toBeNull()
    expect(idInput.value).toBe('')
    expect(idInput.placeholder).toContain('留空自动生成')
    // 保存按钮文案:_id 留空 → 「创建」。
    expect(bodyDialog('es-doc-json-save')?.textContent).toContain('创建')
  })

  it('新增文档:_id 留空保存走 EsCreateDoc(不带 id),成功后 toast、关弹窗并刷新', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.EsCreateDoc.mockResolvedValue({ id: 'auto-1', source: '{}' })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-create"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    await new DOMWrapper(bodyDialog('es-doc-json-editor') as HTMLTextAreaElement).setValue(
      '{"name":"bob","age":1}',
    )
    clickBody('es-doc-json-save')
    await vi.waitFor(() => {
      // id 留空:请求不带 id 字段(POST 自动生成)。
      expect(wailsMocks.EsCreateDoc).toHaveBeenCalledWith({
        connection_id: 'es1',
        index: 'users-index',
        doc_json: '{"name":"bob","age":1}',
      })
    })
    // 成功:关弹窗 + toast + refreshThenFetch(先 _refresh 再重取当前页)。
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).toBeNull()
    })
    expect(useToastStore().message).toBe('文档已创建')
    expect(wailsMocks.EsRefreshIndex).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index' })
    expect(wailsMocks.EsRefreshIndex.mock.invocationCallOrder[0]).toBeLessThan(
      pageRows.mock.invocationCallOrder[pageRows.mock.invocationCallOrder.length - 1],
    )
    await vi.waitFor(() => {
      expect(pageRows.mock.calls.length).toBe(2)
    })
  })

  it('新增文档:填写 _id 后按钮文案「创建/覆盖」并带覆盖 title,保存走 EsCreateDoc 指定 id', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.EsCreateDoc.mockResolvedValue({ id: 'u-1', source: '{}' })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-create"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    expect(bodyDialog('es-doc-json-save')?.textContent).not.toContain('覆盖')
    await new DOMWrapper(bodyDialog('es-doc-create-id') as HTMLInputElement).setValue('u-1')
    const saveBtn = bodyDialog('es-doc-json-save') as HTMLElement
    expect(saveBtn.textContent).toContain('创建/覆盖')
    // title 注明覆盖行为。
    expect(saveBtn.getAttribute('title')).toContain('覆盖')
    await new DOMWrapper(bodyDialog('es-doc-json-editor') as HTMLTextAreaElement).setValue('{"name":"bob"}')
    clickBody('es-doc-json-save')
    await vi.waitFor(() => {
      expect(wailsMocks.EsCreateDoc).toHaveBeenCalledWith({
        connection_id: 'es1',
        index: 'users-index',
        id: 'u-1',
        doc_json: '{"name":"bob"}',
      })
    })
    expect(wailsMocks.ESPutDoc).not.toHaveBeenCalled()
  })

  it('新增文档:非法 JSON 前端校验失败,错误在弹窗内展示且不发请求', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-create"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    await new DOMWrapper(bodyDialog('es-doc-json-editor') as HTMLTextAreaElement).setValue('{invalid')
    clickBody('es-doc-json-save')
    await flushPromises()
    // 前端校验错误显示在弹窗内,弹窗保持打开。
    expect(bodyDialog('es-json-error')).not.toBeNull()
    expect(bodyDialog('es-json-error')?.textContent).toContain('JSON 语法错误')
    expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    expect(wailsMocks.EsCreateDoc).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('新增文档:保存失败弹窗保持,错误在弹窗内并同步页面错误区,不刷新', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.EsCreateDoc.mockRejectedValue(new Error('mapper_parsing_exception'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-create"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    clickBody('es-doc-json-save')
    await vi.waitFor(() => {
      expect(bodyDialog('es-json-error')).not.toBeNull()
      expect(bodyDialog('es-json-error')?.textContent).toContain('mapper_parsing_exception')
    })
    // 弹窗保持打开以便修正,页面错误区同步一份。
    expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    expect(wrapper.find('[data-test="es-error"]').text()).toContain('mapper_parsing_exception')
    expect(wailsMocks.EsRefreshIndex).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('另存为新文档:编辑弹窗保留原文档内容,清空 _id 进入新增态,保存走 EsCreateDoc', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESGetDoc.mockResolvedValue({ doc_json: '{"name":"alice","age":30}' })
    wailsMocks.EsCreateDoc.mockResolvedValue({ id: 'copy-1', source: '{}' })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-json-0"]').trigger('click')
    await vi.waitFor(() => {
      expect(bodyDialog('es-doc-json-modal')).not.toBeNull()
    })
    // 编辑态提供「另存为新文档」按钮。
    expect(bodyDialog('es-doc-duplicate')).not.toBeNull()
    await new DOMWrapper(bodyDialog('es-doc-duplicate') as HTMLElement).trigger('click')
    // 进入新增态:标题、_id 输入框清空可填、保存按钮为「创建」。
    expect(bodyDialog('es-doc-json-title')?.textContent).toContain('新增文档')
    expect((bodyDialog('es-doc-create-id') as HTMLInputElement).value).toBe('')
    expect(bodyDialog('es-doc-json-save')?.textContent).toContain('创建')
    // 内容保留原文档(格式化 JSON)。
    expect((bodyDialog('es-doc-json-editor') as HTMLTextAreaElement).value).toBe(
      JSON.stringify({ name: 'alice', age: 30 }, null, 2),
    )
    // 填新 _id 后保存:走 EsCreateDoc 指定 id,而非 ESPutDoc。
    await new DOMWrapper(bodyDialog('es-doc-create-id') as HTMLInputElement).setValue('copy-1')
    clickBody('es-doc-json-save')
    await vi.waitFor(() => {
      expect(wailsMocks.EsCreateDoc).toHaveBeenCalledWith({
        connection_id: 'es1',
        index: 'users-index',
        id: 'copy-1',
        doc_json: JSON.stringify({ name: 'alice', age: 30 }, null, 2),
      })
    })
    expect(wailsMocks.ESPutDoc).not.toHaveBeenCalled()
  })

  it('删除文档:危险确认含 _id,确认后 ESDeleteDoc 并刷新', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.ESDeleteDoc.mockResolvedValue(undefined)
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-delete-1"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('doc-2')
    expect(msg).toContain('删除')
    // 危险操作:确认按钮带 danger 样式。
    const okBtn = document.body.querySelector('[data-test="confirm-dialog-ok"]')
    expect(okBtn?.className).toContain('danger')
    clickBody('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.ESDeleteDoc).toHaveBeenCalledWith({
        connection_id: 'es1',
        index: 'users-index',
        id: 'doc-2',
      })
    })
    // 删除成功后刷新当前页。
    await vi.waitFor(() => {
      expect(pageRows.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
    // 写后自动刷新:先显式 _refresh 再取数。
    expect(wailsMocks.EsRefreshIndex).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index' })
    expect(wailsMocks.EsRefreshIndex.mock.invocationCallOrder[0]).toBeLessThan(
      pageRows.mock.invocationCallOrder[pageRows.mock.invocationCallOrder.length - 1],
    )
  })

  it('删除文档取消:不执行、不刷新', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="es-doc-delete-0"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    clickBody('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
    expect(wailsMocks.ESDeleteDoc).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('清空文档:危险确认文案含 _delete_by_query,确认后 ESDeleteByQuery 并回第一页', async () => {
    pageRows.mockResolvedValue(fullPage())
    wailsMocks.ESDeleteByQuery.mockResolvedValue(undefined)
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="es-row"]')).toHaveLength(200)
    })
    await wrapper.find('[data-test="btn-es-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
    await wrapper.find('[data-test="btn-es-clear"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('users-index')
    expect(msg).toContain('_delete_by_query')
    expect(msg).toContain('不可恢复')
    expect(document.body.querySelector('[data-test="confirm-dialog-ok"]')?.className).toContain('danger')
    clickBody('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.ESDeleteByQuery).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index' })
    })
    // 清空成功后回第一页刷新。
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
    })
    // 写后自动刷新:先显式 _refresh 再取数。
    expect(wailsMocks.EsRefreshIndex).toHaveBeenCalledWith({ connection_id: 'es1', index: 'users-index' })
    expect(wailsMocks.EsRefreshIndex.mock.invocationCallOrder[0]).toBeLessThan(
      pageRows.mock.invocationCallOrder[pageRows.mock.invocationCallOrder.length - 1],
    )
  })

  it('清空文档取消:不执行', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-es-clear"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    clickBody('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
    expect(wailsMocks.ESDeleteByQuery).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('分页请求失败在错误区展示错误信息', async () => {
    pageRows.mockRejectedValue(new Error('查询失败:连接超时'))
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-error"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="es-error"]').text()).toContain('查询失败:连接超时')
  })

  it('外部切换 index prop 时重置过滤/排序/分页并以新索引重拉', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    // 先设置排序与过滤。
    await wrapper.findAll('[data-test="es-col"]')[1].trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'name', offset: 0 }))
    })
    await wrapper.find('[data-test="es-where"]').setValue('age > 18')
    await wrapper.find('[data-test="btn-es-apply"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ where: 'age > 18' }))
    })
    await wrapper.setProps({ index: 'orders-index' })
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(
        expect.objectContaining({ index: 'orders-index', offset: 0 }),
      )
    })
    // 排序与过滤状态已重置。
    const last = pageRows.mock.calls[pageRows.mock.calls.length - 1][0] as {
      order_by?: string
      where?: string
    }
    expect(last.order_by).toBeUndefined()
    expect(last.where).toBeUndefined()
    expect((wrapper.find('[data-test="es-where"]').element as HTMLInputElement).value).toBe('')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="es-summary-index"]').text()).toBe('orders-index')
    })
  })

  it('保持列头横向铺开:表格按内容自然宽度(th 不套弹性布局)', () => {
    // 视觉对齐 MysqlTableBrowser 的防挤压契约:列数多时横向滚动而不是把列头
    // 压成竖排文字;th 保持 table-cell,弹性布局只在内层 div。
    const fileSrc = readFileSync(join(process.cwd(), 'src/components/kafka/EsTableBrowser.vue'), 'utf8')
    const tableBlock = fileSrc.match(/\.table \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(tableBlock).toContain('width: max-content')
    expect(tableBlock).toContain('min-width: 100%')
    const headBlock = fileSrc.match(/\.col-head \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(headBlock).toContain('white-space: nowrap')
  })
})
