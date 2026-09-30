import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import PostgresTableBrowser from './PostgresTableBrowser.vue'

// wailsjs 绑定尚未生成 Postgres 系列方法,测试整体替换该模块。
const appMocks = vi.hoisted(() => ({
  PostgresPageRows: vi.fn(),
  PostgresTruncateTable: vi.fn(),
  PostgresPreviewCellUpdate: vi.fn(),
  PostgresUpdateCell: vi.fn(),
  // 按行删除:预览 DELETE 语句全文与命中行数 / 执行删除。
  PostgresPreviewDeleteRow: vi.fn(),
  PostgresDeleteRow: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', () => appMocks)
const app = appMocks

interface PgPage {
  columns: { name: string; type: string; is_in_primary_key: boolean }[]
  rows: (string | null)[][]
  primary_key: string[]
  total_rows: number
}

function page(overrides: Partial<PgPage> = {}): PgPage {
  return {
    columns: [
      { name: 'id', type: 'integer', is_in_primary_key: true },
      { name: 'name', type: 'text', is_in_primary_key: false },
    ],
    rows: [
      ['1', 'alice'],
      ['2', 'bob'],
    ],
    primary_key: ['id'],
    total_rows: 2,
    ...overrides,
  }
}

function mountBrowser(props: Record<string, unknown> = {}) {
  return mount(PostgresTableBrowser, {
    props: {
      connectionId: 'pg1',
      database: 'shop',
      schema: 'public',
      relation: 'users',
      relationType: 'table',
      ...props,
    },
    attachTo: document.body,
  })
}

async function waitCols(wrapper: VueWrapper): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-test="pg-col"]')).toHaveLength(2)
  })
}

function confirmDialog(): HTMLElement | null {
  return document.body.querySelector('[data-test="confirm-dialog"]')
}

function clickConfirmDialog(test: string): void {
  const btn = document.body.querySelector(`[data-test="${test}"]`) as HTMLButtonElement | null
  btn?.click()
}

beforeEach(() => {
  vi.clearAllMocks()
  document.body.innerHTML = ''
  appMocks.PostgresTruncateTable.mockResolvedValue(undefined)
  appMocks.PostgresUpdateCell.mockResolvedValue(undefined)
})

describe('PostgresTableBrowser', () => {
  it('挂载时按 connection/database/schema/relation 请求第一页并渲染列与行', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    expect(appMocks.PostgresPageRows).toHaveBeenCalledWith({
      connection_id: 'pg1',
      database: 'shop',
      schema: 'public',
      relation: 'users',
      asc: true,
      limit: 200,
      offset: 0,
    })
    expect(wrapper.find('[data-test="pg-summary-table"]').text()).toBe('shop.public.users')
    expect(wrapper.findAll('[data-test="pg-row"]')).toHaveLength(2)
    expect(wrapper.find('[data-test="pg-summary-rows"]').text()).toContain('2')
  })

  it('提交过滤条件回第一页并携带 where', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="pg-where"]').setValue("name = 'alice'")
    await wrapper.find('[data-test="btn-pg-apply"]').trigger('click')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows).toHaveBeenLastCalledWith(
        expect.objectContaining({ where: "name = 'alice'", offset: 0 }),
      )
    })
  })

  it('点击列头排序翻转方向并携带 order_by', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.findAll('[data-test="pg-col"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: true }))
    })
    await wrapper.findAll('[data-test="pg-col"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: false }))
    })
  })

  it('无主键表单元格只读(不出现编辑框)', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page({ primary_key: [] }))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.findAll('[data-test="pg-cell"]')[0].trigger('dblclick')
    expect(wrapper.find('[data-test="pg-cell-editor"]').exists()).toBe(false)
  })

  it('主键表双击单元格编辑,回车预览后确认执行并刷新', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewCellUpdate.mockResolvedValue({
      statement: "UPDATE public.users SET name = 'alice2' WHERE id = '1'",
      matched_rows: 1,
    })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.findAll('[data-test="pg-cell"]')[1].trigger('dblclick')
    await wrapper.find('[data-test="pg-cell-editor"]').setValue('alice2')
    await wrapper.find('[data-test="pg-cell-editor"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPreviewCellUpdate).toHaveBeenCalledWith({
        connection_id: 'pg1',
        database: 'shop',
        schema: 'public',
        relation: 'users',
        relation_kind: 'table',
        set: { column: 'name', value: 'alice2' },
        where: [{ column: 'id', value: '1' }],
      })
    })
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(appMocks.PostgresUpdateCell).toHaveBeenCalledWith(
        expect.objectContaining({ schema: 'public', relation: 'users', relation_kind: 'table', set: { column: 'name', value: 'alice2' } }),
      )
    })
    // 执行成功后重新拉取当前页。
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('TRUNCATE 确认后按 schema/relation 执行并刷新', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-pg-truncate"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(appMocks.PostgresTruncateTable).toHaveBeenCalledWith({
        connection_id: 'pg1',
        database: 'shop',
        schema: 'public',
        relation: 'users',
        relation_kind: 'table',
      })
    })
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('视图类型在摘要中标注 kind', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser({ relationType: 'view' })
    await waitCols(wrapper)
    expect(wrapper.find('[data-test="pg-summary-type"]').text()).toBe('view')
  })

  it('分页请求失败在错误区展示错误信息', async () => {
    appMocks.PostgresPageRows.mockRejectedValue(new Error('查询失败:连接超时'))
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-error"]').text()).toContain('查询失败:连接超时')
    })
  })

  it('外部切换 relation prop 时重置分页并以新表重拉', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.setProps({ relation: 'orders' })
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ relation: 'orders', offset: 0 }))
    })
  })
})

