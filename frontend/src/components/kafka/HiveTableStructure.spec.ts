import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { HiveTableColumnsResult } from '@/api/types'
import HiveTableStructure from './HiveTableStructure.vue'

// 组件经 getApi() 可选链调用,测试用 setApi 注入 fake API。
const hiveTableColumns = vi.fn()
const hiveAlterTable = vi.fn()

function fakeApi(): Api {
  return {
    hiveTableColumns,
    hiveAlterTable,
  } as unknown as Api
}

const meta = (over: Partial<HiveTableColumnsResult> = {}): HiveTableColumnsResult => ({
  columns: [
    { name: 'id', type: 'bigint', comment: '主键' },
    { name: 'name', type: 'string', comment: '' },
  ],
  partition_columns: [{ name: 'dt', type: 'string', comment: '日期分区' }],
  transactional: false,
  primary_key: [],
  ddl: 'CREATE TABLE `ods.events` (`id` bigint) PARTITIONED BY (`dt` string)',
  table_type: 'MANAGED_TABLE',
  ...over,
})

// teleport 到 body 的弹窗节点。
function dialogEl(): HTMLElement | null {
  return document.body.querySelector('[data-test="hive-structure-dialog"]')
}
function bodyTestEl(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}

async function openDialog(propsOver: Record<string, string> = {}): Promise<void> {
  mount(HiveTableStructure, {
    props: {
      show: true,
      connectionId: 'h1',
      database: 'ods',
      table: 'events',
      ...propsOver,
    },
  })
  await vi.waitFor(() => {
    expect(bodyTestEl('structure-column-row')).not.toBeNull()
  })
}

