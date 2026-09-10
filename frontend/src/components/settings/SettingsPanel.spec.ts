import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { AuditEntry, Connection } from '@/api/types'
import { APP_VERSION } from '@/version'
import { DEFAULT_QUERY_DIR, QUERY_DIR_KEY } from '@/utils/queryDir'
import SettingsPanel from './SettingsPanel.vue'

const KEY = 'dbclient-theme'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: never) => c),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async (): Promise<Connection> => ({
      id: 'c1',
      name: 'local',
      type: 'kafka',
      config: { bootstrap_servers: ['localhost:9092'] },
      created_at: 1,
      updated_at: 1,
    })),
    listTopics: vi.fn(async () => []),
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    describeCluster: vi.fn(async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 })),
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
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
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
    ...overrides,
  }
}

const entry = (overrides: Partial<AuditEntry> = {}): AuditEntry => ({
  id: 1,
  connection_id: 'c1',
  action: 'create_topic',
  target: 'orders',
  result: 'ok',
  detail: '',
  timestamp: 1700000000000,
  ...overrides,
})

function mountPanel(show = true) {
  const wrapper = mount(SettingsPanel, { props: { show } })
  return wrapper
}

// 设置面板改为左侧导航 + 内容区,审计/驱动等内容需先切换对应 tab 才可见。
async function openTab(wrapper: ReturnType<typeof mount>, tab: 'audit' | 'drivers' | 'about'): Promise<void> {
  await wrapper.find(`[data-test="settings-tab-${tab}"]`).trigger('click')
}

