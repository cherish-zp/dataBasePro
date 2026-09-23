import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as App from '../../wailsjs/go/backend/App'
import { useToastStore } from '@/store/toast'
import { QUERY_DIR_KEY } from '@/utils/queryDir'
import { useQueryFiles, type QueryFilesOptions } from './queryFiles'

// vi.mock 会被提升到文件顶部,因此 mocks 必须用 vi.hoisted 创建,
// 否则工厂执行时 queryFileMocks 尚未初始化(TDZ)。
// vi.mock 按解析后的绝对路径匹配,相对路径拼写无需与导入方一致。
const queryFileMocks = vi.hoisted(() => ({
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../wailsjs/go/backend/App')>(
    '../../wailsjs/go/backend/App',
  )
  return { ...actual, ...queryFileMocks }
})
const queryFileApp = App as unknown as typeof queryFileMocks

// 每个用例固定查询文件目录,避免依赖 localStorage 残留值。
const DIR = '/tmp/query-files-spec'

function fileInfo(name: string, connectionId = 'conn-1') {
  return { name, connection_id: connectionId, size_bytes: 10, mod_time_ms: 1_700_000_000_000 }
}

function setup(overrides: Partial<QueryFilesOptions> = {}) {
  const opts = {
    connectionId: vi.fn(() => 'conn-1'),
    getContent: vi.fn(() => 'select 1'),
    setContent: vi.fn(),
    ...overrides,
  }
  return { opts, qf: useQueryFiles(opts) }
}

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  localStorage.setItem(QUERY_DIR_KEY, DIR)
  queryFileApp.ListQueryFiles.mockReset()
  queryFileApp.ReadQueryFile.mockReset()
  queryFileApp.WriteQueryFile.mockReset()
  queryFileApp.DeleteQueryFile.mockReset()
  queryFileApp.ListQueryFiles.mockResolvedValue([])
  queryFileApp.ReadQueryFile.mockResolvedValue({ content: '', connection_id: '' })
  queryFileApp.WriteQueryFile.mockResolvedValue(undefined)
  queryFileApp.DeleteQueryFile.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('refreshFiles', () => {
  it('成功:按当前查询目录拉取列表并写入 files', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql'), fileInfo('b.sql', 'conn-2')])

    await qf.refreshFiles()

    expect(queryFileApp.ListQueryFiles).toHaveBeenCalledWith({ dir: DIR })
    expect(qf.files.value.map((f) => f.name)).toEqual(['a.sql', 'b.sql'])
    expect(qf.fileError.value).toBeNull()
  })

  it('失败:错误信息写入 fileError', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockRejectedValue(new Error('读取目录失败'))

    await qf.refreshFiles()

    expect(qf.fileError.value).toBe('读取目录失败')
  })

  it('失败:非 Error 抛出值转为字符串', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockRejectedValue('boom')

    await qf.refreshFiles()

    expect(qf.fileError.value).toBe('boom')
  })
})

describe('loadQueryFile', () => {
  it('回填编辑器内容并记录当前文件(名称规范化含 .sql)', async () => {
    const { opts, qf } = setup()
    queryFileApp.ReadQueryFile.mockResolvedValue({ content: 'select 2', connection_id: 'conn-9' })

    await qf.loadQueryFile('a')

    expect(queryFileApp.ReadQueryFile).toHaveBeenCalledWith({ dir: DIR, name: 'a.sql' })
    expect(opts.setContent).toHaveBeenCalledWith('select 2')
    expect(qf.currentFile.value).toBe('a.sql')
    expect(qf.fileError.value).toBeNull()
  })

  it('失败:写入 fileError 且不回填内容', async () => {
    const { opts, qf } = setup()
    queryFileApp.ReadQueryFile.mockRejectedValue(new Error('文件不存在'))

    await qf.loadQueryFile('missing.sql')

    expect(qf.fileError.value).toBe('文件不存在')
    expect(opts.setContent).not.toHaveBeenCalled()
    expect(qf.currentFile.value).toBeNull()
  })
})

