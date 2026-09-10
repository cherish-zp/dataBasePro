import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import * as App from '../../../wailsjs/go/backend/App'
import Layout from './Layout.vue'
import ConnectionTree from '@/components/common/ConnectionTree.vue'
import MessageBrowser from '@/components/kafka/MessageBrowser.vue'
import CHSqlConsole from '@/components/kafka/CHSqlConsole.vue'
import SettingsPanel from '@/components/settings/SettingsPanel.vue'
import { useConnectionsStore } from '@/store/connections'
import { APP_VERSION } from '@/version'
import { useTabsStore } from '@/store/tabs'
import { useToastStore } from '@/store/toast'

// SQL文件面板/composable 走 wailsjs 四方法;mock 之(其余方法走真实模块),
// 由用例按需 mockResolvedValue 驱动文件列表与读取。
const fileAppMocks = vi.hoisted(() => ({
  ListQueryFiles: vi.fn(),
  ReadQueryFile: vi.fn(),
  WriteQueryFile: vi.fn(),
  DeleteQueryFile: vi.fn(),
}))
vi.mock('../../../wailsjs/go/backend/App', async () => {
  const actual = await vi.importActual<typeof import('../../../wailsjs/go/backend/App')>(
    '../../../wailsjs/go/backend/App',
  )
  return { ...actual, ...fileAppMocks }
})
const fileApp = App as unknown as typeof fileAppMocks

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
    ...overrides,
  }
}

const conn = (id: string): Connection => ({
  id, name: `conn-${id}`, type: 'kafka',
  config: { bootstrap_servers: ['h:1'] }, created_at: 1, updated_at: 1,
})
const chConn = (id: string): Connection => ({
  ...conn(id), type: 'clickhouse', config: {} as Connection['config'],
})
const redisConn = (id: string): Connection => ({
  ...conn(id), type: 'redis', config: {} as Connection['config'],
})

const queryFileRow = (name: string, connectionId: string) => ({
  name, connection_id: connectionId, size_bytes: 1, mod_time_ms: 1_700_000_000_000,
})

function mountLayout(connections: Connection[] = [], overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(Layout, { props: { connections } })
  return { wrapper, api }
}

function emitTree(wrapper: ReturnType<typeof mount>, event: string, ...args: unknown[]): void {
  wrapper.findComponent(ConnectionTree).vm.$emit(event, ...args)
}