describe('SettingsPanel', () => {
  let api: Api
  beforeEach(() => {
    localStorage.clear()
    document.documentElement.removeAttribute('data-theme')
    api = fakeApi()
    setApi(api)
  })

  it('renders nothing when hidden', () => {
    const wrapper = mountPanel(false)
    expect(wrapper.find('[data-test="settings-panel"]').exists()).toBe(false)
  })

  it('defaults to light theme and applies it on mount', () => {
    mountPanel()
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(KEY)).toBe('light')
  })

  it('switching to light persists and applies the theme', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="select-theme"]').setValue('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
    expect(localStorage.getItem(KEY)).toBe('light')
  })

  it('reads a previously stored theme', () => {
    localStorage.setItem(KEY, 'light')
    const wrapper = mountPanel()
    expect((wrapper.find('[data-test="select-theme"]').element as HTMLSelectElement).value).toBe('light')
    expect(document.documentElement.getAttribute('data-theme')).toBe('light')
  })

  it('emits close', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.emitted('close')).toBeTruthy()
  })

  // --- 左侧导航 + 内容区(macOS 系统设置风格) --------------------------------

  it('defaults to the generic tab with the four nav items and the theme select', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-test="settings-nav"]').exists()).toBe(true)
    for (const id of ['settings-tab-generic', 'settings-tab-audit', 'settings-tab-drivers', 'settings-tab-about']) {
      expect(wrapper.find(`[data-test="${id}"]`).exists()).toBe(true)
    }
    expect(wrapper.find('[data-test="settings-tab-content"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="select-theme"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="drivers-section"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="audit-section"]').exists()).toBe(false)
  })

  it('switches to the audit tab and hides the theme select', async () => {
    const wrapper = mountPanel()
    await openTab(wrapper, 'audit')
    expect(wrapper.find('[data-test="audit-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="select-theme"]').exists()).toBe(false)
  })

  it('switches to the drivers tab and shows the drivers section', async () => {
    const wrapper = mountPanel()
    await openTab(wrapper, 'drivers')
    expect(wrapper.find('[data-test="drivers-section"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="select-theme"]').exists()).toBe(false)
  })

  it('shows version, author and a check-update button on the about tab and emits check-update', async () => {
    const wrapper = mountPanel()
    await openTab(wrapper, 'about')
    const content = wrapper.find('[data-test="settings-tab-content"]')
    expect(content.text()).toContain(APP_VERSION)
    expect(content.text()).toContain('By Mr Zp')
    const btn = wrapper.find('[data-test="btn-about-check"]')
    expect(btn.exists()).toBe(true)
    expect(content.text()).toContain('将在 Gitee 检查最新版本')
    await btn.trigger('click')
    expect(wrapper.emitted('check-update')).toBeTruthy()
  })

  it('does not close when the backdrop is clicked', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="settings-panel"]').trigger('click')
    expect(wrapper.emitted('close')).toBeFalsy()
  })

  it('loads the audit list on mount and renders one row per entry', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry({ action: 'create_connection', target: 'local', result: 'ok' }),
      entry({ id: 2, action: 'delete_topic', target: 'orders', result: 'error', detail: 'unknown topic', timestamp: 1700000001000 }),
    ])
    const wrapper = mountPanel()
    await openTab(wrapper, 'audit')
    await vi.waitFor(() => {
      expect(api.listAudit).toHaveBeenCalledWith(200)
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="audit-row"]')).toHaveLength(2)
    })
    const rows = wrapper.findAll('[data-test="audit-row"]')
    // Action labels are localized.
    expect(rows[0].text()).toContain('新建连接')
    expect(rows[1].text()).toContain('删除 Topic')
    // Targets and results render.
    expect(rows[0].text()).toContain('local')
    expect(rows[0].text()).toContain('成功')
    expect(rows[1].text()).toContain('失败')
    expect(rows[1].text()).toContain('unknown topic')
    // Timestamps are formatted (not the raw epoch).
    expect(rows[0].find('[data-test="audit-time"]').text()).not.toBe('1700000000000')
  })

  it('renders the audit table with localized action labels and unknown fallback', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([
      entry({ action: 'reset_group_offset', target: 'grp/t', detail: 'earliest' }),
      entry({ id: 2, action: 'mystery_op', target: 'x', result: 'error' }),
    ])
    const wrapper = mountPanel()
    await openTab(wrapper, 'audit')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="audit-row"]')).toHaveLength(2)
    })
    const rows = wrapper.findAll('[data-test="audit-row"]')
    expect(rows[0].text()).toContain('重置消费组位移')
    // Unknown actions fall back to the raw action string.
    expect(rows[1].text()).toContain('mystery_op')
  })

  it('shows an empty state when no audit entries exist', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mountPanel()
    await openTab(wrapper, 'audit')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="audit-empty"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="audit-table"]').exists()).toBe(false)
  })

  it('re-fetches the audit list when the refresh button is clicked', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockResolvedValue([entry()])
    const wrapper = mountPanel()
    await openTab(wrapper, 'audit')
    await vi.waitFor(() => {
      expect(api.listAudit).toHaveBeenCalledTimes(1)
    })
    await wrapper.find('[data-test="audit-refresh"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.listAudit).toHaveBeenCalledTimes(2)
    })
  })

  it('surfaces audit load errors in a banner', async () => {
    ;(api.listAudit as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('disk full'))
    const wrapper = mountPanel()
    await openTab(wrapper, 'audit')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="audit-error"]').text()).toContain('disk full')
    })
  })

  it('renders the drivers section from ListDrivers with path placeholders', async () => {
    ;(api.listDrivers as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'Kafka', library: 'franz-go', version: 'v1.23.0', default_port: 9092, description: 'Kafka 原生客户端' },
      { name: 'Redis', library: 'go-redis', version: 'v9.22.0', default_port: 6379, description: 'Redis 原生客户端' },
    ])
    const wrapper = mountPanel()
    await openTab(wrapper, 'drivers')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="driver-row"]')).toHaveLength(2)
    })
    expect(api.listDrivers).toHaveBeenCalled()
    const rows = wrapper.findAll('[data-test="driver-row"]')
    expect(rows).toHaveLength(2)
    expect(rows[0].text()).toContain('Kafka')
    expect(rows[0].text()).toContain('franz-go')
    expect(rows[0].text()).toContain('v1.23.0')
    expect(rows[0].text()).toContain('9092')
    expect(rows[1].text()).toContain('go-redis')
    expect(wrapper.find('[data-test="drivers-hint"]').text()).toContain('驱动为内置原生实现,无需外部路径')
    const pathInput = rows[0].find('[data-test="driver-path"]')
    expect((pathInput.element as HTMLInputElement).placeholder).toBe('外部驱动路径(预留)')
    expect((pathInput.element as HTMLInputElement).disabled).toBe(true)
  })

  it('falls back to the built-in driver constants when ListDrivers fails', async () => {
    ;(api.listDrivers as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('binding not generated'))
    const wrapper = mountPanel()
    await openTab(wrapper, 'drivers')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="driver-row"]')).toHaveLength(3)
    })
    const texts = wrapper.findAll('[data-test="driver-row"]').map((r) => r.text())
    expect(texts[0]).toContain('franz-go')
    expect(texts[0]).toContain('9092')
    expect(texts[1]).toContain('go-redis')
    expect(texts[1]).toContain('6379')
    expect(texts[2]).toContain('clickhouse-go')
    expect(texts[2]).toContain('9000')
  })

  // --- 通用 tab:查询文件目录 ---------------------------------------------------

  it('shows the query dir section with the default dir when localStorage is empty', () => {
    const wrapper = mountPanel()
    expect(wrapper.find('[data-test="query-dir-section"]').exists()).toBe(true)
    const input = wrapper.find('[data-test="input-query-dir"]')
    expect(input.exists()).toBe(true)
    expect((input.element as HTMLInputElement).value).toBe(DEFAULT_QUERY_DIR)
    // 说明文字与恢复默认按钮齐备。
    expect(wrapper.find('[data-test="query-dir-section"]').text()).toContain('查询文件目录')
    expect(wrapper.find('[data-test="query-dir-section"]').text()).toContain('SQL 控制台的保存查询将存放为 .sql 文件')
    expect(wrapper.find('[data-test="btn-query-dir-reset"]').exists()).toBe(true)
  })

  it('persists query dir input changes to localStorage immediately', async () => {
    const wrapper = mountPanel()
    await wrapper.find('[data-test="input-query-dir"]').setValue('/tmp/my-queries')
    expect(localStorage.getItem(QUERY_DIR_KEY)).toBe('/tmp/my-queries')
  })

  it('removes the localStorage key when the query dir input is cleared', async () => {
    localStorage.setItem(QUERY_DIR_KEY, '/tmp/my-queries')
    const wrapper = mountPanel()
    expect((wrapper.find('[data-test="input-query-dir"]').element as HTMLInputElement).value).toBe('/tmp/my-queries')
    await wrapper.find('[data-test="input-query-dir"]').setValue('')
    expect(localStorage.getItem(QUERY_DIR_KEY)).toBeNull()
  })

  it('resets the query dir to the default via the reset button', async () => {
    localStorage.setItem(QUERY_DIR_KEY, '/tmp/my-queries')
    const wrapper = mountPanel()
    await wrapper.find('[data-test="btn-query-dir-reset"]').trigger('click')
    expect((wrapper.find('[data-test="input-query-dir"]').element as HTMLInputElement).value).toBe(DEFAULT_QUERY_DIR)
    expect(localStorage.getItem(QUERY_DIR_KEY)).toBe(DEFAULT_QUERY_DIR)
  })
})
