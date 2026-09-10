import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, type VueWrapper } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { CHPageRowsResult } from '@/api/types'
import CHTableBrowser from './CHTableBrowser.vue'

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

describe('CHTableBrowser', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
    document.body.innerHTML = ''
  })

  it('fetches the first page and renders columns, rows, NULL cells and the summary', async () => {
    ;(api.chPageRows as ReturnType<typeof vi.fn>).mockResolvedValue(page())
    const wrapper = mount(CHTableBrowser, { props: { connectionId: 'ch1', database: 'logs', table: 'events' } })
    await waitCols(wrapper)
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
})
