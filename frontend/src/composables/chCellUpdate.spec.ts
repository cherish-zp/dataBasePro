import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as App from '../../wailsjs/go/backend/App'
import { useCHCellUpdate, type CHCellUpdateTarget } from './chCellUpdate'

// vi.mock 会被提升到文件顶部,因此 mocks 必须用 vi.hoisted 创建,
// 否则工厂执行时 cellUpdateMocks 尚未初始化(TDZ)。
// vi.mock 按解析后的绝对路径匹配,相对路径拼写无需与导入方一致。
const cellUpdateMocks = vi.hoisted(() => ({
  CHPreviewCellUpdate: vi.fn(),
  CHUpdateCell: vi.fn(),
}))
vi.mock('../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../wailsjs/go/backend/App')>(
    '../../wailsjs/go/backend/App',
  )
  return { ...actual, ...cellUpdateMocks }
})
const app = App as unknown as typeof cellUpdateMocks

const PREVIEW = {
  statement: "ALTER TABLE `default`.`events` UPDATE `status` = 'done' WHERE `id` = 42",
  matched_rows: 1,
}

function makeTarget(overrides: Partial<CHCellUpdateTarget> = {}): CHCellUpdateTarget {
  return {
    connection_id: 'conn-1',
    database: 'default',
    table: 'events',
    set: { column: 'status', type: 'String', value: 'done' },
    where: [{ column: 'id', type: 'UInt64', value: '42' }],
    ...overrides,
  }
}