describe('relation_kind 透传', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    appMocks.PostgresTruncateTable.mockResolvedValue(undefined)
  })

  it('relationType=view 时隐藏 TRUNCATE,单元格更新请求携带 relation_kind=view', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewCellUpdate.mockResolvedValue({ statement: 'UPDATE 1', matched_rows: 1 })
    const wrapper = mountBrowser({ relationType: 'view' })
    await waitCols(wrapper)
    expect(wrapper.find('[data-test="btn-pg-truncate"]').exists()).toBe(false)
    await wrapper.findAll('[data-test="pg-cell"]')[1].trigger('dblclick')
    await wrapper.find('[data-test="pg-cell-editor"]').setValue('alice2')
    await wrapper.find('[data-test="pg-cell-editor"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPreviewCellUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ relation: 'users', relation_kind: 'view' }),
      )
    })
  })
})

describe('P1/P2 修正', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    appMocks.PostgresTruncateTable.mockResolvedValue(undefined)
    appMocks.PostgresUpdateCell.mockResolvedValue(undefined)
  })

  it('仅 table 显示「清空数据」按钮,视图与物化视图隐藏', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const tableWrapper = mountBrowser({ relationType: 'table' })
    await waitCols(tableWrapper)
    expect(tableWrapper.find('[data-test="btn-pg-truncate"]').exists()).toBe(true)
    tableWrapper.unmount()
    const viewWrapper = mountBrowser({ relationType: 'view' })
    await waitCols(viewWrapper)
    expect(viewWrapper.find('[data-test="btn-pg-truncate"]').exists()).toBe(false)
    viewWrapper.unmount()
    const matWrapper = mountBrowser({ relationType: 'materialized_view' })
    await waitCols(matWrapper)
    expect(matWrapper.find('[data-test="btn-pg-truncate"]').exists()).toBe(false)
  })

  it('列头渲染主键角标,不再依赖 comment 字段', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    expect(wrapper.find('[data-test="pg-pk-badge"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="pg-col-comment"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="pg-field-comment"]').exists()).toBe(false)
  })

  it('排序列头支持键盘:聚焦后 Enter 触发排序并带 aria-sort', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const th = wrapper.findAll('[data-test="pg-col"]')[0]
    expect(th.attributes('tabindex')).toBe('0')
    await th.trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: true }))
    })
    // 升序时 aria-sort=ascending,降序翻转。
    await th.trigger('keydown.space')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: false }))
      expect(th.attributes('aria-sort')).toBe('descending')
    })
  })

  it('可编辑单元格支持键盘进入编辑(聚焦后 Enter)', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewCellUpdate.mockResolvedValue({ statement: 'UPDATE 1', matched_rows: 1 })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const cell = wrapper.findAll('[data-test="pg-cell"]')[1]
    expect(cell.attributes('tabindex')).toBe('0')
    await cell.trigger('keydown.enter')
    expect(wrapper.find('[data-test="pg-cell-editor"]').exists()).toBe(true)
  })
})