describe('saveToFile', () => {
  it('写入 payload(目录/名称补 .sql/内容/连接ID)并刷新列表、弹出 toast', async () => {
    const { qf } = setup()
    const toast = useToastStore()
    const showSpy = vi.spyOn(toast, 'show')
    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql')])

    await qf.saveToFile('a')

    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith({
      dir: DIR,
      name: 'a.sql',
      content: 'select 1',
      connection_id: 'conn-1',
    })
    expect(qf.currentFile.value).toBe('a.sql')
    expect(qf.fileError.value).toBeNull()
    // 保存后刷新了列表(使用刷新后的返回值,而非空列表)
    expect(qf.files.value.map((f) => f.name)).toEqual(['a.sql'])
    expect(showSpy).toHaveBeenCalledWith('已保存到 SQL文件:a.sql')
  })

  it('失败:写入 fileError,不更新当前文件、不弹 toast', async () => {
    const { qf } = setup()
    const toast = useToastStore()
    const showSpy = vi.spyOn(toast, 'show')
    queryFileApp.WriteQueryFile.mockRejectedValue(new Error('磁盘已满'))

    await qf.saveToFile('a.sql')

    expect(qf.fileError.value).toBe('磁盘已满')
    expect(qf.currentFile.value).toBeNull()
    expect(showSpy).not.toHaveBeenCalled()
  })
})

describe('requestSave / requestSaveAs', () => {
  it('已关联文件:直接覆盖保存,不打开名称弹窗', async () => {
    const { qf } = setup()
    await qf.loadQueryFile('a.sql')
    queryFileApp.WriteQueryFile.mockClear()

    qf.requestSave()
    await flushPromises()

    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith({
      dir: DIR,
      name: 'a.sql',
      content: 'select 1',
      connection_id: 'conn-1',
    })
    expect(qf.nameDialog.open.value).toBe(false)
  })

  it('未关联文件:打开名称弹窗,mode 为 save', () => {
    const { qf } = setup()

    qf.requestSave()

    expect(qf.nameDialog.open.value).toBe(true)
    expect(qf.nameDialog.mode.value).toBe('save')
  })

  it('requestSaveAs:即使已关联文件也强制打开名称弹窗,mode 为 save-as', async () => {
    const { qf } = setup()
    await qf.loadQueryFile('a.sql')

    qf.requestSaveAs()

    expect(qf.nameDialog.open.value).toBe(true)
    expect(qf.nameDialog.mode.value).toBe('save-as')
  })

  it('nameDialog.cancel 关闭弹窗', () => {
    const { qf } = setup()

    qf.requestSave()
    qf.nameDialog.cancel()

    expect(qf.nameDialog.open.value).toBe(false)
  })
})

describe('confirmName', () => {
  it('目标名已存在且非当前文件:关闭名称弹窗并打开覆盖确认,不立即写入', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql')])
    await qf.refreshFiles()

    qf.confirmName('a')

    expect(qf.nameDialog.open.value).toBe(false)
    expect(qf.overwriteConfirm.open.value).toBe(true)
    expect(qf.overwriteConfirm.target.value).toBe('a.sql')
    expect(queryFileApp.WriteQueryFile).not.toHaveBeenCalled()
  })

  it('覆盖确认 confirm:保存目标文件并关闭确认', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql')])
    await qf.refreshFiles()
    qf.confirmName('a')

    qf.overwriteConfirm.confirm()
    await flushPromises()

    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith({
      dir: DIR,
      name: 'a.sql',
      content: 'select 1',
      connection_id: 'conn-1',
    })
    expect(qf.overwriteConfirm.open.value).toBe(false)
    expect(qf.currentFile.value).toBe('a.sql')
  })

  it('同名即当前文件:直接覆盖保存,不弹覆盖确认', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql')])
    await qf.refreshFiles()
    await qf.loadQueryFile('a.sql')

    qf.confirmName('a.sql')
    await flushPromises()

    expect(qf.overwriteConfirm.open.value).toBe(false)
    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'a.sql' }),
    )
    expect(qf.currentFile.value).toBe('a.sql')
  })

  it('新名称:直接保存,名称自动补 .sql', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockResolvedValue([])
    await qf.refreshFiles()

    qf.confirmName('new-file')
    await flushPromises()

    expect(qf.overwriteConfirm.open.value).toBe(false)
    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'new-file.sql' }),
    )
  })

  it('overwriteConfirm.cancel 关闭覆盖确认', async () => {
    const { qf } = setup()
    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql')])
    await qf.refreshFiles()
    qf.confirmName('a')

    qf.overwriteConfirm.cancel()

    expect(qf.overwriteConfirm.open.value).toBe(false)
    expect(queryFileApp.WriteQueryFile).not.toHaveBeenCalled()
  })
})

