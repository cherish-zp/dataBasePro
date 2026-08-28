import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { ClusterHealth } from '@/api/types'
import ClusterHealthPanel from './ClusterHealthPanel.vue'

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
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    describeCluster: vi.fn(
      async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 }) as never,
    ),
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

const health = (): ClusterHealth => ({
  cluster_id: 'kfake',
  controller_id: 1,
  kafka_version: 'v3.7',
  brokers: [
    { id: 0, host: 'b0.internal', port: 9092, rack: '', version: 'v3.7', online: true },
    { id: 1, host: 'b1.internal', port: 9093, rack: 'rack-a', version: 'v3.7', online: true },
    { id: 2, host: 'b2.internal', port: 9094, rack: '', version: '', online: false },
  ],
  under_replicated_partitions: 2,
})

describe('ClusterHealthPanel', () => {
  let api: Api
  beforeEach(() => {
    api = fakeApi()
    setApi(api)
  })

  it('fetches the cluster health on mount for its connection', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockResolvedValue(health())
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="broker-card"]').exists()).toBe(true)
    })
    expect(api.describeCluster).toHaveBeenCalledWith('a')
  })

  it('renders summary values (version, controller, broker count)', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockResolvedValue(health())
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="health-summary"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="summary-version"]').text()).toBe('v3.7')
    expect(wrapper.find('[data-test="summary-controller"]').text()).toContain('1')
    expect(wrapper.find('[data-test="summary-brokers"]').text()).toBe('3')
  })

  it('flags under-replicated partitions in red when above zero and resets when zero', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce({ ...health(), under_replicated_partitions: 0 })
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="urp-value"]').classes()).toContain('danger')
    })
    expect(wrapper.find('[data-test="urp-value"]').text()).toBe('2')

    await wrapper.setProps({ connectionId: 'b' })
    await vi.waitFor(() => {
      expect(api.describeCluster).toHaveBeenCalledWith('b')
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="urp-value"]').text()).toBe('0')
    })
    expect(wrapper.find('[data-test="urp-value"]').classes()).not.toContain('danger')
  })

  it('renders one card per broker with host, rack and version', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockResolvedValue(health())
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="broker-card"]')).toHaveLength(3)
    })
    const cards = wrapper.findAll('[data-test="broker-card"]')
    expect(cards[0].find('[data-test="broker-id"]').text()).toContain('0')
    expect(cards[0].find('[data-test="broker-host"]').text()).toBe('b0.internal:9092')
    // No rack -> no rack element; broker 1 has one.
    expect(cards[0].find('[data-test="broker-rack"]').exists()).toBe(false)
    expect(cards[1].find('[data-test="broker-rack"]').text()).toContain('rack-a')
    // Unknown version falls back to a friendly placeholder.
    expect(cards[2].find('[data-test="broker-version"]').text()).toContain('未知')
  })

  it('badges only the controller broker', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockResolvedValue(health())
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="controller-badge"]')).toHaveLength(1)
    })
    const cards = wrapper.findAll('[data-test="broker-card"]')
    expect(cards[0].find('[data-test="controller-badge"]').exists()).toBe(false)
    expect(cards[1].find('[data-test="controller-badge"]').exists()).toBe(true)
  })

  it('marks offline brokers with an offline status and a danger class', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockResolvedValue(health())
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="broker-card"]')).toHaveLength(3)
    })
    const cards = wrapper.findAll('[data-test="broker-card"]')
    expect(cards[0].find('[data-test="broker-state"]').attributes('data-status')).toBe('online')
    expect(cards[0].classes()).not.toContain('offline')
    expect(cards[2].find('[data-test="broker-state"]').attributes('data-status')).toBe('offline')
    expect(cards[2].classes()).toContain('offline')
    expect(cards[2].find('[data-test="broker-state"]').text()).toBe('离线')
  })

  it('shows a friendly empty state when no brokers are returned', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockResolvedValue({
      ...health(),
      brokers: [],
    })
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="health-empty"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="health-empty"]').text()).toContain('未获取到任何 Broker')
    expect(wrapper.find('[data-test="broker-card"]').exists()).toBe(false)
  })

  it('shows a loading state before the fetch settles', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    // The initial render commits before the mounted hook flips `loading`, so
    // flush one tick to observe the in-flight state.
    await wrapper.vm.$nextTick()
    expect(wrapper.find('[data-test="health-loading"]').exists()).toBe(true)
  })

  it('surfaces api errors instead of failing silently', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="health-error"]').text()).toContain('boom')
    })
  })

  it('refetches when the selected connection changes and clears stale data', async () => {
    ;(api.describeCluster as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(health())
      .mockResolvedValueOnce({ ...health(), brokers: [health().brokers[0]] })
    const wrapper = mount(ClusterHealthPanel, { props: { connectionId: 'a' } })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="broker-card"]')).toHaveLength(3)
    })
    await wrapper.setProps({ connectionId: 'b' })
    await vi.waitFor(() => {
      expect(api.describeCluster).toHaveBeenCalledWith('b')
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="broker-card"]')).toHaveLength(1)
    })
  })
})
