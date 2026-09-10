import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import * as App from '../../../wailsjs/go/backend/App'
import { setApi, type Api } from '@/api/client'
import { useQueryFiles, type QueryFileInfo } from '@/composables/queryFiles'
import QueryFilesPanel, { type SqlConsoleApi } from './QueryFilesPanel.vue'

// vi.mock 会被提升到文件顶部,因此 mocks 必须用 vi.hoisted 创建,
// 否则工厂执行时 appMocks 尚未初始化(TDZ)。mock wailsjs 四方法来驱动
// composable 的共享 files,而不是 mock composable 本体。
const appMocks = vi.hoisted(() => ({
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...appMocks }
})
const app = App as unknown as typeof appMocks

// 后端返回即新→旧,这里按同样顺序构造样例。
const file = (name: string, connectionId = 'conn-1'): QueryFileInfo => ({
  name,
  connection_id: connectionId,
  size_bytes: 10,
  mod_time_ms: 1_700_000_000_000,
})

function fakeConsoleApi(currentFile: string | null = null): SqlConsoleApi {
  return {
    requestSave: vi.fn(),
    requestSaveAs: vi.fn(),
    loadQueryFile: vi.fn(),
    askRemoveCurrentFile: vi.fn(),
    currentFile: vi.fn(() => currentFile),
  }
}

function mountPanel(consoleApi: SqlConsoleApi | null = null): VueWrapper {
  return mount(QueryFilesPanel, { props: { consoleApi } })
}

// 注入含两个连接的 fake API,供条目解析「类型 · 名称」归属。
function useFakeConnections(): void {
  setApi({
    listConnections: vi.fn(async () => [
      { id: 'conn-1', name: '生产集群', type: 'kafka', config: {}, created_at: 0 },
      { id: 'conn-2', name: '日志库', type: 'clickhouse', config: {}, created_at: 0 },
    ]),
  } as unknown as Api)
}