describe('HiveTableStructure', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
    hiveTableColumns.mockReset()
    hiveAlterTable.mockReset()
    hiveTableColumns.mockResolvedValue(meta())
    hiveAlterTable.mockResolvedValue(undefined)
    setApi(fakeApi())
  })

  it('加载:hiveTableColumns 拉元数据,普通列在前、分区列随后只读展示', async () => {
    await openDialog()
    expect(hiveTableColumns).toHaveBeenCalledWith({ connection_id: 'h1', database: 'ods', table: 'events' })
    const rows = Array.from(document.body.querySelectorAll('[data-test="structure-column-row"]'))
    expect(rows).toHaveLength(3)
    // 列名与分区徽标。
    const names = rows.map((r) => r.querySelector('[data-test="column-name"]')?.textContent)
    expect(names).toEqual(['id', 'name', 'dt'])
    expect(rows[2].querySelector('[data-test="partition-badge"]')?.textContent).toContain('分区')
    // 分区行的类型/注释输入禁用(分区列不可改)。
    const partType = rows[2].querySelector('[data-test="column-type"]') as HTMLInputElement
    const partComment = rows[2].querySelector('[data-test="column-comment"]') as HTMLInputElement
    expect(partType.disabled).toBe(true)
    expect(partComment.disabled).toBe(true)
    // 头部显示表类型;无主键列(无 🔑 / 主键表头)。
    expect(dialogEl()?.textContent).toContain('MANAGED_TABLE')
    expect(dialogEl()?.querySelectorAll('th').length).toBe(5)
    const headerTexts = Array.from(dialogEl()?.querySelectorAll('th') ?? []).map((th) => th.textContent)
    expect(headerTexts).not.toContain('主键')
  })

  it('新增列(仅名称/类型/注释,追加表尾):保存 diff 的 add_columns 含三组以外为空', async () => {
    await openDialog()
    ;(bodyTestEl('btn-add-column') as HTMLElement).click()
    await nextTick()
    const nameInput = bodyTestEl('add-name') as HTMLInputElement
    const typeInput = bodyTestEl('add-type') as HTMLInputElement
    const commentInput = bodyTestEl('add-comment') as HTMLInputElement
    nameInput.value = 'extra'
    nameInput.dispatchEvent(new Event('input', { bubbles: true }))
    typeInput.value = 'double'
    typeInput.dispatchEvent(new Event('input', { bubbles: true }))
    commentInput.value = '新列'
    commentInput.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(bodyTestEl('btn-confirm-add-column') as HTMLElement).click()
    await nextTick()
    // 新增行出现在表尾(分区列之后);列名承载在 input value 上。
    const rows = Array.from(document.body.querySelectorAll('[data-test="structure-column-row"]'))
    expect(rows).toHaveLength(4)
    expect((rows[3].querySelector('[data-test="column-name"]') as HTMLInputElement).value).toBe('extra')
    ;(bodyTestEl('btn-structure-save') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(hiveAlterTable).toHaveBeenCalledTimes(1)
    })
    expect(hiveAlterTable).toHaveBeenCalledWith({
      connection_id: 'h1',
      database: 'ods',
      table: 'events',
      add_columns: [{ name: 'extra', type: 'double', comment: '新列' }],
      modify_columns: [],
      drop_columns: [],
    })
    // 保存成功后重新加载并显示成功提示(等重载完成,loading 骨架退场)。
    await vi.waitFor(() => {
      expect(hiveTableColumns).toHaveBeenCalledTimes(2)
      expect(bodyTestEl('structure-saved')?.textContent).toContain('表结构已更新')
    })
  })

  it('修改列类型/注释进入 modify_columns(不改名);零编辑行不产生 modify', async () => {
    await openDialog()
    const rows = Array.from(document.body.querySelectorAll('[data-test="structure-column-row"]'))
    // 修改第一列(id)的类型与第二列(name)的注释;分区列保持不动。
    const idType = rows[0].querySelector('[data-test="column-type"]') as HTMLInputElement
    idType.value = 'int'
    idType.dispatchEvent(new Event('input', { bubbles: true }))
    const nameComment = rows[1].querySelector('[data-test="column-comment"]') as HTMLInputElement
    nameComment.value = '用户名'
    nameComment.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(bodyTestEl('btn-structure-save') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(hiveAlterTable).toHaveBeenCalledTimes(1)
    })
    expect(hiveAlterTable).toHaveBeenCalledWith(
      expect.objectContaining({
        modify_columns: [
          { name: 'id', type: 'int', comment: '主键' },
          { name: 'name', type: 'string', comment: '用户名' },
        ],
        add_columns: [],
        drop_columns: [],
      }),
    )
    // modify 保留原列名(不支持改列名)。
    const payload = hiveAlterTable.mock.calls[0][0] as { modify_columns: { name: string }[] }
    expect(payload.modify_columns.map((c) => c.name)).toEqual(['id', 'name'])
  })

  it('删除列进入 drop_columns;分区列移除按钮禁用', async () => {
    await openDialog()
    const rows = Array.from(document.body.querySelectorAll('[data-test="structure-column-row"]'))
    // 移除第一列(id)。
    const dropBtn = rows[0].querySelector('[data-test="btn-drop-column"]') as HTMLButtonElement
    dropBtn.click()
    await nextTick()
    expect(rows[0].className).toContain('row-drop')
    // 分区列的移除按钮禁用。
    const partDrop = rows[2].querySelector('[data-test="btn-drop-column"]') as HTMLButtonElement
    expect(partDrop.disabled).toBe(true)
    ;(bodyTestEl('btn-structure-save') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(hiveAlterTable).toHaveBeenCalledTimes(1)
    })
    expect(hiveAlterTable).toHaveBeenCalledWith(
      expect.objectContaining({
        drop_columns: ['id'],
        add_columns: [],
        modify_columns: [],
      }),
    )
  })

  it('移除可撤销:撤销后回到无改动态,保存按钮禁用不发起请求', async () => {
    await openDialog()
    const rows = Array.from(document.body.querySelectorAll('[data-test="structure-column-row"]'))
    const dropBtn = rows[0].querySelector('[data-test="btn-drop-column"]') as HTMLButtonElement
    dropBtn.click()
    await nextTick()
    expect((dropBtn as HTMLElement).textContent).toContain('撤销')
    const saveBtn = bodyTestEl('btn-structure-save') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(false)
    dropBtn.click()
    await nextTick()
    expect((dropBtn as HTMLElement).textContent).toContain('移除')
    // 撤销后 drop_columns 清空 = 无改动,保存回到禁用态。
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(hiveAlterTable).not.toHaveBeenCalled()
  })

  it('无改动时保存按钮禁用,不发起 hiveAlterTable', async () => {
    await openDialog()
    const saveBtn = bodyTestEl('btn-structure-save') as HTMLButtonElement
    expect(saveBtn.disabled).toBe(true)
    saveBtn.click()
    await new Promise((r) => setTimeout(r, 0))
    expect(hiveAlterTable).not.toHaveBeenCalled()
  })

  it('保存失败在弹窗内展示错误;ACID 表头部带 ACID 徽标', async () => {
    hiveTableColumns.mockResolvedValue(meta({ transactional: true }))
    hiveAlterTable.mockRejectedValue(new Error('类型变更不兼容'))
    await openDialog()
    expect(dialogEl()?.textContent).toContain('ACID')
    const rows = Array.from(document.body.querySelectorAll('[data-test="structure-column-row"]'))
    const idType = rows[0].querySelector('[data-test="column-type"]') as HTMLInputElement
    idType.value = 'int'
    idType.dispatchEvent(new Event('input', { bubbles: true }))
    await nextTick()
    ;(bodyTestEl('btn-structure-save') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(bodyTestEl('structure-save-error')?.textContent).toContain('类型变更不兼容')
    })
  })

  it('查看 DDL 折叠展示 SHOW CREATE TABLE 原文', async () => {
    await openDialog()
    expect(bodyTestEl('structure-ddl')).toBeNull()
    ;(bodyTestEl('btn-toggle-ddl') as HTMLElement).click()
    await nextTick()
    expect(bodyTestEl('structure-ddl')?.textContent).toContain('CREATE TABLE')
  })

  it('加载失败展示错误并支持重试', async () => {
    hiveTableColumns.mockRejectedValueOnce(new Error('连接不可用'))
    mount(HiveTableStructure, {
      props: { show: true, connectionId: 'h1', database: 'ods', table: 'events' },
    })
    await vi.waitFor(() => {
      expect(bodyTestEl('structure-load-error')?.textContent).toContain('连接不可用')
    })
    expect(hiveAlterTable).not.toHaveBeenCalled()
    hiveTableColumns.mockResolvedValue(meta())
    ;(bodyTestEl('btn-structure-retry') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(bodyTestEl('structure-column-row')).not.toBeNull()
    })
  })

  it('关闭按钮 emit close', async () => {
    const wrapper = mount(HiveTableStructure, {
      props: { show: true, connectionId: 'h1', database: 'ods', table: 'events' },
    })
    await vi.waitFor(() => {
      expect(bodyTestEl('structure-column-row')).not.toBeNull()
    })
    ;(bodyTestEl('btn-structure-close') as HTMLElement).click()
    await nextTick()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
