import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import MysqlTableBrowser from './MysqlTableBrowser.vue'

// Mysql* 绑定尚未由 wails generate module 生成:组件按显式形状断言直连
// wailsjs,因此测试只在 wailsjs 模块层 mock(vi.mock 提升到文件顶部,fn
// 须用 vi.hoisted 创建避免 TDZ)。
const wailsMocks = vi.hoisted(() => ({
  // 分页取数:返回列/行/主键/引擎/总行数(契约形状)。
  MysqlPageRows: vi.fn(),
  // 清空表数据。
  MysqlTruncateTable: vi.fn(),
  // 预览:返回将执行的 UPDATE 语句全文与匹配行数(契约形状)。
  MysqlPreviewCellUpdate: vi.fn(),
  // 执行:按已预览的 target 执行 UPDATE。
  MysqlUpdateCell: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...wailsMocks }
})

const pageRows = wailsMocks.MysqlPageRows

// MysqlPageRows 契约形状:默认两列(id 为主键 + name),2 行含一个 NULL。
const page = (over: Record<string, unknown> = {}) => ({
  columns: [
    { name: 'id', type: 'int unsigned', comment: '主键 ID', is_in_primary_key: true },
    { name: 'name', type: 'varchar(64)', comment: '' },
  ],
  rows: [
    ['1', 'alice'],
    [null, 'bob'],
  ],
  total_rows: 4096,
  primary_key: ['id'],
  engine: 'InnoDB',
  ...over,
})

// 200 行:下一页按钮只在整页数据时可点。
const fullPage = (over: Record<string, unknown> = {}) => ({
  ...page(over),
  rows: Array.from({ length: 200 }, (_, i) => [String(i), 'x']),
})

