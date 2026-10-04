import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { HivePageRowsResult, HiveTableColumnsResult } from '@/api/types'
import HiveTableBrowser from './HiveTableBrowser.vue'

// 组件经 getApi() 可选链调用,测试用 setApi 注入 fake API(与 ConnectionTree
// spec 同一注入惯例;只注入本组件用到的 Hive 方法)。
const hivePageRows = vi.fn()
const hiveTableColumns = vi.fn()
const hiveTruncateTable = vi.fn()

function fakeApi(): Api {
  return {
    hivePageRows,
    hiveTableColumns,
    hiveTruncateTable,
  } as unknown as Api
}

// hivePageRows 契约形状:两列两行,含一个 NULL。
const page = (over: Partial<HivePageRowsResult> = {}): HivePageRowsResult => ({
  columns: [
    { name: 'id', type: 'bigint', comment: '主键 ID' },
    { name: 'name', type: 'string', comment: '' },
  ],
  rows: [
    ['1', 'alice'],
    [null, 'bob'],
  ],
  total_rows: 4096,
  ...over,
})

// 500 行:下一页按钮只在整页数据时可点。
const fullPage = (): HivePageRowsResult => ({
  ...page(),
  rows: Array.from({ length: 500 }, (_, i) => [String(i), 'x']),
})

const managedMeta = (over: Partial<HiveTableColumnsResult> = {}): HiveTableColumnsResult => ({
  columns: [],
  partition_columns: [],
  transactional: false,
  primary_key: [],
  ddl: '',
  table_type: 'MANAGED_TABLE',
  ...over,
})

