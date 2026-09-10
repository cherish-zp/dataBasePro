import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type DOMWrapper, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { CHPageRowsResult } from '@/api/types'
import CHTableBrowser from './CHTableBrowser.vue'

// 单元格编辑经真实 useCHCellUpdate composable 直连 wailsjs 绑定,因此测试
// 只在 wailsjs 模块层 mock(vi.mock 提升到文件顶部,fn 须用 vi.hoisted
// 创建避免 TDZ);composable 本身不 mock,按契约走真实实现。
const wailsMocks = vi.hoisted(() => ({
  // 预览:返回将执行的 ALTER 语句全文与匹配行数(契约形状)。
  CHPreviewCellUpdate: vi.fn(),
  // 执行:按已预览的 target 执行 UPDATE。
  CHUpdateCell: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...wailsMocks }
})

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as never),
    listTopics: vi.fn(async () => []),
    describeTopic: vi.fn(async () => ({ name: "", partitions: [], configs: [] })),
    describeCluster: vi.fn(async () => ({ cluster_id: "", controller_id: -1, kafka_version: "", brokers: [], under_replicated_partitions: 0 })),
    alterTopicConfig: vi.fn(async () => {}),
    alterTopicPartitions: vi.fn(async () => {}),
    getTopicMessageCounts: vi.fn(async () => ({})),
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    previewResetOffset: vi.fn(async () => ({})),
    listAudit: vi.fn(async () => []),
    checkUpdate: vi.fn(async () => ({ has_update: false, latest_version: 'v1.0.0' })),
    downloadUpdate: vi.fn(async () => {}),
    applyUpdate: vi.fn(async () => {}),
    updateProgress: vi.fn(async () => ({ phase: 'idle' as const, percent: 0 })),
    openURL: vi.fn(async () => {}),
    listSavedQueries: vi.fn(async () => []),
    saveSavedQuery: vi.fn(async (q: never) => ({}) as never),
    updateSavedQuery: vi.fn(async () => ({}) as never),
    deleteSavedQuery: vi.fn(async () => {}),
    testCHConnection: vi.fn(async () => {}),
    listCHDatabases: vi.fn(async () => []),
    listCHTables: vi.fn(async () => []),
    chPageRows: vi.fn(async () => ({ columns: [], rows: [], engine: '', total_rows: 0 })),
    chTruncateTable: vi.fn(async () => {}),
    chExecute: vi.fn(async () => []),
    listDrivers: vi.fn(async () => []),
    testRedisConnection: vi.fn(async () => {}),
    listRedisDBs: vi.fn(async () => []),
    redisScan: vi.fn(async () => ({ cursor: 0, keys: [] })),
    redisGetKey: vi.fn(async () => ({ key: '', type: 'string', ttl_seconds: -1 })),
    redisRenameKey: vi.fn(async () => {}),
    redisDeleteKeys: vi.fn(async () => 0),
    redisSetTTL: vi.fn(async () => {}),
    redisSetString: vi.fn(async () => {}),
    redisFlushDB: vi.fn(async () => {}),
    redisFlushAll: vi.fn(async () => {}),
    redisServerInfo: vi.fn(async () => ({ mode: 'standalone' as const, used_memory_human: '', connected_clients: 0, total_keys: 0 })),
    redisHashSetField: vi.fn(async () => {}),
    redisHashDeleteField: vi.fn(async () => {}),
    redisListSetIndex: vi.fn(async () => {}),
    redisListPush: vi.fn(async () => {}),
    redisListDeleteIndex: vi.fn(async () => {}),
    redisSetAdd: vi.fn(async () => {}),
    redisSetRemove: vi.fn(async () => {}),
    redisZSetAdd: vi.fn(async () => {}),
    redisZSetRemove: vi.fn(async () => {}),
    saveTextFile: vi.fn(async () => ''),
    updateConnection: vi.fn(async () => ({}) as never),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

const page = (over: Partial<CHPageRowsResult> = {}): CHPageRowsResult => ({
  columns: [
    { name: 'id', type: 'UInt32', comment: '主键 ID' },
    { name: 'name', type: 'String' },
  ],
  rows: [
    ['1', 'alice'],
    [null, 'bob'],
  ],
  engine: 'MergeTree',
  total_rows: 4096,
  ...over,
})

// 200 行:下一页按钮只在整页数据时可点。
const fullPage = (over: Partial<CHPageRowsResult> = {}): CHPageRowsResult => ({
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
    expect(wrapper.findAll('[data-test="ch-col"]')).toHaveLength(n)
  })
}