beforeEach(() => {
  cellUpdateMocks.CHPreviewCellUpdate.mockReset()
  cellUpdateMocks.CHUpdateCell.mockReset()
  cellUpdateMocks.CHPreviewCellUpdate.mockResolvedValue({ ...PREVIEW })
  cellUpdateMocks.CHUpdateCell.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('request(预览)', () => {
  it('成功:按原样发送 target,填充 statement/matchedRows 并打开确认弹窗', async () => {
    const cu = useCHCellUpdate()
    const t = makeTarget()

    await cu.request(t)

    expect(cellUpdateMocks.CHPreviewCellUpdate).toHaveBeenCalledTimes(1)
    expect(cellUpdateMocks.CHPreviewCellUpdate).toHaveBeenCalledWith({
      connection_id: 'conn-1',
      database: 'default',
      table: 'events',
      set: { column: 'status', type: 'String', value: 'done' },
      where: [{ column: 'id', type: 'UInt64', value: '42' }],
    })
    expect(cu.statement.value).toBe(PREVIEW.statement)
    expect(cu.matchedRows.value).toBe(1)
    expect(cu.confirmOpen.value).toBe(true)
    expect(cu.previewing.value).toBe(false)
    expect(cu.error.value).toBeNull()
  })

  it('预览进行中 previewing=true 且不开弹窗,结束复位', async () => {
    let resolve!: (v: { statement: string; matched_rows: number }) => void
    cellUpdateMocks.CHPreviewCellUpdate.mockImplementation(
      () => new Promise<{ statement: string; matched_rows: number }>((res) => { resolve = res }),
    )
    const cu = useCHCellUpdate()

    const p = cu.request(makeTarget())
    expect(cu.previewing.value).toBe(true)
    expect(cu.confirmOpen.value).toBe(false)

    resolve({ statement: 'ALTER ...', matched_rows: 3 })
    await p
    expect(cu.previewing.value).toBe(false)
    expect(cu.matchedRows.value).toBe(3)
    expect(cu.confirmOpen.value).toBe(true)
  })

  it('失败:error 写入错误信息,不开弹窗、不填充语句', async () => {
    const cu = useCHCellUpdate()
    cellUpdateMocks.CHPreviewCellUpdate.mockRejectedValue(new Error('连接不可用'))

    await cu.request(makeTarget())

    expect(cu.error.value).toBe('连接不可用')
    expect(cu.confirmOpen.value).toBe(false)
    expect(cu.statement.value).toBe('')
    expect(cu.matchedRows.value).toBe(0)
    expect(cu.previewing.value).toBe(false)
  })

  it('失败:非 Error 抛出值转为字符串', async () => {
    const cu = useCHCellUpdate()
    cellUpdateMocks.CHPreviewCellUpdate.mockRejectedValue('boom')

    await cu.request(makeTarget())

    expect(cu.error.value).toBe('boom')
  })

  it('失败后不残留待执行目标:confirm 不调用后端', async () => {
    const cu = useCHCellUpdate()
    cellUpdateMocks.CHPreviewCellUpdate.mockRejectedValue(new Error('预览失败'))

    await cu.request(makeTarget())
    await cu.confirm()

    expect(cellUpdateMocks.CHUpdateCell).not.toHaveBeenCalled()
  })
})

describe('confirm(执行)', () => {
  it('成功:把同一 target 发给执行并关闭弹窗', async () => {
    const cu = useCHCellUpdate()
    const t = makeTarget()
    await cu.request(t)
    cellUpdateMocks.CHUpdateCell.mockClear()

    await cu.confirm()

    expect(cellUpdateMocks.CHUpdateCell).toHaveBeenCalledTimes(1)
    expect(cellUpdateMocks.CHUpdateCell).toHaveBeenCalledWith(t)
    expect(cu.confirmOpen.value).toBe(false)
    expect(cu.executing.value).toBe(false)
    expect(cu.error.value).toBeNull()
  })

  it('执行进行中 executing=true,结束复位', async () => {
    const cu = useCHCellUpdate()
    await cu.request(makeTarget())
    let resolve!: () => void
    cellUpdateMocks.CHUpdateCell.mockImplementation(() => new Promise<void>((res) => { resolve = res }))

    const p = cu.confirm()
    expect(cu.executing.value).toBe(true)

    resolve()
    await p
    expect(cu.executing.value).toBe(false)
    expect(cu.confirmOpen.value).toBe(false)
  })

  it('失败:error 写入错误信息且弹窗保持打开', async () => {
    const cu = useCHCellUpdate()
    await cu.request(makeTarget())
    cellUpdateMocks.CHUpdateCell.mockRejectedValue(new Error('更新被拒绝'))

    await cu.confirm()

    expect(cu.error.value).toBe('更新被拒绝')
    expect(cu.confirmOpen.value).toBe(true)
    expect(cu.executing.value).toBe(false)
  })

  it('未先 request:不调用后端并给出错误', async () => {
    const cu = useCHCellUpdate()

    await cu.confirm()

    expect(cellUpdateMocks.CHUpdateCell).not.toHaveBeenCalled()
    expect(cu.error.value).toBeTruthy()
    expect(cu.confirmOpen.value).toBe(false)
  })
})

describe('cancel', () => {
  it('关闭弹窗并清空语句/匹配行数/错误', async () => {
    const cu = useCHCellUpdate()
    await cu.request(makeTarget())

    cu.cancel()

    expect(cu.confirmOpen.value).toBe(false)
    expect(cu.statement.value).toBe('')
    expect(cu.matchedRows.value).toBe(0)
    expect(cu.error.value).toBeNull()
    // 取消后残留目标被清掉,confirm 不会执行任何更新
    await cu.confirm()
    expect(cellUpdateMocks.CHUpdateCell).not.toHaveBeenCalled()
  })

  it('空闲状态 cancel 无副作用', () => {
    const cu = useCHCellUpdate()

    cu.cancel()

    expect(cu.confirmOpen.value).toBe(false)
    expect(cu.error.value).toBeNull()
    expect(cellUpdateMocks.CHPreviewCellUpdate).not.toHaveBeenCalled()
  })
})

describe('多实例', () => {
  it('状态按实例独立', async () => {
    const a = useCHCellUpdate()
    const b = useCHCellUpdate()

    await a.request(makeTarget())

    expect(a.confirmOpen.value).toBe(true)
    expect(b.confirmOpen.value).toBe(false)
    expect(b.statement.value).toBe('')
    b.error.value = '仅本实例可见'
    expect(a.error.value).toBeNull()
  })
})
