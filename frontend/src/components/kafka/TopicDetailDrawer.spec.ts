import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { TopicDetail } from '@/api/types'
import TopicDetailDrawer from './TopicDetailDrawer.vue'

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
    ...overrides,
  }
}

const detail = (): TopicDetail => ({
  name: 'user-log',
  partitions: [
    { id: 0, leader: 1, replicas: [1, 2], isr: [1, 2] },
    { id: 1, leader: 2, replicas: [2, 3], isr: [2] },
  ],
  configs: [
    { key: 'cleanup.policy', value: 'delete' },
    { key: 'retention.ms', value: '604800000' },
  ],
})

describe('TopicDetailDrawer', () => {
  let api: Api
  beforeEach(() => {
    api = fakeApi()
    setApi(api)
  })

  it('fetches the topic detail when shown', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="topo-row"]').exists()).toBe(true)
    })
    expect(api.describeTopic).toHaveBeenCalledWith('a', 'user-log')
  })

  it('renders one leader/replica/isr row per partition', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topo-row"]')).toHaveLength(2)
    })
    expect(
      wrapper.findAll('[data-test="topo-row"]').map((r) => [
        r.find('[data-test="row-partition"]').text(),
        r.find('[data-test="row-leader"]').text(),
        r.find('[data-test="row-replicas"]').text(),
        r.find('[data-test="row-isr"]').text(),
      ]),
    ).toEqual([
      ['0', '1', '1, 2', '1, 2'],
      ['1', '2', '2, 3', '2'],
    ])
  })

  it('renders the whitelisted config entries', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="cfg-row"]')).toHaveLength(2)
    })
    expect(
      wrapper.findAll('[data-test="cfg-row"]').map((r) => [
        r.find('[data-test="cfg-key"]').text(),
        r.find('[data-test="cfg-value"]').text(),
      ]),
    ).toEqual([
      ['cleanup.policy', 'delete'],
      ['retention.ms', '604800000'],
    ])
  })

  it('shows a loading state before the fetch settles', () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    expect(wrapper.find('[data-test="detail-loading"]').exists()).toBe(true)
  })

  it('surfaces api errors instead of failing silently', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="detail-error"]').text()).toContain('boom')
    })
  })

  it('does not fetch while hidden', () => {
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: false },
    })
    expect(api.describeTopic).not.toHaveBeenCalled()
  })

  it('refetches when the selected topic changes and clears stale data', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ...detail(), name: 'one' })
      .mockResolvedValueOnce({ ...detail(), name: 'two', partitions: [] })
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'one', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topo-row"]')).toHaveLength(2)
    })
    await wrapper.setProps({ connectionId: 'a', topic: 'two' })
    await vi.waitFor(() => {
      expect(api.describeTopic).toHaveBeenCalledWith('a', 'two')
    })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="topo-row"]')).toHaveLength(0)
    })
  })

  it('emits close from the close button without collapsing its own state', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="topo-row"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="drawer-close"]').trigger('click')
    expect(wrapper.emitted('close')).toHaveLength(1)
  })
})
