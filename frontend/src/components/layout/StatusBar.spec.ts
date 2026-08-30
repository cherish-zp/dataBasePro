import { beforeEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import type { Connection } from '@/api/types'
import { useConnectionsStore } from '@/store/connections'
import StatusBar from './StatusBar.vue'

const conn = (id: string): Connection => ({
  id, name: `conn-${id}`, type: 'kafka',
  config: { bootstrap_servers: ['h:1'] }, created_at: 1, updated_at: 1,
})

describe('StatusBar', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
  })

  it('renders zero counts and no error segment for an empty store', () => {
    const wrapper = mount(StatusBar)
    expect(wrapper.find('[data-test="status-bar"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="status-count"]').text()).toBe('连接 0 · 在线 0')
    expect(wrapper.find('[data-test="status-error"]').exists()).toBe(false)
  })

  it('counts every connection but only connected ones as online', () => {
    const store = useConnectionsStore()
    store.connections.push(conn('a'), conn('b'), conn('c'), conn('d'))
    store.setStatus('a', 'connected')
    store.setStatus('b', 'error')
    store.setStatus('c', 'unknown')
    store.setStatus('d', 'disconnected')
    const wrapper = mount(StatusBar)
    expect(wrapper.find('[data-test="status-count"]').text()).toBe('连接 4 · 在线 1')
    expect(wrapper.find('[data-test="status-error"]').exists()).toBe(false)
  })

  it('shows the latest error only while the store error is set', async () => {
    const store = useConnectionsStore()
    const wrapper = mount(StatusBar)
    store.error = 'boom'
    await nextTick()
    expect(wrapper.find('[data-test="status-error"]').text()).toBe('最近错误：boom')
    store.error = null
    await nextTick()
    expect(wrapper.find('[data-test="status-error"]').exists()).toBe(false)
  })

  it('live-updates counts and online when the store changes after mount', async () => {
    const store = useConnectionsStore()
    store.connections.push(conn('a'))
    const wrapper = mount(StatusBar)
    expect(wrapper.find('[data-test="status-count"]').text()).toBe('连接 1 · 在线 0')
    store.setStatus('a', 'connected')
    store.connections.push(conn('b'))
    store.setStatus('b', 'connecting')
    await nextTick()
    expect(wrapper.find('[data-test="status-count"]').text()).toBe('连接 2 · 在线 1')
    expect(wrapper.find('[data-test="status-error"]').exists()).toBe(false)
  })
})