// ConfirmDialog teleport 到 body。
function confirmDialog(): HTMLElement | null {
  return document.body.querySelector('[data-test="confirm-dialog"]')
}
function clickConfirmDialog(testId: string): void {
  document.body.querySelector(`[data-test="${testId}"]`)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function mountBrowser(
  props: { connectionId: string; database: string; table: string } = {
    connectionId: 'h1',
    database: 'ods',
    table: 'events',
  },
) {
  return mount(HiveTableBrowser, { props })
}

async function waitCols(wrapper: VueWrapper, n = 2): Promise<void> {
  await vi.waitFor(() => {
    expect(wrapper.findAll('[data-test="hive-col"]')).toHaveLength(n)
  })
}

function cellAt(wrapper: VueWrapper, row: number, col: number): DOMWrapper<Element> {
  return wrapper.findAll('[data-test="hive-row"]')[row].findAll('[data-test="hive-cell"]')[col]
}

describe('HiveTableBrowser', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    hivePageRows.mockReset()
    hiveTableColumns.mockReset()
    hiveTruncateTable.mockReset()
    setApi(fakeApi())
  })

  it('首屏:按 limit 500/offset 0 请求并渲染列头两行、行数据、NULL 单元格与汇总', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    expect(hivePageRows).toHaveBeenCalledWith({
      connection_id: 'h1',
      database: 'ods',
      table: 'events',
      limit: 500,
      offset: 0,
    })
    const cols = wrapper.findAll('[data-test="hive-col"]')
    expect(cols.map((c) => c.find('[data-test="hive-col-name"]').text())).toEqual(['id', 'name'])
    expect(cols.map((c) => c.find('[data-test="hive-col-type"]').text())).toEqual(['bigint', 'string'])
    expect(cols.map((c) => c.find('[data-test="hive-col-comment"]').exists())).toEqual([true, false])
    // 行渲染与 NULL 单元格。
    const rows = wrapper.findAll('[data-test="hive-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].findAll('[data-test="hive-cell"]').map((c) => c.text())).toEqual(['1', 'alice'])
    const nullCell = rows[1].findAll('[data-test="hive-cell"]')[0]
    expect(nullCell.text()).toBe('NULL')
    expect(nullCell.classes()).toContain('cell-null')
    // 汇总条:库名.表名、表类型、近似行数(千分位)。
    expect(wrapper.find('[data-test="hive-summary-table"]').text()).toBe('ods.events')
    expect(wrapper.find('[data-test="hive-summary-type"]').text()).toBe('MANAGED_TABLE')
    expect(wrapper.find('[data-test="hive-summary-rows"]').text()).toContain('4,096')
  })

  it('挂载即探测表类型(hiveTableColumns),失败时汇总降级为 —', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta({ table_type: 'EXTERNAL_TABLE' }))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    expect(hiveTableColumns).toHaveBeenCalledWith({ connection_id: 'h1', database: 'ods', table: 'events' })
    expect(wrapper.find('[data-test="hive-summary-type"]').text()).toBe('EXTERNAL_TABLE')

    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockRejectedValue(new Error('探测失败'))
    const wrapper2 = mountBrowser({ connectionId: 'h1', database: 'ods', table: 'v2' })
    await waitCols(wrapper2)
    expect(wrapper2.find('[data-test="hive-summary-type"]').text()).toBe('—')
    // 探测失败按未知类型处理:清空按钮禁用。
    expect((wrapper2.find('[data-test="btn-hive-truncate"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('分页:上一页/下一页以 500 步进 offset,首尾正确禁用,页码标签推进', async () => {
    hivePageRows.mockResolvedValue(fullPage())
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="hive-row"]')).toHaveLength(500)
    })
    expect((wrapper.find('[data-test="btn-hive-prev"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="btn-hive-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(hivePageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 500 }))
    })
    expect(wrapper.find('[data-test="hive-page-label"]').text()).toContain('2')
    await wrapper.find('[data-test="btn-hive-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(hivePageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 1000 }))
    })
    await wrapper.find('[data-test="btn-hive-prev"]').trigger('click')
    await vi.waitFor(() => {
      expect(hivePageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 500 }))
    })
  })

  it('空表渲染字段结构面板而非网格', async () => {
    hivePageRows.mockResolvedValue(page({ rows: [], total_rows: 0 }))
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="hive-fields-panel"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="hive-grid"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="hive-fields-panel"]').text()).toContain('表结构(共 2 字段)')
    const fieldRows = wrapper.findAll('[data-test="hive-field-row"]')
    expect(fieldRows).toHaveLength(2)
    expect(fieldRows[0].find('[data-test="hive-field-name"]').text()).toBe('id')
    expect(fieldRows[0].find('[data-test="hive-field-type"]').text()).toBe('bigint')
    expect(fieldRows[0].find('[data-test="hive-field-comment"]').text()).toBe('主键 ID')
    expect(wrapper.find('[data-test="hive-grid-empty"]').text()).toContain('该表暂无数据')
  })

  it('列头不提供排序:点击列头不发起第二次请求', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.findAll('[data-test="hive-col"]')[0].trigger('click')
    await new Promise((r) => setTimeout(r, 0))
    expect(hivePageRows).toHaveBeenCalledTimes(1)
  })

  it('单元格只读:双击不出编辑框,不发起任何写请求', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await cellAt(wrapper, 0, 1).trigger('dblclick')
    expect(wrapper.find('[data-test="hive-cell-editor"]').exists()).toBe(false)
    expect(hiveTruncateTable).not.toHaveBeenCalled()
  })

  it('内部表:清空数据确认弹窗含表名与类型,确认后调用 hiveTruncateTable 并刷新', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta({ table_type: 'MANAGED_TABLE' }))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const btn = wrapper.find('[data-test="btn-hive-truncate"]')
    expect((btn.element as HTMLButtonElement).disabled).toBe(false)
    await btn.trigger('click')
    expect(confirmDialog()).not.toBeNull()
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('events')
    expect(msg).toContain('MANAGED_TABLE')
    expect(msg).toContain('不可恢复')
    const okBtn = document.body.querySelector('[data-test="confirm-dialog-ok"]')
    expect(okBtn?.className).toContain('danger')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(hiveTruncateTable).toHaveBeenCalledWith({
        connection_id: 'h1',
        database: 'ods',
        table: 'events',
      })
    })
    // 清空成功后重请求第一页。
    await vi.waitFor(() => {
      expect(hivePageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 0 }))
      expect(hivePageRows.mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('非内部表(外部表/视图):清空按钮禁用并以 title 说明原因,确认弹窗不出现', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta({ table_type: 'EXTERNAL_TABLE' }))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    const btn = wrapper.find('[data-test="btn-hive-truncate"]')
    expect((btn.element as HTMLButtonElement).disabled).toBe(true)
    expect(btn.attributes('title')).toContain('仅内部表(MANAGED_TABLE)支持清空')
    // 禁用按钮点击不弹确认(浏览器语义下不会触发;此处防御性断言)。
    expect(confirmDialog()).toBeNull()
    expect(hiveTruncateTable).not.toHaveBeenCalled()
  })

  it('TRUNCATE 取消不执行', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-hive-truncate"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    clickConfirmDialog('confirm-dialog-cancel')
    await vi.waitFor(() => {
      expect(confirmDialog()).toBeNull()
    })
    expect(hiveTruncateTable).not.toHaveBeenCalled()
    expect(hivePageRows.mock.calls.length).toBe(1)
  })

  it('分页请求失败在错误区展示错误信息', async () => {
    hivePageRows.mockRejectedValue(new Error('查询失败:连接超时'))
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="hive-error"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="hive-error"]').text()).toContain('查询失败:连接超时')
  })

  it('清空执行失败在错误区展示错误信息', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta())
    hiveTruncateTable.mockRejectedValue(new Error('清空失败:外部表不可清空'))
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-hive-truncate"]').trigger('click')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="hive-error"]').text()).toContain('清空失败:外部表不可清空')
    })
  })

  it('外部切换 table prop 时重置分页并以新表重拉第一页与表类型', async () => {
    hivePageRows.mockResolvedValue(page())
    hiveTableColumns.mockResolvedValue(managedMeta())
    const wrapper = mountBrowser()
    await waitCols(wrapper)
    hivePageRows.mockClear()
    hiveTableColumns.mockClear()
    await wrapper.setProps({ table: 'users' })
    await vi.waitFor(() => {
      expect(hivePageRows).toHaveBeenLastCalledWith(expect.objectContaining({ table: 'users', offset: 0 }))
      expect(hiveTableColumns).toHaveBeenLastCalledWith(
        expect.objectContaining({ table: 'users' }),
      )
    })
    expect(wrapper.find('[data-test="hive-summary-table"]').text()).toBe('ods.users')
  })

  it('保持列头横向铺开:表格按内容自然宽度(th 不套弹性布局)', async () => {
    // 视觉对齐 MysqlTableBrowser 的防挤压契约(经 vitest 静态断言源码样式)。
    const { readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const fileSrc = readFileSync(join(process.cwd(), 'src/components/kafka/HiveTableBrowser.vue'), 'utf8')
    const tableBlock = fileSrc.match(/\.table \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(tableBlock).toContain('width: max-content')
    expect(tableBlock).toContain('min-width: 100%')
    const headBlock = fileSrc.match(/\.col-head \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(headBlock).toContain('white-space: nowrap')
  })
})