describe('askRemoveCurrentFile / removeCurrentFile', () => {
  it('askRemoveCurrentFile:未关联不开弹窗;关联后开弹窗且 message 含文件名', async () => {
    const { qf } = setup()

    qf.askRemoveCurrentFile()
    expect(qf.deleteConfirm.open.value).toBe(false)

    await qf.loadQueryFile('a.sql')
    qf.askRemoveCurrentFile()

    expect(qf.deleteConfirm.open.value).toBe(true)
    expect(qf.deleteConfirm.message.value).toContain('a.sql')
  })

  it('confirm:删除文件 → 清空当前文件与编辑器 → 刷新列表 → 关闭确认', async () => {
    const { opts, qf } = setup()
    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql')])
    await qf.refreshFiles()
    await qf.loadQueryFile('a.sql')
    queryFileApp.ListQueryFiles.mockClear()
    queryFileApp.ListQueryFiles.mockResolvedValue([])

    qf.deleteConfirm.confirm()
    await flushPromises()

    expect(queryFileApp.DeleteQueryFile).toHaveBeenCalledWith({ dir: DIR, name: 'a.sql' })
    expect(qf.currentFile.value).toBeNull()
    expect(opts.setContent).toHaveBeenLastCalledWith('')
    expect(queryFileApp.ListQueryFiles).toHaveBeenCalledTimes(1)
    expect(qf.deleteConfirm.open.value).toBe(false)
    expect(qf.fileError.value).toBeNull()
  })

  it('删除失败:写入 fileError,当前文件保留', async () => {
    const { qf } = setup()
    await qf.loadQueryFile('a.sql')
    queryFileApp.DeleteQueryFile.mockRejectedValue(new Error('删除失败'))

    await qf.removeCurrentFile()

    expect(qf.fileError.value).toBe('删除失败')
    expect(qf.currentFile.value).toBe('a.sql')
  })

  it('currentFile 为空时 removeCurrentFile 不调用后端', async () => {
    const { qf } = setup()

    await qf.removeCurrentFile()

    expect(queryFileApp.DeleteQueryFile).not.toHaveBeenCalled()
  })

  it('deleteConfirm.cancel 关闭删除确认', async () => {
    const { qf } = setup()
    await qf.loadQueryFile('a.sql')
    qf.askRemoveCurrentFile()

    qf.deleteConfirm.cancel()

    expect(qf.deleteConfirm.open.value).toBe(false)
    expect(queryFileApp.DeleteQueryFile).not.toHaveBeenCalled()
  })
})