describe('按行删除', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    document.body.innerHTML = ''
    appMocks.PostgresDeleteRow.mockResolvedValue(undefined)
  })

  // 第 ri 行的行首删除按钮。
  function deleteBtn(wrapper: VueWrapper, row: number) {
    return wrapper.findAll('[data-test="pg-row"]')[row].find('[data-test="btn-row-delete"]')
  }

  it('有主键的表每行渲染行首删除按钮且可点', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const btns = wrapper.findAll('[data-test="btn-row-delete"]')
    expect(btns).toHaveLength(2)
    expect((btns[0].element as HTMLButtonElement).disabled).toBe(false)
  })

  it('无主键时删除按钮禁用并以 title 说明原因', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page({ primary_key: [] }))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const btn = wrapper.find('[data-test="btn-row-delete"]')
    expect(btn.exists()).toBe(true)
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(btn.attributes('title')).toContain('结果无主键,无法定位行')
  })

  it('视图与物化视图不渲染删除按钮', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    const view = mountBrowser({ relationType: 'view' })
    await waitCols(view)
    expect(view.find('[data-test="btn-row-delete"]').exists()).toBe(false)
    view.unmount()
    const mat = mountBrowser({ relationType: 'materialized_view' })
    await waitCols(mat)
    expect(mat.find('[data-test="btn-row-delete"]').exists()).toBe(false)
  })

  it('点击删除:按主键原值预览 DELETE,弹窗含语句全文、命中行数与不可恢复', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewDeleteRow.mockResolvedValue({
      statement: "DELETE FROM public.users WHERE id = '1'",
      matched_rows: 1,
    })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await deleteBtn(wrapper, 0).trigger('click')
    await vi.waitFor(() => {
      expect(appMocks.PostgresPreviewDeleteRow).toHaveBeenCalledWith({
        connection_id: 'pg1',
        database: 'shop',
        schema: 'public',
        relation: 'users',
        relation_kind: 'table',
        where: [{ column: 'id', value: '1' }],
      })
    })
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain("DELETE FROM public.users WHERE id = '1'")
    expect(msg).toContain('命中 1 行')
    expect(msg).toContain('此操作不可恢复')
    expect(msg).not.toContain('已禁止删除')
  })

  it('命中多行:弹窗强警示,确认不执行、不刷新且弹窗保持', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewDeleteRow.mockResolvedValue({
      statement: "DELETE FROM public.users WHERE id = '1'",
      matched_rows: 3,
    })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await deleteBtn(wrapper, 0).trigger('click')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('命中 3 行')
    expect(msg).toContain('已禁止删除')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    expect(appMocks.PostgresDeleteRow).not.toHaveBeenCalled()
    // 不执行也就不刷新:仍只有初始 1 次分页请求。
    expect(appMocks.PostgresPageRows.mock.calls.length).toBe(1)
  })

  it('确认后执行删除并刷新当前页', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewDeleteRow.mockResolvedValue({
      statement: "DELETE FROM public.users WHERE id = '2'",
      matched_rows: 1,
    })
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await deleteBtn(wrapper, 1).trigger('click')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    const callsBefore = appMocks.PostgresPageRows.mock.calls.length
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(appMocks.PostgresDeleteRow).toHaveBeenCalledWith({
        connection_id: 'pg1',
        database: 'shop',
        schema: 'public',
        relation: 'users',
        relation_kind: 'table',
        where: [{ column: 'id', value: '2' }],
      })
    })
    // 删除成功后重发当前页请求。
    await vi.waitFor(() => {
      expect(appMocks.PostgresPageRows.mock.calls.length).toBe(callsBefore + 1)
    })
  })

  it('删除执行失败在错误区展示且不刷新', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewDeleteRow.mockResolvedValue({
      statement: "DELETE FROM public.users WHERE id = '1'",
      matched_rows: 1,
    })
    appMocks.PostgresDeleteRow.mockRejectedValue(new Error('删除失败:权限不足'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await deleteBtn(wrapper, 0).trigger('click')
    await vi.waitFor(() => {
      expect(confirmDialog()).not.toBeNull()
    })
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-error"]').text()).toContain('删除失败:权限不足')
    })
    expect(appMocks.PostgresDeleteRow).toHaveBeenCalledTimes(1)
    expect(appMocks.PostgresPageRows.mock.calls.length).toBe(1)
  })

  it('删除预览失败在错误区展示且不弹确认框', async () => {
    appMocks.PostgresPageRows.mockResolvedValue(page())
    appMocks.PostgresPreviewDeleteRow.mockRejectedValue(new Error('删除预览失败'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await deleteBtn(wrapper, 0).trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="pg-error"]').text()).toContain('删除预览失败')
    })
    expect(confirmDialog()).toBeNull()
    expect(appMocks.PostgresDeleteRow).not.toHaveBeenCalled()
  })
})
