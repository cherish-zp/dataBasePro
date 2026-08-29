import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection, ConsumerGroup, Topic } from '@/api/types'
import { useConnectionsStore } from '@/store/connections'
import { useTabsStore } from '@/store/tabs'
import CommandPalette from './CommandPalette.vue'

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
    listConsumerGroups: vi.fn(async () => []),
    describeGroup: vi.fn(async () => ({ group: '', state: '', protocol_type: '', members: [] })),
    consumeMessages: vi.fn(async () => []),
    consumeMessagesByTimestamp: vi.fn(async () => []),
    getPartitionLag: vi.fn(async () => ({})),
    listActiveProducers: vi.fn(async () => []),
    listActiveConsumers: vi.fn(async () => []),
    resetConsumerGroupOffset: vi.fn(async () => {}),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

const conn = (id: string, name = `conn-${id}`, type: Connection['type'] = 'kafka'): Connection => ({
  id, name, type,
  config: { bootstrap_servers: ['h:1'] }, created_at: 1, updated_at: 1,
})

const topic = (name: string): Topic => ({
  name,
  partitions: [{ id: 0, leader: 0, replicas: [0], isr: [0] }],
})

const group = (name: string): ConsumerGroup => ({ name, state: 'Stable', topics: {} })

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

// The palette teleports to <body>, so assertions and events target document.body.
function q<T extends HTMLElement = HTMLElement>(testId: string): T | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}
function qa(testId: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(`[data-test="${testId}"]`))
}
function click(testId: string): void {
  q(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function pressKey(key: string, mods: { metaKey?: boolean; ctrlKey?: boolean } = {}): void {
  window.dispatchEvent(
    new KeyboardEvent('keydown', { key, metaKey: mods.metaKey ?? false, ctrlKey: mods.ctrlKey ?? false, bubbles: true }),
  )
}

async function typeQuery(text: string): Promise<void> {
  const input = q<HTMLInputElement>('palette-input')
  if (!input) throw new Error('palette input not rendered')
  input.value = text
  input.dispatchEvent(new Event('input', { bubbles: true }))
  await nextTick()
}

async function pressInputKey(key: string, init: KeyboardEventInit = {}): Promise<void> {
  q('palette-input')?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...init }))
  await nextTick()
}

const ITEMS = {
  topics: { a: [topic('orders'), topic('eu_orders')], b: [topic('ods_user')] },
  groups: { a: [group('grp_orders')], b: [group('grp_audit')] },
}

function mountPalette(connections: Connection[] = [conn('a'), conn('b')], overrides: Partial<Api> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi({
    listTopics: vi.fn((id: string) => Promise.resolve(ITEMS.topics[id as keyof typeof ITEMS.topics] ?? [])),
    listConsumerGroups: vi.fn((id: string) => Promise.resolve(ITEMS.groups[id as keyof typeof ITEMS.groups] ?? [])),
    ...overrides,
  })
  setApi(api)
  useConnectionsStore().connections = connections
  const tabs = useTabsStore()
  const wrapper = mount(CommandPalette)
  return { wrapper, api, tabs }
}

async function openLoaded(connections: Connection[] = [conn('a'), conn('b')], overrides: Partial<Api> = {}) {
  const ctx = mountPalette(connections, overrides)
  pressKey('k', { metaKey: true })
  await nextTick()
  await flushPromises()
  return ctx
}

