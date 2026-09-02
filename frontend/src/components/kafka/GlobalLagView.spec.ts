import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { ConsumerGroup, PartitionLag } from '@/api/types'
import GlobalLagView from './GlobalLagView.vue'

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => { resolve = res })
  return { promise, resolve }
}

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

const part = (lag: number): PartitionLag => ({
  partition: 0,
  current_offset: 0,
  log_end_offset: lag,
  lag,
})

const grp = (name: string, topics: ConsumerGroup['topics']): ConsumerGroup => ({
  name,
  state: 'Stable',
  topics,
})

describe('GlobalLagView', () => {
  let api: Api
  beforeEach(() => {
    api = fakeApi()
    setApi(api)
  })

  // loadDone waits for the mount-time fetch to settle so assertions run against
  // the steady state instead of the brief pre-loading render.
  async function loadDone(wrapper: ReturnType<typeof mount>): Promise<void> {
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="btn-refresh"]').attributes('disabled')).toBeUndefined()
    })
  }

  it('fetches consumer groups on mount and renders group × topic rows sorted by lag desc', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      grp('g-a', { orders: [part(150)], events: [part(2)] }),
      grp('g-b', { payments: [part(2000)] }),
    ])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(3)
    })
    expect(api.listConsumerGroups).toHaveBeenCalledWith('a')
    expect(
      wrapper.findAll('[data-test="lag-row"]').map((r) => [
        r.find('[data-test="row-group"]').text(),
        r.find('[data-test="row-topic"]').text(),
        r.find('[data-test="lag-value"]').text(),
      ]),
    ).toEqual([
      ['g-b', 'payments', '2000'],
      ['g-a', 'orders', '150'],
      ['g-a', 'events', '2'],
    ])
  })

  it('sums the partitions of one group × topic into a single row', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      grp('g-a', { orders: [part(100), part(20), part(1)], payments: [part(7)] }),
    ])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    expect(wrapper.find('[data-test="lag-value"]').text()).toBe('121')
  })

  it('filters rows with fuzzy search over group and topic', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      grp('g-a', { orders: [part(2000)] }),
      grp('g-b', { 'user-events': [part(500)] }),
    ])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    // Matches by topic name.
    await wrapper.find('[data-test="global-lag-search"]').setValue('ord')
    expect(rowsOf(wrapper)).toEqual([['g-a', 'orders']])
    // Matches by group name via dense subsequence ("gb" → "g-b").
    await wrapper.find('[data-test="global-lag-search"]').setValue('gb')
    expect(rowsOf(wrapper)).toEqual([['g-b', 'user-events']])
    expect(wrapper.findAll('[data-test="lag-row"]')[0].find('[data-test="lag-value"]').text()).toBe('500')
    // Clearing restores the full list.
    await wrapper.find('[data-test="global-lag-search"]').setValue('')
    expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
  })

  it('shows a no-match message when the search has no results', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      grp('g-a', { orders: [part(1)] }),
    ])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(1)
    })
    await wrapper.find('[data-test="global-lag-search"]').setValue('zzz')
    expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(0)
    expect(wrapper.find('[data-test="lag-empty"]').text()).toBe('无匹配 Group / Topic')
  })

  it('colors the total lag cell above thresholds (>1000 red, >100 orange)', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      grp('g-a', { huge: [part(2000)], medium: [part(150)], small: [part(42)] }),
    ])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(3)
    })
    const values = wrapper.findAll('[data-test="lag-value"]')
    expect(values[0].classes()).toContain('lag-danger')
    expect(values[1].classes()).toContain('lag-warn')
    expect(values[2].classes()).not.toContain('lag-danger')
    expect(values[2].classes()).not.toContain('lag-warn')
  })

  it('shows an empty state when there is no lag data', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await loadDone(wrapper)
    expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="lag-empty"]').text()).toBe('暂无 lag 数据')
  })

  it('hides the empty placeholder while an error is shown', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="lag-error"]').text()).toContain('boom')
    })
    expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(false)
  })

  it('shows the empty placeholder again once the error clears', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce([])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="lag-error"]').text()).toContain('boom')
    })
    expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(false)
    await wrapper.find('[data-test="btn-refresh"]').trigger('click')
    await loadDone(wrapper)
    expect(wrapper.find('[data-test="lag-error"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="lag-empty"]').text()).toBe('暂无 lag 数据')
  })

  it('surfaces api errors instead of failing silently', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="lag-error"]').text()).toContain('boom')
    })
  })

  it('refetches consumer groups from the 刷新 button', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await loadDone(wrapper)
    expect(api.listConsumerGroups).toHaveBeenCalledTimes(1)
    await wrapper.find('[data-test="btn-refresh"]').trigger('click')
    await vi.waitFor(() => {
      expect(api.listConsumerGroups).toHaveBeenCalledTimes(2)
    })
  })

  it('refetches when connectionId changes so a lag tab never shows another connection’s data', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([grp('g-a', { 'orders-a': [part(10)] })])
      .mockResolvedValueOnce([grp('g-b', { 'orders-b': [part(20)] })])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await loadDone(wrapper)
    expect(api.listConsumerGroups).toHaveBeenCalledWith('a')
    expect(rowsOf(wrapper)).toEqual([['g-a', 'orders-a']])
    // Layout patches the same component instance when switching lag tabs, so
    // the view must reload itself instead of keeping the previous data.
    await wrapper.setProps({ connectionId: 'b' })
    await vi.waitFor(() => {
      expect(api.listConsumerGroups).toHaveBeenCalledWith('b')
    })
    await loadDone(wrapper)
    expect(rowsOf(wrapper)).toEqual([['g-b', 'orders-b']])
    expect(wrapper.find('[data-test="lag-value"]').text()).toBe('20')
  })

  it('re-fetches when the unified refresh request increments', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    await loadDone(wrapper)
    expect(api.listConsumerGroups).toHaveBeenCalledTimes(1)
    await wrapper.setProps({ refreshRequest: 1 })
    await vi.waitFor(() => {
      expect(api.listConsumerGroups).toHaveBeenCalledTimes(2)
    })
  })

  it('discards a stale response that lands after a newer connection switch', async () => {
    const dA = deferred<ConsumerGroup[]>()
    const dB = deferred<ConsumerGroup[]>()
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(dA.promise)
      .mockReturnValueOnce(dB.promise)
    const wrapper = mount(GlobalLagView, { props: { connectionId: 'a' } })
    expect(api.listConsumerGroups).toHaveBeenCalledWith('a')
    // Switch connections before the first fetch settles.
    await wrapper.setProps({ connectionId: 'b' })
    expect(api.listConsumerGroups).toHaveBeenCalledWith('b')
    // The old connection's response resolves last: it must not overwrite the
    // view with data belonging to the previous connection.
    dA.resolve([grp('g-a', { 'orders-a': [part(10)] })])
    await flushPromises()
    expect(rowsOf(wrapper)).toEqual([])
    // The current connection's response lands and renders.
    dB.resolve([grp('g-b', { 'orders-b': [part(20)] })])
    await flushPromises()
    expect(rowsOf(wrapper)).toEqual([['g-b', 'orders-b']])
  })
})

function rowsOf(wrapper: ReturnType<typeof mount>): Array<[string, string]> {
  return wrapper.findAll('[data-test="lag-row"]').map((r) => [
    r.find('[data-test="row-group"]').text(),
    r.find('[data-test="row-topic"]').text(),
  ])
}