describe('database 透传(保存/载入)', () => {
  it('提供 getDatabase:saveToFile payload 携带 database(写入文件头)', async () => {
    const { qf } = setup({ getDatabase: vi.fn(() => 'shop') })

    await qf.saveToFile('a')

    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith({
      dir: DIR,
      name: 'a.sql',
      content: 'select 1',
      connection_id: 'conn-1',
      database: 'shop',
    })
  })

  it('未提供 getDatabase:payload 不含 database 字段(CH/Kafka 消费者零影响)', async () => {
    const { qf } = setup()

    await qf.saveToFile('a')

    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith({
      dir: DIR,
      name: 'a.sql',
      content: 'select 1',
      connection_id: 'conn-1',
    })
    const payload = queryFileApp.WriteQueryFile.mock.calls[0][0] as Record<string, unknown>
    expect('database' in payload).toBe(false)
  })

  it('载入文件:setDatabase 回调文件头里的库,且在 setContent 之后', async () => {
    const setDatabase = vi.fn()
    const { opts, qf } = setup({ setDatabase })
    queryFileApp.ReadQueryFile.mockResolvedValue({
      content: 'select 2',
      connection_id: 'conn-9',
      database: 'orders',
    })

    await qf.loadQueryFile('a')

    expect(setDatabase).toHaveBeenCalledWith('orders')
    expect(setDatabase.mock.invocationCallOrder[0]).toBeGreaterThan(
      (opts.setContent as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0],
    )
  })

  it('旧后端响应缺 database 字段:setDatabase 回调空串(向后兼容)', async () => {
    const setDatabase = vi.fn()
    const { qf } = setup({ setDatabase })
    queryFileApp.ReadQueryFile.mockResolvedValue({ content: 'x', connection_id: 'conn-1' })

    await qf.loadQueryFile('a')

    expect(setDatabase).toHaveBeenCalledWith('')
  })

  it('载入失败:不回调 setDatabase', async () => {
    const setDatabase = vi.fn()
    const { qf } = setup({ setDatabase })
    queryFileApp.ReadQueryFile.mockRejectedValue(new Error('文件不存在'))

    await qf.loadQueryFile('a')

    expect(setDatabase).not.toHaveBeenCalled()
  })
})

describe('多实例共享', () => {
  it('两个消费者共享同一 files 列表,实例状态彼此独立', async () => {
    const a = useQueryFiles({
      connectionId: () => 'conn-1',
      getContent: () => '',
      setContent: vi.fn(),
    })
    const b = useQueryFiles({
      connectionId: () => 'conn-2',
      getContent: () => '',
      setContent: vi.fn(),
    })

    queryFileApp.ListQueryFiles.mockResolvedValue([fileInfo('a.sql', 'conn-1')])
    await a.refreshFiles()

    // 同一 ref:引用相等且内容一致
    expect(b.files).toBe(a.files)
    expect(b.files.value.map((f) => f.name)).toEqual(['a.sql'])

    // currentFile / fileError 每实例独立
    await a.loadQueryFile('a.sql')
    expect(a.currentFile.value).toBe('a.sql')
    expect(b.currentFile.value).toBeNull()
    b.fileError.value = '仅本实例可见'
    expect(a.fileError.value).toBeNull()
  })
})

describe('schema 支持', () => {
  it('保存时把 getSchema 的返回写入 payload 的 schema 字段', async () => {
    const { opts, qf } = setup({
      getDatabase: vi.fn(() => 'shop'),
      getSchema: vi.fn(() => 'public'),
    })
    await qf.saveToFile('pg-query')
    expect(queryFileApp.WriteQueryFile).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'pg-query.sql', connection_id: 'conn-1', database: 'shop', schema: 'public' }),
    )
    expect(opts.getSchema).toHaveBeenCalled()
  })

  it('未提供 getSchema 时 payload 不带 schema 字段', async () => {
    const { qf } = setup({ getDatabase: vi.fn(() => 'shop') })
    await qf.saveToFile('no-schema')
    const payload = queryFileApp.WriteQueryFile.mock.calls[0][0] as Record<string, unknown>
    expect('schema' in payload).toBe(false)
  })

  it('载入文件时把文件头记录的 schema 回传给 setSchema', async () => {
    queryFileApp.ReadQueryFile.mockResolvedValue({ content: 'select 1', connection_id: 'conn-1', database: 'shop', schema: 'app' })
    const setSchema = vi.fn()
    const { qf } = setup({ setDatabase: vi.fn(), setSchema })
    await qf.loadQueryFile('pg.sql')
    expect(setSchema).toHaveBeenCalledWith('app')
    expect(qf.currentFile.value).toBe('pg.sql')
  })

  it('文件头缺省 schema 时 setSchema 收到空串', async () => {
    queryFileApp.ReadQueryFile.mockResolvedValue({ content: 'select 1', connection_id: 'conn-1', database: 'shop' })
    const setSchema = vi.fn()
    const { qf } = setup({ setDatabase: vi.fn(), setSchema })
    await qf.loadQueryFile('old.sql')
    expect(setSchema).toHaveBeenCalledWith('')
  })
})