describe('Layout', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    // Teleported overlays (palette, context menu) and window listeners from a
    // previous test must not survive into the next one.
    document.body.innerHTML = ''
    // 查询文件四方法恢复默认空实现,避免用例间串扰。
    fileAppMocks.ListQueryFiles.mockReset().mockResolvedValue([])
    fileAppMocks.ReadQueryFile.mockReset()
    fileAppMocks.WriteQueryFile.mockReset().mockResolvedValue(undefined)
    fileAppMocks.DeleteQueryFile.mockReset().mockResolvedValue(undefined)
    // 右栏展开态/宽度也会跨用例泄漏(挂载时提前刷新导致拿到空列表)。
    localStorage.removeItem('dbclient-files-open')
    localStorage.removeItem('dbclient-files-width')
  })

  it('shows the welcome view when no tab is open', () => {
    const { wrapper } = mountLayout([conn('a')])
    expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="connection-tree"]').exists()).toBe(true)
  })

  it('mounts the bottom status bar and live-updates from the connections store', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const statusBar = wrapper.find('[data-test="status-bar"]')
    expect(statusBar.exists()).toBe(true)
    expect(statusBar.find('[data-test="status-count"]').text()).toBe('连接 0 · 在线 0')
    // The status bar reads the connections store, not the Layout prop, so it
    // reflects store mutations without a remount.
    const store = useConnectionsStore()
    store.connections.push(conn('b'))
    store.setStatus('b', 'connected')
    await nextTick()
    expect(statusBar.find('[data-test="status-count"]').text()).toBe('连接 1 · 在线 1')
  })

  it('opens a topic tab from the tree and renders the message browser', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="message-browser"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="home-view"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="tab"]').text()).toContain('orders')
  })

  it('opens a group tab and renders the consumer group view', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-group', 'a', 'grp-1')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="group-view"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="tab"]').text()).toContain('grp-1')
  })

  it('switches between open tabs', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    emitTree(wrapper, 'open-topic', 'a', 't2', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(2)
    })
    const tabs = wrapper.findAll('[data-test="tab"]')
    await tabs[0].trigger('click')
    expect(tabs[0].classes()).toContain('active')
  })

  it('closes the active tab and falls back to the welcome view', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="tab-close"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="tab-close"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    })
  })

  it('opens the settings modal from the top bar', async () => {
    const { wrapper } = mountLayout([conn('a')])
    await wrapper.find('[data-test="btn-settings"]').trigger('click')
    expect(wrapper.find('[data-test="settings-panel"]').exists()).toBe(true)
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.find('[data-test="settings-panel"]').exists()).toBe(false)
  })

  it('opens the update dialog when the settings panel emits check-update', async () => {
    const { wrapper } = mountLayout([conn('a')])
    await wrapper.find('[data-test="btn-settings"]').trigger('click')
    expect(document.body.querySelector('[data-test="update-dialog"]')).toBeNull()
    await wrapper.findComponent(SettingsPanel).vm.$emit('check-update')
    await nextTick()
    expect(document.body.querySelector('[data-test="update-dialog"]')).not.toBeNull()
  })

  it('keeps the top bar general (brand + settings, no connection/kafka actions)', () => {
    const { wrapper } = mountLayout([conn('a')])
    const topbar = wrapper.find('[data-test="topbar"]')
    expect(topbar.find('[data-test="brand"]').text()).toContain('dataBasePro')
    expect(topbar.find('[data-test="btn-settings"]').exists()).toBe(true)
    expect(topbar.find('[data-test="btn-new"]').exists()).toBe(false)
    expect(topbar.find('[data-test="btn-sql"]').exists()).toBe(false)
    expect(topbar.find('[data-test="btn-producer"]').exists()).toBe(false)
  })

  it('opens the producer panel from the message browser toolbar', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="message-browser"]').exists()).toBe(true)
    })
    await wrapper.findComponent(MessageBrowser).vm.$emit('open-producer')
    expect(wrapper.find('[data-test="producer-panel"]').exists()).toBe(true)
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    expect(wrapper.find('[data-test="producer-panel"]').exists()).toBe(false)
  })

  // 旧「消息浏览工具栏打开 SQL 控制台」入口已删除:与顶栏新建查询完全重复,
  // topic tab → SQL · orders 的行为由「新建查询」用例覆盖。

  it('opens the global lag overview as a full tab from the tree entry', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-lag', 'a')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="global-lag-view"]').exists()).toBe(true)
    })
    expect(wrapper.findAll('[data-test="tab"]').some((t) => t.text().includes('Lag 总览'))).toBe(true)
  })

  it('opens the cluster health overview as a full tab from the tree entry with the connection id', async () => {
    const { wrapper, api } = mountLayout([conn('a')], {
      describeCluster: vi.fn(async () => ({
        cluster_id: 'kfake',
        controller_id: 0,
        kafka_version: 'v3.7',
        brokers: [{ id: 0, host: 'b0', port: 9092, rack: '', version: 'v3.7', online: true }],
        under_replicated_partitions: 0,
      })),
    })
    emitTree(wrapper, 'open-health', 'a')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="broker-card"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="cluster-health-panel"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="sidebar"]').find('[data-test="cluster-health-panel"]').exists()).toBe(false)
    expect(wrapper.findAll('[data-test="tab"]').some((t) => t.text().includes('集群健康'))).toBe(true)
    expect(api.describeCluster).toHaveBeenCalledWith('a')
  })

  it('closes tabs of a deleted connection and emits delete', async () => {
    const { wrapper } = mountLayout([conn('a'), conn('b')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="message-browser"]').exists()).toBe(true)
    })
    emitTree(wrapper, 'delete', 'a')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    })
    expect(wrapper.emitted('delete-connection')).toBeTruthy()
    expect(wrapper.emitted('delete-connection')?.[0]).toEqual(['a'])
  })

  it('emits new when requested', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'new')
    expect(wrapper.emitted('new')).toBeTruthy()
  })

  it('emits edit-connection with the connection when requested', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'edit-connection', conn('a'))
    expect(wrapper.emitted('edit-connection')?.[0]).toEqual([conn('a')])
  })
  it('renders a draggable divider between the sidebar and the workspace', () => {
    const { wrapper } = mountLayout([conn('a')])
    const resizer = wrapper.find('[data-test="sidebar-resizer"]')
    expect(resizer.exists()).toBe(true)
    expect(resizer.classes()).toContain('sidebar-resizer')
    expect(wrapper.find('[data-test="sidebar"]').attributes('style')).toContain('336px')
  })

  it('widens the sidebar when the divider is dragged to the right', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const resizer = wrapper.find('[data-test="sidebar-resizer"]')
    await resizer.trigger('mousedown', { clientX: 0 })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    const style = wrapper.find('[data-test="sidebar"]').attributes('style') ?? ''
    expect(style).toContain('436px')
  })

  it('clamps the sidebar width within minimum and maximum bounds', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const resizer = wrapper.find('[data-test="sidebar-resizer"]')
    await resizer.trigger('mousedown', { clientX: 300 })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: -5000 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(wrapper.find('[data-test="sidebar"]').attributes('style')).toContain('200px')
    await resizer.trigger('mousedown', { clientX: 0 })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 100000 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(wrapper.find('[data-test="sidebar"]').attributes('style')).toContain('640px')
  })

  it('marks the layout as resizing while dragging and clears it on release', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const resizer = wrapper.find('[data-test="sidebar-resizer"]')
    await resizer.trigger('mousedown', { clientX: 0 })
    expect(wrapper.classes()).toContain('resizing')
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(wrapper.classes()).not.toContain('resizing')
  })

  it('opens the command palette with cmd+k no matter where focus sits', async () => {
    const { wrapper } = mountLayout([conn('a')])
    expect(document.body.querySelector('[data-test="command-palette"]')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('ignores a plain k press without the shortcut modifier', async () => {
    mountLayout([conn('a')])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k' }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).toBeNull()
  })

  it('stops listening for cmd+k after unmount', async () => {
    const { wrapper } = mountLayout([conn('a')])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).not.toBeNull()
    wrapper.unmount()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).toBeNull()
  })

  it('opens a context menu on right-click with close / close-others / close-all / refresh', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="message-browser"]').exists()).toBe(true)
    })
    await wrapper.findAll('[data-test="tab"]')[0].trigger('contextmenu', { clientX: 100, clientY: 120 })
    const menu = document.body.querySelector('[data-test="tab-context-menu"]') as HTMLElement
    expect(menu).not.toBeNull()
    // Positioned at the cursor.
    expect(menu.style.left).toBe('100px')
    expect(menu.style.top).toBe('120px')
    expect(menu.querySelector('[data-test="context-close"]')).not.toBeNull()
    expect(menu.querySelector('[data-test="context-close-others"]')).not.toBeNull()
    expect(menu.querySelector('[data-test="context-close-all"]')).not.toBeNull()
    expect(menu.querySelector('[data-test="context-refresh"]')).not.toBeNull()
  })

  it('closes the right-clicked tab via the context menu', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    emitTree(wrapper, 'open-topic', 'a', 't2', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(2)
    })
    await wrapper.findAll('[data-test="tab"]')[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    ;(document.body.querySelector('[data-test="context-close"]') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    expect(wrapper.find('[data-test="tab"]').text()).toContain('t2')
  })

  it('keeps only the right-clicked tab via 关闭其他', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    emitTree(wrapper, 'open-topic', 'a', 't2', [])
    emitTree(wrapper, 'open-topic', 'a', 't3', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(3)
    })
    await wrapper.findAll('[data-test="tab"]')[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    ;(document.body.querySelector('[data-test="context-close-others"]') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    expect(wrapper.find('[data-test="tab"]').text()).toContain('t1')
  })

  it('closes every tab via 关闭全部', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    await wrapper.find('[data-test="tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    ;(document.body.querySelector('[data-test="context-close-all"]') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    })
    expect(document.body.querySelector('[data-test="tab-context-menu"]')).toBeNull()
  })

  it('hides the refresh item on the context menu of a sql tab', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const tabs = useTabsStore()
    tabs.openSql('a', 'orders')
    await nextTick()
    await wrapper.find('[data-test="tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    const menu = document.body.querySelector('[data-test="tab-context-menu"]') as HTMLElement
    expect(menu).not.toBeNull()
    expect(menu.querySelector('[data-test="context-refresh"]')).toBeNull()
    expect(menu.querySelector('[data-test="context-close"]')).not.toBeNull()
  })

  it('refreshes the right-clicked tab through the context menu', async () => {
    const { wrapper, api } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalled()
    })
    await wrapper.findAll('[data-test="tab"]')[0].trigger('contextmenu', { clientX: 10, clientY: 10 })
    ;(document.body.querySelector('[data-test="context-refresh"]') as HTMLElement).click()
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(2)
    })
  })

  it('closes the context menu on Escape', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    await wrapper.find('[data-test="tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(document.body.querySelector('[data-test="tab-context-menu"]')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))
    await nextTick()
    expect(document.body.querySelector('[data-test="tab-context-menu"]')).toBeNull()
  })

  it('closes the context menu on an outside click', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    await wrapper.find('[data-test="tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(document.body.querySelector('[data-test="tab-context-menu"]')).not.toBeNull()
    document.body.click()
    await nextTick()
    expect(document.body.querySelector('[data-test="tab-context-menu"]')).toBeNull()
  })

  it('refreshes the active topic from the top bar refresh button', async () => {
    const { wrapper, api } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalled()
    })
    const btn = wrapper.find('[data-test="btn-refresh-active"]')
    expect(btn.attributes('disabled')).toBeUndefined()
    await btn.trigger('click')
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(2)
    })
  })

  it('disables the top bar refresh button for a sql tab', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const tabs = useTabsStore()
    tabs.openSql('a', 'orders')
    await nextTick()
    expect(wrapper.find('[data-test="btn-refresh-active"]').attributes('disabled')).toBeDefined()
  })

  it('reorders tabs by drag and drop', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    emitTree(wrapper, 'open-topic', 'a', 't2', [])
    emitTree(wrapper, 'open-topic', 'a', 't3', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(3)
    })
    const titles = () => wrapper.findAll('[data-test="tab"]').map((t) => t.find('[data-test="tab-title"]').text())
    expect(titles()).toEqual(['t1', 't2', 't3'])
    await wrapper.findAll('[data-test="tab"]')[0].trigger('dragstart')
    await wrapper.findAll('[data-test="tab"]')[2].trigger('dragover')
    await wrapper.findAll('[data-test="tab"]')[2].trigger('drop')
    await nextTick()
    expect(titles()).toEqual(['t2', 't1', 't3'])
  })

  it('marks the dragged tab as dragging and clears it on dragend', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    emitTree(wrapper, 'open-topic', 'a', 't2', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(2)
    })
    const tab = wrapper.findAll('[data-test="tab"]')[0]
    await tab.trigger('dragstart')
    expect(tab.classes()).toContain('dragging')
    await tab.trigger('dragend')
    await nextTick()
    expect(tab.classes()).not.toContain('dragging')
  })

  // --- Global shortcuts (4.3) ------------------------------------------------

  it('refreshes the active topic on cmd+r and prevents the native refresh', async () => {
    const { wrapper, api } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    })
    const ev = new KeyboardEvent('keydown', { key: 'r', metaKey: true })
    const prevented = vi.spyOn(ev, 'preventDefault')
    window.dispatchEvent(ev)
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(2)
    })
    expect(prevented).toHaveBeenCalled()
  })

  it('refreshes via ctrl+r as the non-mac fallback', async () => {
    const { wrapper, api } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', ctrlKey: true }))
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(2)
    })
  })

  it('ignores cmd+r while the focus sits in an editable field', async () => {
    const { wrapper, api } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    })
    const input = document.createElement('input')
    document.body.appendChild(input)
    const ev = new KeyboardEvent('keydown', { key: 'r', metaKey: true, bubbles: true })
    const prevented = vi.spyOn(ev, 'preventDefault')
    input.dispatchEvent(ev)
    input.remove()
    await nextTick()
    expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    expect(prevented).not.toHaveBeenCalled()
  })

  it('closes the active tab on cmd+d and prevents the native bookmark', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    const ev = new KeyboardEvent('keydown', { key: 'd', metaKey: true })
    const prevented = vi.spyOn(ev, 'preventDefault')
    window.dispatchEvent(ev)
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    })
    expect(prevented).toHaveBeenCalled()
  })

  it('ignores cmd+d while the focus sits in an editable field', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    const input = document.createElement('textarea')
    document.body.appendChild(input)
    const ev = new KeyboardEvent('keydown', { key: 'd', metaKey: true, bubbles: true })
    input.dispatchEvent(ev)
    input.remove()
    await nextTick()
    expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
  })

  it('toggles the command palette with a single cmd+k press', async () => {
    const { wrapper } = mountLayout([conn('a')])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).toBeNull()
    wrapper.unmount()
  })

  it('opens the command palette with ctrl+k as the non-mac fallback', async () => {
    const { wrapper } = mountLayout([conn('a')])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).not.toBeNull()
    wrapper.unmount()
  })

  it('does not trigger cmd+r or cmd+d during an IME composition', async () => {
    const { wrapper, api } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    })
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'r', metaKey: true, isComposing: true }))
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'd', metaKey: true, keyCode: 229 }))
    await nextTick()
    expect(api.consumeMessages).toHaveBeenCalledTimes(1)
    expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
  })

  it('does not toggle the command palette on cmd+k during an IME composition', async () => {
    const { wrapper } = mountLayout([conn('a')])
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, isComposing: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, keyCode: 229 }))
    await nextTick()
    expect(document.body.querySelector('[data-test="command-palette"]')).toBeNull()
    wrapper.unmount()
  })

  it('closes the tab context menu on Escape even during an IME composition', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 't1', [])
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="tab"]')).toHaveLength(1)
    })
    await wrapper.find('[data-test="tab"]').trigger('contextmenu', { clientX: 10, clientY: 10 })
    expect(document.body.querySelector('[data-test="tab-context-menu"]')).not.toBeNull()
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true }))
    await nextTick()
    expect(document.body.querySelector('[data-test="tab-context-menu"]')).toBeNull()
  })

  it('opens the update dialog and probes on button click', async () => {
    const { wrapper, api } = mountLayout()
    await wrapper.find('[data-test="btn-update"]').trigger('click')
    // UpdateDialog teleport 到 body,断言走 document。
    expect(document.body.querySelector('[data-test="update-dialog"]')).not.toBeNull()
    await vi.waitFor(() => {
      expect(api.checkUpdate).toHaveBeenCalledWith({ current_version: APP_VERSION })
    })
  })

  // --- 新建查询(SQL文件全局化) ---------------------------------------------

  it('keeps 新建查询 disabled without an active tab or on a redis tab', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const btn = wrapper.find('[data-test="btn-new-query"]')
    expect(btn.exists()).toBe(true)
    expect(btn.attributes('disabled')).toBeDefined()
    expect(btn.attributes('title')).toBe('请先打开 Kafka/ClickHouse 连接的标签页')
    // redis-keys tab 同样不能新建 Kafka/CH 查询。
    const tabs = useTabsStore()
    tabs.openRedisKeys('a', 0)
    await nextTick()
    expect(wrapper.find('[data-test="btn-new-query"]').attributes('disabled')).toBeDefined()
  })

  it('opens a sql console tab carrying the topic from 新建查询 on an active topic tab', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="message-browser"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="btn-new-query"]').trigger('click')
    const tabs = useTabsStore()
    const sqlTab = tabs.openTabs.find((t) => t.kind === 'sql')
    expect(sqlTab).toBeTruthy()
    expect(sqlTab?.topic).toBe('orders')
    expect(sqlTab?.title).toBe('SQL · orders')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="sql-console"]').exists()).toBe(true)
    })
  })

  it('opens a ch sql console tab from 新建查询 on an active ch-table tab', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-ch-table', 'a', 'db1', 'metrics')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="ch-table-browser"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="btn-new-query"]').trigger('click')
    const tabs = useTabsStore()
    expect(tabs.openTabs.some((t) => t.kind === 'ch-sql' && t.title === 'SQL 控制台')).toBe(true)
  })

  it('titles a topic-less sql tab as SQL 查询', async () => {
    const { wrapper } = mountLayout([conn('a')])
    const tabs = useTabsStore()
    tabs.openSql('a', '')
    await nextTick()
    expect(wrapper.find('[data-test="tab-title"]').text()).toBe('SQL 查询')
  })

  // --- SQL文件右栏 ------------------------------------------------------------

  it('toggles the sql files sidebar from the top bar and persists the state', async () => {
    const { wrapper } = mountLayout([conn('a')])
    expect(wrapper.find('[data-test="files-sidebar"]').exists()).toBe(false)
    await wrapper.find('[data-test="btn-sql-files"]').trigger('click')
    expect(wrapper.find('[data-test="files-sidebar"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="files-panel"]').exists()).toBe(true)
    expect(localStorage.getItem('dbclient-files-open')).toBe('1')
    await wrapper.find('[data-test="btn-sql-files"]').trigger('click')
    expect(wrapper.find('[data-test="files-sidebar"]').exists()).toBe(false)
    expect(localStorage.getItem('dbclient-files-open')).toBe('0')
    localStorage.removeItem('dbclient-files-open')
  })

  it('restores the open sql files sidebar and its width across remounts', async () => {
    localStorage.setItem('dbclient-files-open', '1')
    localStorage.setItem('dbclient-files-width', '400')
    const first = mountLayout([conn('a')])
    expect(first.wrapper.find('[data-test="files-sidebar"]').exists()).toBe(true)
    expect(first.wrapper.find('[data-test="files-sidebar"]').attributes('style')).toContain('400px')
    first.wrapper.unmount()
    const second = mountLayout([conn('a')])
    expect(second.wrapper.find('[data-test="files-sidebar"]').exists()).toBe(true)
    localStorage.removeItem('dbclient-files-open')
    localStorage.removeItem('dbclient-files-width')
  })

  it('resizes the sql files sidebar by dragging left and persists the width', async () => {
    const { wrapper } = mountLayout([conn('a')])
    await wrapper.find('[data-test="btn-sql-files"]').trigger('click')
    const resizer = wrapper.find('[data-test="files-resizer"]')
    await resizer.trigger('mousedown', { clientX: 500 })
    window.dispatchEvent(new MouseEvent('mousemove', { clientX: 400 }))
    window.dispatchEvent(new MouseEvent('mouseup'))
    await nextTick()
    expect(wrapper.find('[data-test="files-sidebar"]').attributes('style')).toContain('360px')
    expect(localStorage.getItem('dbclient-files-width')).toBe('360')
    localStorage.removeItem('dbclient-files-width')
    localStorage.removeItem('dbclient-files-open')
  })

  it('renders the toast overlay while the toast store holds a message', async () => {
    const { wrapper } = mountLayout([conn('a')])
    expect(wrapper.find('[data-test="toast"]').exists()).toBe(false)
    const toast = useToastStore()
    toast.show('已保存到 SQL文件:a.sql')
    await nextTick()
    expect(wrapper.find('[data-test="toast"]').text()).toBe('已保存到 SQL文件:a.sql')
  })

  // --- 点击文件条目按归属自动打开 SQL 控制台 ----------------------------------

  // 打开过 CodeMirror 控制台的用例必须在结尾卸载并排空回调,否则旧编辑器的
  // 挂起 measure 会干扰下一个用例的渲染(条目渲染不出来)。
  async function drainPendingEdits(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 20))
  }

  async function openPanelAndClickFile(wrapper: ReturnType<typeof mount>, index: number): Promise<void> {
    await wrapper.find('[data-test="btn-sql-files"]').trigger('click')
    await flushPromises()
    await wrapper.find(`[data-test="files-item-${index}"]`).trigger('click')
    await flushPromises()
    await nextTick()
  }

  it('点击 Kafka 归属文件自动打开 SQL 控制台并载入内容', async () => {
    const { wrapper } = mountLayout([conn('k1')])
    fileAppMocks.ListQueryFiles.mockResolvedValue([queryFileRow('a.sql', 'k1')])
    fileAppMocks.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'k1' })

    await openPanelAndClickFile(wrapper, 0)

    const tabs = useTabsStore()
    expect(tabs.openTabs.map((t) => t.kind)).toEqual(['sql'])
    expect(tabs.openTabs[0].connectionId).toBe('k1')
    expect(fileAppMocks.ReadQueryFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'a.sql' }))
    expect(wrapper.find('[data-test="sql-console"]').exists()).toBe(true)
    wrapper.unmount()
    await drainPendingEdits()
  })

  it('点击 ClickHouse 归属文件自动打开 CK SQL 控制台并载入内容', async () => {
    const { wrapper } = mountLayout([chConn('c1')])
    fileAppMocks.ListQueryFiles.mockResolvedValue([queryFileRow('ch.sql', 'c1')])
    fileAppMocks.ReadQueryFile.mockResolvedValue({ content: 'SELECT 1', connection_id: 'c1' })

    await openPanelAndClickFile(wrapper, 0)

    const tabs = useTabsStore()
    expect(tabs.openTabs.map((t) => t.kind)).toEqual(['ch-sql'])
    expect(tabs.openTabs[0].connectionId).toBe('c1')
    // CHSqlConsole 携带 tab id,控制台据此把 tab 标题改为当前文件名。
    expect(wrapper.findComponent(CHSqlConsole).props('tabId')).toBe(tabs.openTabs[0].id)
    expect(fileAppMocks.ReadQueryFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'ch.sql' }))
    expect(wrapper.find('[data-test="ch-sql-console"]').exists()).toBe(true)
    wrapper.unmount()
    await drainPendingEdits()
  })

  it('归属连接不存在 → toast 提示且不开控制台', async () => {
    const { wrapper } = mountLayout([conn('k1')])
    fileAppMocks.ListQueryFiles.mockResolvedValue([queryFileRow('lost.sql', 'ghost')])

    await openPanelAndClickFile(wrapper, 0)

    const tabs = useTabsStore()
    expect(tabs.openTabs).toHaveLength(0)
    expect(wrapper.find('[data-test="toast"]').text()).toContain('未找到文件关联的数据源')
  })

  it('Redis 归属文件 → toast 提示暂不支持且不开控制台', async () => {
    const { wrapper } = mountLayout([redisConn('r1')])
    fileAppMocks.ListQueryFiles.mockResolvedValue([queryFileRow('r.sql', 'r1')])

    await openPanelAndClickFile(wrapper, 0)

    const tabs = useTabsStore()
    expect(tabs.openTabs).toHaveLength(0)
    expect(wrapper.find('[data-test="toast"]').text()).toContain('暂不支持')
  })

  it('归属连接与当前激活 SQL 控制台一致 → 直接载入,不重复开台', async () => {
    const { wrapper } = mountLayout([chConn('c1')])
    useTabsStore().openCHSql('c1')
    await nextTick()
    fileAppMocks.ListQueryFiles.mockResolvedValue([queryFileRow('ch.sql', 'c1')])
    fileAppMocks.ReadQueryFile.mockResolvedValue({ content: 'SELECT 42', connection_id: 'c1' })

    await openPanelAndClickFile(wrapper, 0)

    const tabs = useTabsStore()
    expect(tabs.openTabs).toHaveLength(1)
    expect(fileAppMocks.ReadQueryFile).toHaveBeenCalledWith(expect.objectContaining({ name: 'ch.sql' }))
    wrapper.unmount()
    await drainPendingEdits()
  })
})
