import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import Layout from './Layout.vue'
import ConnectionTree from '@/components/common/ConnectionTree.vue'
import MessageBrowser from '@/components/kafka/MessageBrowser.vue'
import { useConnectionsStore } from '@/store/connections'
import { useTabsStore } from '@/store/tabs'

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
    saveTextFile: vi.fn(async () => ''),
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

  it('opens the sql console as a full tab from the message browser toolbar', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="message-browser"]').exists()).toBe(true)
    })
    await wrapper.findComponent(MessageBrowser).vm.$emit('open-sql')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="sql-console"]').exists()).toBe(true)
    })
    const tabs = wrapper.findAll('[data-test="tab"]')
    expect(tabs.some((t) => t.text().includes('SQL'))).toBe(true)
  })

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
})
