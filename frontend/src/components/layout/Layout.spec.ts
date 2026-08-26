import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import Layout from './Layout.vue'
import ConnectionTree from '@/components/common/ConnectionTree.vue'

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
    listConsumerGroups: vi.fn(async () => []),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    ...overrides,
  }
}

const conn = (id: string): Connection => ({
  id, name: `conn-${id}`, type: 'kafka',
  config: { bootstrap_servers: ['h:1'] }, created_at: 1, updated_at: 1,
})

function mountLayout(connections: Connection[] = []) {
  setActivePinia(createPinia())
  const api = fakeApi()
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

  it('disables producer/sql buttons without an active topic tab', () => {
    const { wrapper } = mountLayout([conn('a')])
    expect((wrapper.find('[data-test="btn-producer"]').element as HTMLButtonElement).disabled).toBe(true)
    expect((wrapper.find('[data-test="btn-sql"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('opens producer and sql panels when a topic tab is active', async () => {
    const { wrapper } = mountLayout([conn('a')])
    emitTree(wrapper, 'open-topic', 'a', 'orders', [0, 1])
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="message-browser"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="btn-producer"]').trigger('click')
    expect(wrapper.find('[data-test="producer-panel"]').exists()).toBe(true)
    await wrapper.find('[data-test="modal-close"]').trigger('click')
    await wrapper.find('[data-test="btn-sql"]').trigger('click')
    expect(wrapper.find('[data-test="sql-console"]').exists()).toBe(true)
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
})