// raw 构造后端可能给出的异常 wire 形状(绕过编译期类型,模拟真实传输)。
function raw(over: Record<string, unknown> = {}): CHPageRowsResult {
  return {
    columns: [
      { name: 'id', type: 'UInt64', comment: '' },
      { name: 'name', type: 'String', comment: '' },
    ],
    rows: [],
    engine: 'MergeTree',
    total_rows: 0,
    ...over,
  } as unknown as CHPageRowsResult
}

describe('CHTableBrowser', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
    document.body.innerHTML = ''
    wailsMocks.CHPreviewCellUpdate.mockReset()
    wailsMocks.CHUpdateCell.mockReset()
  })

  it('fetches the first page and renders columns, rows, NULL cells and the summary', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
    // 旧「在 SQL 控制台打开」入口已删除:与顶栏新建查询完全重复。
    expect(wrapper.find('[data-test="btn-ch-open-sql"]').exists()).toBe(false)
    expect(api.chPageRows).toHaveBeenCalledWith({
      connection_id: 'ch1',
      database: 'logs',
      table: 'events',
      asc: true,
      limit: 200,
      offset: 0,
    })
    const cols = wrapper.findAll('[data-test="ch-col"]')
    expect(cols.map((c) => c.find('[data-test="ch-col-name"]').text())).toEqual(['id', 'name'])
    expect(cols.map((c) => c.find('[data-test="ch-col-type"]').text())).toEqual(['UInt32', 'String'])
    // 列头 title 悬停显示「类型 + 描述」(comment 非空时拼入)。
    expect(cols[0].attributes('title')).toContain('UInt32')
    expect(cols[0].attributes('title')).toContain('主键 ID')
    expect(cols[1].attributes('title')).not.toContain('undefined')
    // 有数据时渲染网格而非字段结构面板。
    expect(wrapper.find('[data-test="ch-fields-panel"]').exists()).toBe(false)
    const rows = wrapper.findAll('[data-test="ch-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].findAll('[data-test="ch-cell"]').map((c) => c.text())).toEqual(['1', 'alice'])
    const nullCell = rows[1].findAll('[data-test="ch-cell"]')[0]
    expect(nullCell.text()).toBe('NULL')
    expect(nullCell.classes()).toContain('cell-null')
    // 摘要条:表名、引擎、近似行数(千分位,行数不是字节数)。
    const summary = wrapper.find('[data-test="ch-summary"]')
    expect(summary.text()).toContain('events')
    expect(summary.text()).toContain('MergeTree')
    expect(wrapper.find('[data-test="ch-summary-rows"]').text()).toContain('4,096')
  })

  it('re-requests sorted when a column header is clicked and flips direction on the second click', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
    await wrapper.findAll('[data-test="ch-col"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: true, offset: 0 }))
    })
    await wrapper.findAll('[data-test="ch-col"]')[0].trigger('click')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'id', asc: false }))
    })
  })

  it('advances the offset by 200 per page through the pager', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(fullPage())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    // 首页数据就绪前下一页禁用,等 200 行渲染完再翻页。
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="ch-row"]')).toHaveLength(200)
    })
    // 首页时上一页禁用。
    expect((wrapper.find('[data-test="btn-ch-prev"]').element as HTMLButtonElement).disabled).toBe(true)
    await wrapper.find('[data-test="btn-ch-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
    expect(wrapper.find('[data-test="ch-page-label"]').text()).toContain('2')
    await wrapper.find('[data-test="btn-ch-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 400 }))
    })
    await wrapper.find('[data-test="btn-ch-prev"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
  })

  it('truncates a Distributed table through the confirm dialog with the ON CLUSTER notice and re-requests', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ engine: 'Distributed' }))
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-ch-truncate"]').trigger('click')
    expect(confirmDialog()).not.toBeNull()
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('events')
    expect(msg).toContain('Distributed')
    expect(msg).toContain('ON CLUSTER')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(api.chTruncateTable).toHaveBeenCalledWith({
        connection_id: 'ch1',
        database: 'logs',
        table: 'events',
        on_cluster: true,
      })
    })
    // 清空成功后重请求当前页。
    await vi.waitFor(() => {
      expect((api.chPageRows as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2)
    })
  })

  it('truncates a local MergeTree table without the ON CLUSTER notice', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
    await wrapper.find('[data-test="btn-ch-truncate"]').trigger('click')
    const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
    expect(msg).toContain('events')
    expect(msg).toContain('MergeTree')
    expect(msg).not.toContain('ON CLUSTER')
    clickConfirmDialog('confirm-dialog-ok')
    await vi.waitFor(() => {
      expect(api.chTruncateTable).toHaveBeenCalledWith({
        connection_id: 'ch1',
        database: 'logs',
        table: 'events',
        on_cluster: undefined,
      })
    })
    expect(api.chTruncateTable).not.toHaveBeenCalledWith(expect.objectContaining({ on_cluster: true }))
  })

  it('re-requests with the entered WHERE filter and resets the offset', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(fullPage())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="ch-row"]')).toHaveLength(200)
    })
    await wrapper.find('[data-test="btn-ch-next"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 200 }))
    })
    await wrapper.find('[data-test="ch-where"]').setValue('col > 1')
    await wrapper.find('[data-test="ch-where"]').trigger('keydown.enter')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ where: 'col > 1', offset: 0 }))
    })
  })

  it('renders a field structure panel instead of the empty grid when the table has no rows', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue({
      columns: [
        { name: 'id', type: 'UInt64', comment: '主键' },
        { name: 'name', type: 'String' },
      ],
      rows: [],
      engine: 'MergeTree',
      total_rows: 0,
    })
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'r1', database: 'logs', table: 'events' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-fields-panel"]').exists()).toBe(true)
    })
    // 空网格不再渲染。
    expect(wrapper.find('[data-test="ch-grid"]').exists()).toBe(false)
    // 面板标题带字段总数。
    expect(wrapper.find('[data-test="ch-fields-panel"]').text()).toContain('表结构(共 2 字段)')
    const fieldRows = wrapper.findAll('[data-test="ch-field-row"]')
    expect(fieldRows).toHaveLength(2)
    expect(fieldRows[0].find('[data-test="ch-field-name"]').text()).toBe('id')
    expect(fieldRows[0].find('[data-test="ch-field-type"]').text()).toBe('UInt64')
    // 描述仅在 comment 非空时渲染。
    expect(fieldRows[0].find('[data-test="ch-field-comment"]').text()).toBe('主键')
    expect(fieldRows[1].find('[data-test="ch-field-comment"]').exists()).toBe(false)
    // 面板下方保留「该表暂无数据」空态提示。
    expect(wrapper.find('[data-test="ch-grid-empty"]').text()).toContain('该表暂无数据')
  })

  it('keeps the fields panel and root mounted after both concurrent requests settle on an empty table', async () => {
    // 用户真机回归:空表打开 tab 时字段面板闪现后整页白屏。挂载时
    // fetchPage 与 loadTableList 并发,两批响应先后触发二次渲染,任何
    // 一次渲染崩溃都会表现为「闪现后空白」——钉住两次渲染后组件仍完整。
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(raw())
    ;(api.listCHTables as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'events', engine: 'MergeTree', total_rows: 0 },
    ])
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-fields-panel"]').exists()).toBe(true)
    })
    // 并发的表清单请求完成后(第二次渲染),组件根与字段面板仍在。
    await vi.waitFor(() => {
      expect(api.listCHTables).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-table-switcher"]').findAll('option')).toHaveLength(1)
    })
    expect(wrapper.find('[data-test="ch-table-browser"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ch-fields-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ch-summary-rows"]').text()).toContain('0')
  })

  it('renders the empty-table fields panel when the backend sends rows as null', async () => {
    // Go nil 切片在 wire 上是 null(修复前后端约定前):前端不得崩溃,
    // 须兜底为空数组并照常渲染字段结构面板。
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(raw({ rows: null }))
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-fields-panel"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="ch-table-browser"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ch-fields-panel"]').text()).toContain('表结构(共 2 字段)')
  })

  it('falls back total_rows to 0 when it arrives as null, undefined or a numeric string', async () => {
    for (const total_rows of [null, undefined, '4096']) {
      document.body.innerHTML = ''
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockReset().mockResolvedValue(raw({ total_rows }))
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="ch-fields-panel"]').exists()).toBe(true)
      })
      const summary = wrapper.find('[data-test="ch-summary-rows"]').text()
      // null/undefined 兜底为 0;数字字符串归一为数字(千分位渲染)。
      const expected = total_rows === '4096' ? '4,096' : '0'
      expect(summary).toContain(`≈ ${expected} 行`)
      expect(wrapper.find('[data-test="ch-table-browser"]').exists()).toBe(true)
    }
  })

  it('renders without crashing when the backend omits columns', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(raw({ columns: undefined }))
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-grid-empty"]').exists()).toBe(true)
    })
    // columns 兜底为空数组:不渲染字段面板,退化为无表头空态而非白屏。
    expect(wrapper.find('[data-test="ch-fields-panel"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ch-table-browser"]').exists()).toBe(true)
  })

  it('switches tables from the toolbar switcher and re-requests with the new table', async () => {
    ;(api.listCHTables as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'events', engine: 'MergeTree', total_rows: 3 },
      { name: 'orders', engine: 'MergeTree', total_rows: 5 },
    ])
    ;(api.chPageRows as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce({
        columns: [{ name: 'order_no', type: 'String' }],
        rows: [['A1']],
        engine: 'MergeTree',
        total_rows: 2,
      })
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    // 挂载时拉取该库全部表作为切换器选项。
    await vi.waitFor(() => {
      expect(api.listCHTables).toHaveBeenCalledWith({ connection_id: 'ch1', database: 'logs', show_system: false })
    })
    await waitCols(wrapper)
    const switcher = wrapper.find('[data-test="ch-table-switcher"]')
    expect((switcher.element as HTMLSelectElement).value).toBe('events')
    // 切换表后以新表名重拉第一页并刷新网格。
    await switcher.setValue('orders')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ table: 'orders', offset: 0 }))
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-col-name"]').text()).toBe('order_no')
    })
    expect(wrapper.find('[data-test="ch-summary-table"]').text()).toBe('logs.orders')
  })

  it('syncs the switcher and re-requests when the table prop changes externally', async () => {
    ;(api.listCHTables as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'events', engine: 'MergeTree', total_rows: 3 },
      { name: 'orders', engine: 'MergeTree', total_rows: 5 },
    ])
    ;(api.chPageRows as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(page())
      .mockResolvedValueOnce({
        columns: [{ name: 'order_no', type: 'String' }],
        rows: [['A1']],
        engine: 'MergeTree',
        total_rows: 2,
      })
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
    await wrapper.setProps({ table: 'orders' })
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ table: 'orders' }))
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-col-name"]').text()).toBe('order_no')
    })
  })

  it('keeps th as a table-cell (col-head only on the inner div)', async () => {
    // 回归守卫:此前 th 与内层 div 共用 col-head(display:flex),th 脱离
    // 表格单元格布局,WebKit 把整行 th 包进一个匿名单元格——所有字段
    // 名竖排堆叠在一列。th 必须保持 table-cell,弹性布局只在内层 div。
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
    const th = wrapper.find('[data-test="ch-col"]')
    expect(th.exists()).toBe(true)
    expect(th.classes()).not.toContain('col-head')
    expect(th.find('.col-head').exists()).toBe(true)
  })

  it('renders the column comment as a third header line only when non-empty', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
    const cols = wrapper.findAll('[data-test="ch-col"]')
    // 有 comment 的列:第三行渲染灰色描述。
    expect(cols[0].find('[data-test="ch-col-comment"]').text()).toBe('主键 ID')
    // 无 comment 的列不渲染描述行(不出现空节点或 undefined)。
    expect(cols[1].find('[data-test="ch-col-comment"]').exists()).toBe(false)
    // 描述行不破坏点击排序(事件仍落在列头上)。
    await cols[1].trigger('click')
    await vi.waitFor(() => {
      expect(api.chPageRows).toHaveBeenLastCalledWith(expect.objectContaining({ order_by: 'name', asc: true }))
    })
  })

  it('keeps column headers horizontal via natural table width (squeeze guard)', () => {
    // jsdom 无法测真实布局,用样式契约锁住:列数多时表格按内容自然宽度
    // 横向滚动,而不是把每个列头压成竖排文字(用户真机翻车现场)。
    const fileSrc = readFileSync(join(process.cwd(), 'src/components/kafka/CHTableBrowser.vue'), 'utf8')
    const tableBlock = fileSrc.match(/\.table \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(tableBlock).toContain('width: max-content')
    expect(tableBlock).toContain('min-width: 100%')
    const headBlock = fileSrc.match(/\.col-head \{[\s\S]*?\n\}/)?.[0] ?? ''
    expect(headBlock).toContain('white-space: nowrap')
  })

  describe('单元格编辑', () => {
    // 第 r 行第 c 列单元格(data-test="ch-cell")。
    function cellAt(wrapper: VueWrapper, row: number, col: number): DOMWrapper<Element> {
      return wrapper.findAll('[data-test="ch-row"]')[row].findAll('[data-test="ch-cell"]')[col]
    }

    it('enters edit on dblclick with the original value focused and exits via Esc without any request', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      // attachTo:document.body 使输入框进入文档,自动聚焦才改变 activeElement。
      const wrapper = mount(
        CHTableBrowser,
        { props: { connectionId: 'ch1', database: 'logs', table: 'events' }, attachTo: document.body },
      )
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      const editor = wrapper.find('[data-test="ch-cell-editor"]')
      expect(editor.exists()).toBe(true)
      // 输入框承载 rows 内存中的原始值(null 才是空),并自动聚焦。
      expect((editor.element as HTMLInputElement).value).toBe('alice')
      expect(document.activeElement).toBe(editor.element)
      // Esc 退出编辑且不发起任何请求。
      await editor.trigger('keydown.esc')
      expect(wrapper.find('[data-test="ch-cell-editor"]').exists()).toBe(false)
      expect(wailsMocks.CHPreviewCellUpdate).not.toHaveBeenCalled()
      expect(wailsMocks.CHUpdateCell).not.toHaveBeenCalled()
      // blur 同样退出编辑。
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('blur')
      expect(wrapper.find('[data-test="ch-cell-editor"]').exists()).toBe(false)
      expect(wailsMocks.CHPreviewCellUpdate).not.toHaveBeenCalled()
    })

    it('ignores dblclick while a page request is loading', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      // 触发一次挂起的重拉(排序),进入 loading;旧行仍渲染。
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockImplementation(() => new Promise(() => {}))
      await wrapper.findAll('[data-test="ch-col"]')[0].trigger('click')
      expect(wrapper.find('[data-test="btn-ch-refresh"]').text()).toContain('加载中')
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      expect(wrapper.find('[data-test="ch-cell-editor"]').exists()).toBe(false)
    })

    it('does not start a second editor while one is active', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 0).trigger('dblclick')
      // jsdom 的 dblclick 不派发 blur,依赖组件守卫拒绝新编辑。
      await cellAt(wrapper, 1, 1).trigger('dblclick')
      const editors = wrapper.findAll('[data-test="ch-cell-editor"]')
      expect(editors).toHaveLength(1)
      // 仍是首个单元格的编辑器,值未被第二行的双击改写。
      expect((editors[0].element as HTMLInputElement).value).toBe('1')
    })

    it('builds the where clause from primary-key columns only', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      wailsMocks.CHPreviewCellUpdate.mockResolvedValue({
        statement: "ALTER TABLE logs.events UPDATE name = 'alice2' WHERE id = '1'",
        matched_rows: 1,
      })
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').setValue('alice2')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(wailsMocks.CHPreviewCellUpdate).toHaveBeenCalledWith({
          connection_id: 'ch1',
          database: 'logs',
          table: 'events',
          set: { column: 'name', type: 'String', value: 'alice2' },
          // 仅主键列,取编辑前原值。
          where: [{ column: 'id', type: 'UInt32', value: '1' }],
        })
      })
    })

    it('falls back to the whole original row as the where clause when there is no primary key', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page())
      wailsMocks.CHPreviewCellUpdate.mockResolvedValue({
        statement: "ALTER TABLE logs.events UPDATE id = '42' WHERE id = '1' AND name = 'alice'",
        matched_rows: 1,
      })
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 0).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').setValue('42')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(wailsMocks.CHPreviewCellUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            set: { column: 'id', type: 'UInt32', value: '42' },
            // 无主键:整行所有列的编辑前原值(不含编辑后的 '42')。
            where: [
              { column: 'id', type: 'UInt32', value: '1' },
              { column: 'name', type: 'String', value: 'alice' },
            ],
          }),
        )
      })
    })

    it('edits a NULL cell as an empty input, submits empty input as null, and snapshots null primaries into where', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      wailsMocks.CHPreviewCellUpdate.mockResolvedValue({
        statement: "ALTER TABLE logs.events UPDATE name = NULL WHERE id IS NULL",
        matched_rows: 1,
      })
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      // 第二行 id 原值为 NULL:NULL 单元格双击得到空输入框。
      await cellAt(wrapper, 1, 0).trigger('dblclick')
      expect((wrapper.find('[data-test="ch-cell-editor"]').element as HTMLInputElement).value).toBe('')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.esc')
      // 再编辑同行的 name 单元格,清空后回车 = 写 NULL;where 中主键
      // 原值为 null(编辑前快照)。
      await cellAt(wrapper, 1, 1).trigger('dblclick')
      const editor = wrapper.find('[data-test="ch-cell-editor"]')
      expect((editor.element as HTMLInputElement).value).toBe('bob')
      await editor.setValue('')
      await editor.trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(wailsMocks.CHPreviewCellUpdate).toHaveBeenCalledWith(
          expect.objectContaining({
            set: { column: 'name', type: 'String', value: null },
            where: [{ column: 'id', type: 'UInt32', value: null }],
          }),
        )
      })
    })

    it('empties a non-null input into a null write', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      wailsMocks.CHPreviewCellUpdate.mockResolvedValue({
        statement: "ALTER TABLE logs.events UPDATE name = NULL WHERE id = '1'",
        matched_rows: 1,
      })
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').setValue('')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(wailsMocks.CHPreviewCellUpdate).toHaveBeenCalledWith(
          expect.objectContaining({ set: { column: 'name', type: 'String', value: null } }),
        )
      })
    })

    it('shows the full statement and matched rows in the confirm dialog, warns above one row, and refreshes after confirm', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      wailsMocks.CHPreviewCellUpdate.mockResolvedValue({
        statement: "ALTER TABLE logs.events UPDATE name = 'alice2' WHERE id = '1'",
        matched_rows: 3,
      })
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').setValue('alice2')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(confirmDialog()).not.toBeNull()
      })
      const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
      // 弹窗含 ALTER 语句全文、匹配行数;N>1 追加多行警示。
      expect(msg).toContain("ALTER TABLE logs.events UPDATE name = 'alice2' WHERE id = '1'")
      expect(msg).toContain('匹配 3 行')
      expect(msg).toContain('将同时更新 3 行,请确认')
      const callsBefore = (api.chPageRows as ReturnType<typeof vi.fn>).mock.calls.length
      clickConfirmDialog('confirm-dialog-ok')
      await vi.waitFor(() => {
        expect(wailsMocks.CHUpdateCell).toHaveBeenCalled()
      })
      // 确认成功后刷新当前页:chPageRows 调用次数 +1。
      await vi.waitFor(() => {
        expect((api.chPageRows as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore + 1)
      })
    })

    it('does not execute when the confirm dialog is canceled', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      wailsMocks.CHPreviewCellUpdate.mockResolvedValue({
        statement: "ALTER TABLE logs.events UPDATE name = 'alice2' WHERE id = '1'",
        matched_rows: 1,
      })
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').setValue('alice2')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(confirmDialog()).not.toBeNull()
      })
      clickConfirmDialog('confirm-dialog-cancel')
      await vi.waitFor(() => {
        expect(confirmDialog()).toBeNull()
      })
      expect(wailsMocks.CHUpdateCell).not.toHaveBeenCalled()
      // 未执行也就不刷新:仍只有初始 1 次分页请求。
      expect((api.chPageRows as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1)
    })

    it('shows a single-row message without the multi-row warning', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      wailsMocks.CHPreviewCellUpdate.mockResolvedValue({
        statement: "ALTER TABLE logs.events UPDATE name = 'alice2' WHERE id = '1'",
        matched_rows: 1,
      })
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').setValue('alice2')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(confirmDialog()).not.toBeNull()
      })
      const msg = document.body.querySelector('[data-test="confirm-dialog-message"]')?.textContent ?? ''
      expect(msg).toContain('匹配 1 行')
      expect(msg).not.toContain('将同时更新')
    })

    it('surfaces a failed preview in the existing error area', async () => {
      ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page({ primary_key: ['id'] }))
      wailsMocks.CHPreviewCellUpdate.mockRejectedValue(new Error('预览失败'))
      const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
      await waitCols(wrapper)
      await cellAt(wrapper, 0, 1).trigger('dblclick')
      await wrapper.find('[data-test="ch-cell-editor"]').trigger('keydown.enter')
      await vi.waitFor(() => {
        expect(wrapper.find('[data-test="ch-error"]').text()).toContain('预览失败')
      })
      expect(wailsMocks.CHUpdateCell).not.toHaveBeenCalled()
    })
  })
})
