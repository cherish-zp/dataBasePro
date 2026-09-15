import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { EsClusterStats } from '@/api/types'
import { useTabsStore } from '@/store/tabs'
import EsClusterMonitor from './EsClusterMonitor.vue'

// wailsjs 绑定 mock(vi.hoisted):EsClusterStats 绑定尚未生成,client 的
// esClusterStats 实现以形状断言转发到 App.ESClusterStats;fake api 注入
// esClusterStats 转发到该 mock。用例统一驱动 App.ESClusterStats 的返回值并
// 断言调用参数,绑定生成后无需改写。
const appMocks = vi.hoisted(() => ({
  ESClusterStats: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...appMocks }
})

function fakeApi(): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as never),
    listTopics: vi.fn(async () => []),
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    describeCluster: vi.fn(
      async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 }) as never,
    ),
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
    redisHashSetField: vi.fn(async () => {}),
    redisHashDeleteField: vi.fn(async () => {}),
    redisListSetIndex: vi.fn(async () => {}),
    redisListPush: vi.fn(async () => {}),
    redisListDeleteIndex: vi.fn(async () => {}),
    redisSetAdd: vi.fn(async () => {}),
    redisSetRemove: vi.fn(async () => {}),
    redisZSetAdd: vi.fn(async () => {}),
    redisZSetRemove: vi.fn(async () => {}),
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
    saveTextFile: vi.fn(async () => ''),
    updateConnection: vi.fn(async () => ({}) as never),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
  }
}

// 注入 esClusterStats(转发到 mock 的 wailsjs 绑定)后的 fake api。
// esClusterStats 已是 client.ts 的可选成员,直接赋值即可。
function fakeEsApi(): Api {
  const api = fakeApi()
  api.esClusterStats = (req) => appMocks.ESClusterStats(req)
  return api
}

const stats = (over: Partial<EsClusterStats> = {}): EsClusterStats => ({
  cluster_name: 'es-prod',
  status: 'green',
  number_of_nodes: 3,
  number_of_data_nodes: 2,
  active_shards: 42,
  active_primary_shards: 20,
  relocating_shards: 1,
  unassigned_shards: 4,
  indices_count: 18,
  docs_count: 123456,
  store_size_bytes: 3 * 1024 * 1024,
  templates_count: 5,
  nodes: [
    { name: 'node-1', ip: '10.0.0.1', roles: 'master,data', heap_percent: 62, disk_percent: 47 },
    { name: 'node-2', ip: '10.0.0.2', roles: 'data', heap_percent: 91, disk_percent: 88 },
  ],
  ...over,
})

function mountMonitor(connectionId = 'e1') {
  return mount(EsClusterMonitor, { props: { connectionId } })
}

// 空转 0ms 假计时器:跨多次 await 排空微任务,让首屏拉取与渲染落地,
// 又不会推进 10s 轮询间隔。
async function settle(): Promise<void> {
  await vi.advanceTimersByTimeAsync(0)
}