// ConfirmDialog teleport 到 body。
function confirmDialog(): HTMLElement | null {
  return document.body.querySelector('[data-test="confirm-dialog"]')
}
function clickConfirmDialog(testId: string): void {
  document.body.querySelector(`[data-test="${testId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

// 网格外框总是渲染,等待需落在真实数据上:等列头出现。
async function waitCols(wrapper: VueWrapper, n = 2): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-test="mysql-col"]')).toHaveLength(n)
  })
}

// 第 r 行第 c 列单元格(data-test="mysql-cell")。
function cellAt(wrapper: VueWrapper, row: number, col: number): DOMWrapper<Element> {
  return wrapper.findAll('[data-test="mysql-row"]')[row].findAll('[data-test="mysql-cell"]')[col]
}

function mountBrowser(
  props: { connectionId: string; database: string; table: string } = {
    connectionId: 'm1',
    database: 'shop',
    table: 'users',
  },
  attach = false,
) {
  return mount(MysqlTableBrowser, { props, ...(attach ? { attachTo: document.body } : {}) })
}

describe('MysqlTableBrowser', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    wailsMocks.MysqlPageRows.mockReset()
    wailsMocks.MysqlTruncateTable.mockReset()
    wailsMocks.MysqlPreviewCellUpdate.mockReset()
    wailsMocks.MysqlUpdateCell.mockReset()
  })

  it('首屏:拉取第一页并渲染列头三行、行数据、主键角标与汇总', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    expect(pageRows).toHaveBeenCalledWith({
      connection_id: 'm1',
      database: 'shop',
      table: 'users',
      asc: true,
      limit: 200,
      offset: 0,
    })
    const cols = wrapper.findAll('[data-test="mysql-col"]')
    expect(cols.map((c) => c.find('[data-test="mysql-col-name"]').text())).toEqual(['id', 'name'])
    expect(cols.map((c) => c.find('[data-test="mysql-col-type"]').text())).toEqual(['int unsigned', 'varchar(64)'])
    // 注释仅非空时渲染第三行。
    expect(cols.map((c) => c.find('[data-test="mysql-col-comment"]').exists())).toEqual([true, false])
    expect(cols[0].find('[data-test="mysql-col-comment"]').text()).toBe('主键 ID')
    // 主键角标仅在 is_in_primary_key 列上。
    expect(cols[0].find('[data-test="mysql-pk-badge"]').exists()).toBe(true)
    expect(cols[1].find('[data-test="mysql-pk-badge"]').exists()).toBe(false)
    // 行渲染与 NULL 单元格。
    const rows = wrapper.findAll('[data-test="mysql-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].findAll('[data-test="mysql-cell"]').map((c) => c.text())).toEqual(['1', 'alice'])
    const nullCell = rows[1].findAll('[data-test="mysql-cell"]')[0]
    expect(nullCell.text()).toBe('NULL')
    expect(nullCell.classes()).toContain('cell-null')
    // 汇总条:库名.表名、引擎、近似行数(千分位)。
    expect(wrapper.find('[data-test="mysql-summary-table"]').text()).toBe('shop.users')
    expect(wrapper.find('[data-test="mysql-summary-engine"]').text()).toBe('InnoDB')
    expect(wrapper.find('[data-test="mysql-summary-rows"]').text()).toContain('4,096')
    // 有数据时不渲染字段结构面板。
    expect(wrapper.find('[data-test="mysql-fields-panel"]').exists()).toBe(false)
  })

  it('点列头排序经参数下发,同列第二次点击翻转方向', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.findAll('[data-test="mysql-col"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: true, offset: 0 }))
    })
    await wrapper.findAll('[data-test="mysql-col"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: false }))
    })
  })

  it('分页:上一页/下一页以 200 步进 offset,首尾正确禁用', async () => {
    pageRows.mockResolvedValue(fullPage())
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="mysql-row"]')).toHaveLength(200)
    })
    expect((wrapper.find('[data-test="btn-mysql-prev"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="btn-mysql-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
    expect(wrapper.find('[data-test="mysql-page-label"]').text()).toContain('2')
    await wrapper.find('[data-test="btn-mysql-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 400 }))
    })
    await wrapper.find('[data-test="btn-mysql-prev"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
  })

  it('WHERE 过滤应用后随请求下发并回到第一页', async () => {
    pageRows.mockResolvedValue(fullPage())
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="mysql-row"]')).toHaveLength(200)
    })
    await wrapper.find('[data-test="btn-mysql-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
    await wrapper.find('[data-test="mysql-where"]').setValue('age > 18')
    await wrapper.find('[data-test="mysql-where"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ where: 'age > 18', offset: 0 }))
    })
  })

  it('空表渲染字段结构面板而非网格', async () => {
    pageRows.mockResolvedValue(page({ rows: [], total_rows: 0 }))
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="mysql-fields-panel"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="mysql-grid"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="mysql-fields-panel"]').text()).toContain('表结构(共 2 字段)')
    const fieldRows = wrapper.findAll('[data-test="mysql-field-row"]')
    expect(fieldRows).toHaveLength(2)
    expect(fieldRows[0].find('[data-test="mysql-field-name"]').text()).toBe('id')
    expect(fieldRows[0].find('[data-test="mysql-field-type"]').text()).toBe('int unsigned')
    expect(fieldRows[0].find('[data-test="mysql-field-comment"]').text()).toBe('主键 ID')
    expect(fieldRows[1].find('[data-test="mysql-field-comment"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="mysql-grid-empty"]').text()).toContain('该表暂无数据')
  })

  it('无主键表:数据单元格只读,双击不出编辑框,悬浮提示无主键', async () => {
    pageRows.mockResolvedValue(
      page({
        primary_key: [],
        columns: [
          { name: 'id', type: 'int unsigned', comment: '' },
          { name: 'name', type: 'varchar(64)', comment: '' },
        ],
      }),
    )
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const cell = cellAt(wrapper, 0, 1)
    await cell.trigger('dblclick')
    expect(wrapper.find('[data-test="mysql-cell-editor"]').exists()).toBe(false)
    expect(wailsMocks.MysqlPreviewCellUpdate).not.toHaveBeenCalled()
    expect(wailsMocks.MysqlUpdateCell).not.toHaveBeenCalled()
    // 只读悬浮提示。
    expect(cell.attributes('title')).toContain('表无主键,不支持编辑')
    // 列头也不渲染主键角标。
    expect(wrapper.find('[data-test="mysql-pk-badge"]').exists()).toBe(false)
  })

  it('有主键编辑全链路:预览 where 仅主键列 → 弹窗展示 statement 与匹配行数 → 确认执行并刷新', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.MysqlPreviewCellUpdate.mockResolvedValue({
      statement: "UPDATE shop.users SET name = 'alice2' WHERE id = '1'",
      matched_rows: 3,
    })
    // attachTo:document.body 使输入框进入文档,自动聚焦才改变 activeElement。
    const wrapper = mountBrowser(undefined, true)
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="mysql-cell-editor"]')
    expect(editor.exists()).toBe(true)
    // 输入框承载原始值并自动聚焦。
    expect((editor.element as HTMLInputElement).value).toBe('alice')
    expect(document.activeElement).toBe(editor.element)
    await editor.setValue('alice2')
    await editor.trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(wailsMocks.MysqlPreviewCellUpdate).toHaveBeenCalledWith({
        connection_id: 'm1',
        database: 'shop',
        table: 'users',
        set: { column: 'name', value: 'alice2' },
        // where 仅主键列,取编辑前原值。
        where: [{ column: 'id', value: '1' }],
      })
    })
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    // 弹窗含 UPDATE 语句全文、匹配行数;N>1 追加多行警示。
    expect(msg).toContain("UPDATE shop.users SET name = 'alice2' WHERE id = '1'")
    expect(msg).toContain('匹配 3 行')
    expect(msg).toContain('将同时更新 3 行,请确认')
    const callsBefore = pageRows.mock.calls.length
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.MysqlUpdateCell).toHaveBeenCalledWith({
        connection_id: 'm1',
        database: 'shop',
        table: 'users',
        set: { column: 'name', value: 'alice2' },
        where: [{ column: 'id', value: '1' }],
      })
    })
    // 确认成功后刷新当前页:MysqlPageRows 再调用一次。
    await vi.waitFor(() => {
      expect(pageRows.mock.calls.length).toBe(callsBefore + 1)
    })
  })

  it('单行匹配不追加多行警示', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.MysqlPreviewCellUpdate.mockResolvedValue({
      statement: "UPDATE shop.users SET name = 'alice2' WHERE id = '1'",
      matched_rows: 1,
    })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    await wrapper.find('[data-test="mysql-cell-editor"]').setValue('alice2')
    await wrapper.find('[data-test="mysql-cell-editor"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('匹配 1 行')
    expect(msg).not.toContain('将同时更新')
  })

  it('NULL 单元格双击为空输入框,空输入提交写 NULL,主键原值 null 快照进 where', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.MysqlPreviewCellUpdate.mockResolvedValue({
      statement: 'UPDATE shop.users SET name = NULL WHERE id IS NULL',
      matched_rows: 1,
    })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    // 第二行 id 原值为 NULL:双击得到空输入框。
    await cellAt(wrapper, 1, 0).trigger('dblclick')
    expect((wrapper.find('[data-test="mysql-cell-editor"]').element as HTMLInputElement).value).toBe('')
    await wrapper.find('[data-test="mysql-cell-editor"]').trigger('keydown.esc')
    // 再编辑同行 name,清空后回车 = 写 NULL;where 中主键原值为 null(编辑前快照)。
    await cellAt(wrapper, 1, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="mysql-cell-editor"]')
    expect((editor.element as HTMLInputElement).value).toBe('bob')
    await editor.setValue('')
    await editor.trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(wailsMocks.MysqlPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          set: { column: 'name', value: null },
          where: [{ column: 'id', value: null }],
        }),
      )
    })
  })

  it('Esc/blur 取消编辑不发起任何请求', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser(undefined, true)
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    const editor = wrapper.find('[data-test="mysql-cell-editor"]')
    expect((editor.element as HTMLInputElement).value).toBe('alice')
    expect(document.activeElement).toBe(editor.element)
    await editor.trigger('keydown.esc')
    expect(wrapper.find('[data-test="mysql-cell-editor"]').exists()).toBe(false)
    expect(wailsMocks.MysqlPreviewCellUpdate).not.toHaveBeenCalled()
    expect(wailsMocks.MysqlUpdateCell).not.toHaveBeenCalled()
    // blur 同样退出编辑。
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    await wrapper.find('[data-test="mysql-cell-editor"]').trigger('blur')
    expect(wrapper.find('[data-test="mysql-cell-editor"]').exists()).toBe(false)
    expect(wailsMocks.MysqlPreviewCellUpdate).not.toHaveBeenCalled()
  })

  it('数据获取开始时丢弃未完成编辑态', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    expect(wrapper.find('[data-test="mysql-cell-editor"]').exists()).toBe(true)
    // 触发一次重拉(排序):编辑态随请求立即丢弃。
    await wrapper.findAll('[data-test="mysql-col"]')[0].trigger('click')
    expect(wrapper.find('[data-test="mysql-cell-editor"]').exists()).toBe(false)
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id' }))
    })
  })

  it('取消确认弹窗不执行、不刷新', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.MysqlPreviewCellUpdate.mockResolvedValue({
      statement: "UPDATE shop.users SET name = 'alice2' WHERE id = '1'",
      matched_rows: 1,
    })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    await wrapper.find('[data-test="mysql-cell-editor"]').setValue('alice2')
    await wrapper.find('[data-test="mysql-cell-editor"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    clickConfirmDialog('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
    expect(wailsMocks.MysqlUpdateCell).not.toHaveBeenCalled()
    // 未执行也就不刷新:仍只有初始 1 次分页请求。
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('预览失败在错误区展示且不执行', async () => {
    pageRows.mockResolvedValue(page())
    wailsMocks.MysqlPreviewCellUpdate.mockRejectedValue(new Error('预览失败'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    await wrapper.find('[data-test="mysql-cell-editor"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="mysql-error"]').text()).toContain('预览失败')
    })
    expect(wailsMocks.MysqlUpdateCell).not.toHaveBeenCalled()
  })

  it('TRUNCATE:确认弹窗含表名与引擎且为危险色,确认后执行并刷新', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-mysql-truncate"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('users')
    expect(msg).toContain('InnoDB')
    expect(msg).toContain('不可恢复')
    // 危险操作:确认按钮带 danger 样式。
    const okBtn = document.body.querySelector('[data-test="confirm-dialog-ok"]')
    expect(okBtn?.className).toContain('danger')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wailsMocks.MysqlTruncateTable).toHaveBeenCalledWith({
        connection_id: 'm1',
        database: 'shop',
        table: 'users',
      })
    })
    // 清空成功后重请求当前页。
    await vi.waitFor(() => {
      expect(pageRows.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('TRUNCATE 取消不执行', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-mysql-truncate"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    clickConfirmDialog('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
    expect(wailsMocks.MysqlTruncateTable).not.toHaveBeenCalled()
    expect(pageRows.mock.calls.length).toBe(1)
  })

  it('分页请求失败在错误区展示错误信息', async () => {
    pageRows.mockRejectedValue(new Error('查询失败:连接超时'))
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="mysql-error"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="mysql-error"]').text()).toContain('查询失败:连接超时')
  })

  it('外部切换 table prop 时重置分页并以新表重拉', async () => {
    pageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.setProps({ table: 'orders' })
    await vi.waitFor(() => {
      expect(pageRows).toHaveBeenLastCalledWith(expect.objectContaining({ table: 'orders', offset: 0 }))
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="mysql-summary-table"]').text()).toBe('shop.orders')
    })
  })

  it('保持列头横向铺开:表格按内容自然宽度(th 不套弹性布局)', () => {
    // 视觉对齐 CHTableBrowser 的防挤压契约:列数多时横向滚动而不是把列头
    // 压成竖排文字;th 保持 table-cell,弹性布局只在内层 div。
    const fileSrc = readFileSync(join(process.cwd(), 'src/components/kafka/MysqlTableBrowser.vue'), 'utf8')
    const tableBlock = fileSrc.match(/\.table \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(tableBlock).toContain('width: max-content')
    expect(tableBlock).toContain('min-width: 100%')
    const headBlock = fileSrc.match(/\.col-head \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(headBlock).toContain('white-space: nowrap')
  })
})