describe('QueryFilesPanel', () => {
  beforeEach(async () => {
    setActivePinia(createPinia())
    // files 是 composable 模块级共享状态,先用空列表刷新清场,
    // 再清调用记录并恢复默认空列表,避免用例间串扰。
    appMocks.ListQueryFiles.mockReset()
    appMocks.ListQueryFiles.mockResolvedValue([])
    await useQueryFiles({ connectionId: () => '' }).refreshFiles()
    vi.clearAllMocks()
    appMocks.ListQueryFiles.mockResolvedValue([])
  })

  it('按新→旧渲染全部查询文件,条目显示数据源类型与名称归属', async () => {
    useFakeConnections()
    appMocks.ListQueryFiles.mockResolvedValue([
      file('newest.sql'),
      file('middle.sql', 'conn-2'),
      file('older.sql'),
    ])
    const wrapper = mountPanel()
    await flushPromises()

    const items = wrapper.findAll('[data-test^="files-item-"]')
    expect(items).toHaveLength(3)
    expect(items.map((i) => i.text())).toEqual([
      'newest.sqlKafka · 生产集群',
      'middle.sqlClickHouse · 日志库',
      'older.sqlKafka · 生产集群',
    ])
    // 归属行单独断言(data-test 前缀用 files-meta-,避免与条目选择器互相匹配)。
    const metas = wrapper.findAll('[data-test^="files-meta-"]')
    expect(metas.map((m) => m.text())).toEqual(['Kafka · 生产集群', 'ClickHouse · 日志库', 'Kafka · 生产集群'])
    expect(items[0].attributes('title')).toBe('Kafka · 生产集群')
    expect(wrapper.find('[data-test="files-empty"]').exists()).toBe(false)
  })

  it('连接已删除或文件未关联连接时,归属行显示兜底文案', async () => {
    useFakeConnections()
    appMocks.ListQueryFiles.mockResolvedValue([file('gone.sql', 'conn-gone'), file('loose.sql', '')])
    const wrapper = mountPanel()
    await flushPromises()

    const metas = wrapper.findAll('[data-test^="files-meta-"]')
    expect(metas.map((m) => m.text())).toEqual(['未知连接', '未关联连接'])
  })

  it('列表为空时显示「暂无查询文件」', async () => {
    const wrapper = mountPanel()
    await flushPromises()

    const empty = wrapper.find('[data-test="files-empty"]')
    expect(empty.exists()).toBe(true)
    expect(empty.text()).toBe('暂无查询文件')
  })

  it('拉取列表失败时展示 fileError', async () => {
    appMocks.ListQueryFiles.mockRejectedValue(new Error('读取目录失败'))
    const wrapper = mountPanel()
    await flushPromises()

    const err = wrapper.find('[data-test="files-error"]')
    expect(err.exists()).toBe(true)
    expect(err.text()).toContain('读取目录失败')
  })

  it('无激活控制台时三个按钮禁用,点击条目仍上报 open 事件(由 Layout 决定自动开台)', async () => {
    appMocks.ListQueryFiles.mockResolvedValue([file('a.sql')])
    const wrapper = mountPanel(null)
    await flushPromises()

    expect(wrapper.find('[data-test="files-save"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="files-save-as"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="files-file-delete"]').attributes('disabled')).toBeDefined()

    await wrapper.find('[data-test="files-item-0"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['a.sql', 'conn-1']])
  })

  it('有激活控制台时点击条目上报 open 事件并携带文件归属连接,当前文件条目高亮', async () => {
    appMocks.ListQueryFiles.mockResolvedValue([file('a.sql'), file('b.sql', 'conn-2')])
    const consoleApi = fakeConsoleApi('a.sql')
    const wrapper = mountPanel(consoleApi)
    await flushPromises()

    await wrapper.find('[data-test="files-item-0"]').trigger('click')
    expect(wrapper.emitted('open')).toEqual([['a.sql', 'conn-1']])
    expect(wrapper.find('[data-test="files-item-0"]').classes()).toContain('active')
    expect(wrapper.find('[data-test="files-item-1"]').classes()).not.toContain('active')
  })

  it('保存 / 另存为 / 删除直接转发给激活控制台,面板自身不弹窗', async () => {
    const consoleApi = fakeConsoleApi(null)
    const wrapper = mountPanel(consoleApi)
    await flushPromises()

    await wrapper.find('[data-test="files-save"]').trigger('click')
    await wrapper.find('[data-test="files-save-as"]').trigger('click')
    await wrapper.find('[data-test="files-file-delete"]').trigger('click')

    expect(consoleApi.requestSave).toHaveBeenCalledTimes(1)
    expect(consoleApi.requestSaveAs).toHaveBeenCalledTimes(1)
    expect(consoleApi.askRemoveCurrentFile).toHaveBeenCalledTimes(1)
  })

  it('挂载时自动刷新列表,并暴露 refresh() 供展开时调用', async () => {
    const wrapper = mountPanel()
    await flushPromises()
    expect(appMocks.ListQueryFiles).toHaveBeenCalled()

    appMocks.ListQueryFiles.mockClear()
    ;(wrapper.vm as unknown as { refresh(): void }).refresh()
    await flushPromises()
    expect(appMocks.ListQueryFiles).toHaveBeenCalledTimes(1)
  })

  it('refresh() 同时重拉连接列表:面板开着时新建的连接也能正确解析归属', async () => {
    // 挂载时连接列表还没有 TiDB 连接 → 归属显示「未知连接」。
    const wrapper = mountPanel()
    await flushPromises()
    appMocks.ListQueryFiles.mockResolvedValue([file('ti.sql', 'conn-tidb')])
    ;(wrapper.vm as unknown as { refresh(): void }).refresh()
    await flushPromises()
    expect(wrapper.find('[data-test="files-meta-0"]').text()).toBe('未知连接')

    // refresh() 重拉连接列表后,新建的 TiDB 连接被识别。
    setApi({
      listConnections: vi.fn(async () => [
        { id: 'conn-tidb', name: 'TiDB 集群', type: 'tidb', config: {}, created_at: 0 },
      ]),
    } as unknown as Api)
    ;(wrapper.vm as unknown as { refresh(): void }).refresh()
    await flushPromises()
    expect(wrapper.find('[data-test="files-meta-0"]').text()).toBe('TiDB · TiDB 集群')
  })
})