describe('EsClusterMonitor', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    appMocks.ESClusterStats.mockReset().mockResolvedValue(stats())
    setApi(fakeEsApi())
  })

  it('以 connection_id 拉取集群监控数据并渲染集群名', async () => {
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-status"]').exists()).toBe(true)
    })
    expect(appMocks.ESClusterStats).toHaveBeenCalledWith({ connection_id: 'e1' })
    expect(wrapper.find('[data-test="monitor-status"]').text()).toContain('es-prod')
  })

  it.each([
    ['green', 'status-green'],
    ['yellow', 'status-yellow'],
    ['red', 'status-red'],
  ])('状态 %s 渲染对应色带与 data-status', async (status, cls) => {
    appMocks.ESClusterStats.mockResolvedValue(stats({ status }))
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-status"]').classes()).toContain(cls)
    })
    expect(wrapper.find('[data-test="monitor-status"]').attributes('data-status')).toBe(status)
  })

  it('渲染六张指标卡数值(节点/索引/分片/文档/存储/模板)', async () => {
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-tiles"]').exists()).toBe(true)
    })
    const tiles = wrapper.find('[data-test="monitor-tiles"]')
    expect(tiles.find('[data-test="tile-nodes"]').text()).toContain('3')
    expect(tiles.find('[data-test="tile-nodes"]').text()).toContain('2')
    expect(tiles.find('[data-test="tile-indices"]').text()).toContain('18')
    expect(tiles.find('[data-test="tile-shards-active"]').text()).toBe('42')
    expect(tiles.find('[data-test="tile-shards-primary"]').text()).toContain('20')
    expect(tiles.find('[data-test="tile-docs"]').text()).toContain('123456')
    expect(tiles.find('[data-test="tile-store"]').text()).toContain('3 MB')
    expect(tiles.find('[data-test="tile-templates"]').text()).toContain('5')
  })

  it('点击模板数卡片打开该连接的模板管理 tab', async () => {
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="tile-templates"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="tile-templates"]').trigger('click')
    const store = useTabsStore()
    expect(store.openTabs.some((t) => t.kind === 'es-templates' && t.connectionId === 'e1')).toBe(true)
    expect(store.activeTabId).toBe('es-templates:e1')
  })

  it('渲染节点简表(名称/IP/角色/堆%/磁盘%),高水位标红', async () => {
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-nodes"]').exists()).toBe(true)
    })
    const rows = wrapper.findAll('[data-test="node-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('node-1')
    expect(rows[0].text()).toContain('10.0.0.1')
    expect(rows[0].text()).toContain('master,data')
    expect(rows[0].find('[data-test="node-heap"]').text()).toBe('62%')
    expect(rows[0].find('[data-test="node-disk"]').text()).toBe('47%')
    expect(rows[0].find('[data-test="node-heap"]').classes()).not.toContain('danger')
    // 堆 91% 超过 90 阈值标红,磁盘 88% 不标。
    expect(rows[1].find('[data-test="node-heap"]').classes()).toContain('danger')
    expect(rows[1].find('[data-test="node-disk"]').classes()).not.toContain('danger')
  })

  it('节点列表为空时展示空态', async () => {
    appMocks.ESClusterStats.mockResolvedValue(stats({ nodes: [] }))
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="nodes-empty"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="nodes-empty"]').text()).toContain('无节点信息')
    expect(wrapper.findAll('[data-test="node-row"]')).toHaveLength(0)
  })

  it('加载成功后展示最近更新时间', async () => {
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-updated"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="monitor-updated"]').text()).toContain('最近更新')
  })

  it('首屏拉取中展示加载态', async () => {
    appMocks.ESClusterStats.mockReturnValue(new Promise(() => {}))
    const wrapper = mountMonitor()
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="monitor-loading"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('手动刷新立即重新拉取', async () => {
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-status"]').exists()).toBe(true)
    })
    expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(1)
    await wrapper.find('[data-test="monitor-refresh"]').trigger('click')
    await vi.waitFor(() => {
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(2)
    })
  })

  it('请求失败在面板内错误区展示', async () => {
    appMocks.ESClusterStats.mockRejectedValue(new Error('boom'))
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-error"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="monitor-error"]').text()).toContain('boom')
    expect(wrapper.find('[data-test="monitor-status"]').exists()).toBe(false)
  })

  it('轮询失败保留旧数据并提示,恢复成功后错误清除', async () => {
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-status"]').exists()).toBe(true)
    })
    appMocks.ESClusterStats.mockRejectedValue(new Error('poll boom'))
    await wrapper.find('[data-test="monitor-refresh"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-error"]').text()).toContain('poll boom')
    })
    // 旧数据保留,不白屏。
    expect(wrapper.find('[data-test="monitor-status"]').exists()).toBe(true)
    // 恢复成功后错误清除并渲染新数据。
    appMocks.ESClusterStats.mockResolvedValue(stats({ cluster_name: 'es-prod-2' }))
    await wrapper.find('[data-test="monitor-refresh"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-error"]').exists()).toBe(false)
    })
    expect(wrapper.find('[data-test="monitor-status"]').text()).toContain('es-prod-2')
  })

  it('client 未提供 esClusterStats 时面板内提示暂不支持', async () => {
    setApi(fakeApi())
    const wrapper = mountMonitor()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="monitor-error"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="monitor-error"]').text()).toContain('暂不支持')
  })

  it('自动轮询默认开启且每 10 秒拉取一次', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountMonitor()
      await settle()
      expect(
        (wrapper.find('[data-test="monitor-auto"]').element as HTMLInputElement).checked,
      ).toBe(true)
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(1)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(2)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(3)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('关闭轮询开关即停止,重新打开即恢复', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountMonitor()
      await settle()
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(1)
      await wrapper.find('[data-test="monitor-auto"]').setValue(false)
      await vi.advanceTimersByTimeAsync(30_000)
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(1)
      await wrapper.find('[data-test="monitor-auto"]').setValue(true)
      await vi.advanceTimersByTimeAsync(10_000)
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(2)
      wrapper.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('卸载后清理轮询定时器', async () => {
    vi.useFakeTimers()
    try {
      const wrapper = mountMonitor()
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(1)
      wrapper.unmount()
      await vi.advanceTimersByTimeAsync(30_000)
      expect(appMocks.ESClusterStats).toHaveBeenCalledTimes(1)
    } finally {
      vi.useRealTimers()
    }
  })
})
