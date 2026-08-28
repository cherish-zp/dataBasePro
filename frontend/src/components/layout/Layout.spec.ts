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
    listConsumerGroups: vi.fn(async () => []),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
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
  beforeEach(() => setActivePinia(createPinia()))

  it('shows the welcome view when no tab is open', () => {
    const { wrapper } = mountLayout([conn('a')])
    expect(wrapper.find('[data-test="home-view"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="connection-tree"]').exists()).toBe(true)
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
})