describe('CommandPalette', () => {
  beforeEach(() => {
    document.body.innerHTML = ''
  })

  it('is hidden until cmd+k is pressed and toggles closed on a second cmd+k', async () => {
    mountPalette()
    expect(q('command-palette')).toBeNull()
    pressKey('k', { metaKey: true })
    await nextTick()
    expect(q('command-palette')).not.toBeNull()
    pressKey('k', { metaKey: true })
    await nextTick()
    expect(q('command-palette')).toBeNull()
  })

  it('opens with ctrl+k on non-mac platforms', async () => {
    mountPalette()
    pressKey('k', { ctrlKey: true })
    await nextTick()
    expect(q('command-palette')).not.toBeNull()
  })

  it('does not toggle on a plain k without the modifier', async () => {
    mountPalette()
    pressKey('k')
    await nextTick()
    expect(q('command-palette')).toBeNull()
  })

  it('teleports the palette to body', async () => {
    const { wrapper } = mountPalette()
    pressKey('k', { metaKey: true })
    await nextTick()
    expect(wrapper.find('[data-test="command-palette"]').exists()).toBe(false)
    expect(q('command-palette')).not.toBeNull()
  })

  it('shows the hint line and no rows while the query is empty', async () => {
    await openLoaded()
    expect(q('palette-empty')?.textContent).toContain('输入以搜索')
    expect(qa('palette-item')).toHaveLength(0)
  })

  it('fetches topics and groups of every kafka connection on first open', async () => {
    const { api } = await openLoaded()
    expect(api.listTopics).toHaveBeenCalledWith('a')
    expect(api.listTopics).toHaveBeenCalledWith('b')
    expect(api.listConsumerGroups).toHaveBeenCalledWith('a')
    expect(api.listConsumerGroups).toHaveBeenCalledWith('b')
  })

  it('never fetches entries for non-kafka connections', async () => {
    const { api } = await openLoaded([conn('a'), conn('m', 'conn-m', 'mysql')])
    expect(api.listTopics).not.toHaveBeenCalledWith('m')
    expect(api.listConsumerGroups).not.toHaveBeenCalledWith('m')
  })

  it('shows a per-connection loading note until its entries arrive', async () => {
    const pending = deferred<Topic[]>()
    const { wrapper } = mountPalette([conn('a'), conn('b')], {
      listTopics: vi.fn((id: string) => (id === 'b' ? pending.promise : Promise.resolve([topic('a_topic')]))),
      listConsumerGroups: vi.fn(async () => []),
    })
    pressKey('k', { metaKey: true })
    await nextTick()
    expect(qa('palette-loading').map((el) => el.textContent).some((t) => t?.includes('conn-b'))).toBe(true)

    pending.resolve([topic('b_topic')])
    await flushPromises()
    expect(q('palette-loading')).toBeNull()
    await typeQuery('b_topic')
    expect(qa('palette-item')).toHaveLength(1)
    wrapper.unmount()
  })

  it('merges topics and groups across connections, sorted by fuzzy score', async () => {
    await openLoaded()
    await typeQuery('orders')
    const items = qa('palette-item')
    expect(items.map((el) => el.querySelector('.item-name')?.textContent)).toEqual(['orders', 'eu_orders', 'grp_orders'])
    expect(items[0].textContent).toContain('Topic')
    expect(items[2].textContent).toContain('Group')
    expect(items[0].textContent).toContain('conn-a')
  })

  it('opens a topic tab when a result is clicked and closes the palette', async () => {
    const { tabs } = await openLoaded()
    await typeQuery('eu_orders')
    qa('palette-item')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(tabs.openTabs).toHaveLength(1)
    expect(tabs.openTabs[0]).toMatchObject({ kind: 'topic', connectionId: 'a', topic: 'eu_orders' })
    expect(tabs.activeTabId).toBe(tabs.openTabs[0].id)
    expect(q('command-palette')).toBeNull()
  })

  it('opens a group tab when a group result is clicked', async () => {
    const { tabs } = await openLoaded()
    await typeQuery('grp_audit')
    qa('palette-item')[0].dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(tabs.openTabs[0]).toMatchObject({ kind: 'group', connectionId: 'b', group: 'grp_audit' })
  })

  it('moves the highlight with arrow keys and wraps around', async () => {
    await openLoaded()
    await typeQuery('orders')
    const items = () => qa('palette-item')
    expect(items()[0].classList.contains('active')).toBe(true)

    await pressInputKey('ArrowDown')
    expect(items()[0].classList.contains('active')).toBe(false)
    expect(items()[1].classList.contains('active')).toBe(true)

    await pressInputKey('ArrowDown')
    await pressInputKey('ArrowDown')
    expect(items()[0].classList.contains('active')).toBe(true)

    await pressInputKey('ArrowUp')
    expect(items()[2].classList.contains('active')).toBe(true)
  })

  it('moves the highlight to the hovered item', async () => {
    await openLoaded()
    await typeQuery('orders')
    qa('palette-item')[2].dispatchEvent(new MouseEvent('mousemove', { bubbles: true }))
    await nextTick()
    expect(qa('palette-item')[2].classList.contains('active')).toBe(true)
  })

  it('opens the highlighted item on enter', async () => {
    const { tabs } = await openLoaded()
    await typeQuery('orders')
    await pressInputKey('ArrowDown')
    await pressInputKey('Enter')
    expect(tabs.openTabs[0]).toMatchObject({ kind: 'topic', connectionId: 'a', topic: 'eu_orders' })
    expect(q('command-palette')).toBeNull()
  })

  it('ignores enter pressed during IME composition', async () => {
    const { tabs } = await openLoaded()
    await typeQuery('orders')
    // dispatchEvent returns false once the default is prevented; composing
    // Enter must be left to the IME (no preventDefault, no action).
    const notPrevented = q<HTMLInputElement>('palette-input')?.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true, isComposing: true }),
    )
    await nextTick()
    expect(notPrevented).toBe(true)
    expect(tabs.openTabs).toHaveLength(0)
    expect(q('command-palette')).not.toBeNull()
  })

  it('ignores arrow keys pressed during IME composition', async () => {
    await openLoaded()
    await typeQuery('orders')
    await pressInputKey('ArrowDown', { isComposing: true })
    expect(qa('palette-item')[0].classList.contains('active')).toBe(true)
  })

  it('handles enter normally when isComposing is false', async () => {
    const { tabs } = await openLoaded()
    await typeQuery('orders')
    await pressInputKey('Enter', { isComposing: false })
    expect(tabs.openTabs).toHaveLength(1)
    expect(q('command-palette')).toBeNull()
  })

  it('closes on escape', async () => {
    await openLoaded()
    pressKey('Escape')
    await nextTick()
    expect(q('command-palette')).toBeNull()
  })

  it('closes on backdrop click but stays open on clicks inside the panel', async () => {
    await openLoaded()
    q('command-palette')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(q('command-palette')).toBeNull()

    pressKey('k', { metaKey: true })
    await nextTick()
    q('palette-panel')?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
    await nextTick()
    expect(q('command-palette')).not.toBeNull()
  })

  it('renders cached entries immediately on reopen and refreshes silently in the background', async () => {
    const refresh = deferred<Topic[]>()
    let calls = 0
    const { api } = mountPalette([conn('a'), conn('b')], {
      listTopics: vi.fn((id: string) => {
        if (id !== 'a') return Promise.resolve([])
        calls++
        return calls === 1 ? Promise.resolve([topic('orders')]) : refresh.promise
      }),
      listConsumerGroups: vi.fn(async () => []),
    })
    pressKey('k', { metaKey: true })
    await nextTick()
    await flushPromises()
    await typeQuery('orders')
    expect(qa('palette-item')).toHaveLength(1)

    pressKey('Escape')
    await nextTick()
    pressKey('k', { metaKey: true })
    await nextTick()

    // Cache hit: the stale list renders without waiting on any promise...
    await typeQuery('orders')
    expect(qa('palette-item')).toHaveLength(1)
    expect(q('palette-loading')).toBeNull()
    // ...while a background re-fetch was kicked off for both connections.
    expect(api.listTopics).toHaveBeenCalledTimes(4)

    refresh.resolve([topic('orders'), topic('orders_v2')])
    await flushPromises()
    expect(qa('palette-item')).toHaveLength(2)
  })

  it('shows a per-connection error note and keeps other connections usable', async () => {
    await openLoaded([conn('a'), conn('b')], {
      listTopics: vi.fn((id: string) => (id === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve([topic('ods_user')]))),
      listConsumerGroups: vi.fn((id: string) => (id === 'a' ? Promise.reject(new Error('boom')) : Promise.resolve([]))),
    })
    const err = q('palette-error')
    expect(err?.textContent).toContain('conn-a')
    expect(err?.textContent).toContain('boom')
    expect(q('palette-loading')).toBeNull()

    await typeQuery('ods_user')
    expect(qa('palette-item')).toHaveLength(1)
    expect(qa('palette-item')[0].textContent).toContain('conn-b')
  })

  it('caps rendered results at 50 with a remaining-count footer', async () => {
    const many = Array.from({ length: 60 }, (_, i) => topic(`t${String(i).padStart(2, '0')}`))
    await openLoaded([conn('a'), conn('b')], {
      listTopics: vi.fn((id: string) => Promise.resolve(id === 'a' ? many : [])),
      listConsumerGroups: vi.fn(async () => []),
    })
    await typeQuery('t')
    expect(qa('palette-item')).toHaveLength(50)
    expect(q('palette-more')?.textContent).toContain('还有 10 条')
  })
})
