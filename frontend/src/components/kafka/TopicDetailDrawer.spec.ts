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
    describeCluster: vi.fn(
      async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 }) as never,
    ),
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

  it('enters edit mode via cfg-edit turning rows into editable inputs', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="cfg-edit"]').trigger('click')

    const inputs = wrapper.findAll('[data-test="cfg-input"]')
    expect(inputs).toHaveLength(2)
    expect((inputs[0].element as HTMLInputElement).value).toBe('delete')
    expect((inputs[1].element as HTMLInputElement).value).toBe('604800000')
    // In edit mode the edit button is hidden; only save/cancel are visible.
    expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="cfg-save"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="cfg-cancel"]').exists()).toBe(true)
  })

  it('saves edited configs via alterTopicConfig then reloads', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = (api.alterTopicConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="cfg-edit"]').trigger('click')
    await wrapper.findAll('[data-test="cfg-input"]')[1].setValue('604800001')
    await wrapper.find('[data-test="cfg-save"]').trigger('click')

    await vi.waitFor(() => {
      expect(alter).toHaveBeenCalledWith({
        connection_id: 'a',
        topic: 'user-log',
        entries: [
          { key: 'cleanup.policy', value: 'delete' },
          { key: 'retention.ms', value: '604800001' },
        ],
      })
    })
    // Success re-runs load(): describeTopic must be called again.
    await vi.waitFor(() => {
      expect(api.describeTopic).toHaveBeenCalledTimes(2)
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(true)
    })
  })

  it('keeps the edit input and shows an error banner on save failure', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = (api.alterTopicConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="cfg-edit"]').trigger('click')
    await wrapper.findAll('[data-test="cfg-input"]')[1].setValue('604800001')
    await wrapper.find('[data-test="cfg-save"]').trigger('click')

    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="cfg-error"]').text()).toContain('boom')
    })
    // The drawer must not reload on failure and the input keeps its value.
    expect(api.describeTopic).toHaveBeenCalledTimes(1)
    expect((wrapper.findAll('[data-test="cfg-input"]')[1].element as HTMLInputElement).value).toBe('604800001')
    expect(wrapper.find('[data-test="cfg-save"]').exists()).toBe(true)
  })

  it('disables save and cancel while the save is in flight', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = vi.fn((): Promise<void> => new Promise(() => {}))
    setApi({ ...fakeApi({ alterTopicConfig: alter, describeTopic: (api.describeTopic as ReturnType<typeof vi.fn>) }) })

    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="cfg-edit"]').trigger('click')
    await wrapper.find('[data-test="cfg-save"]').trigger('click')

    await vi.waitFor(() => {
      expect((wrapper.find('[data-test="cfg-save"]').element as HTMLButtonElement).disabled).toBe(true)
    })
    expect((wrapper.find('[data-test="cfg-cancel"]').element as HTMLButtonElement).disabled).toBe(true)
  })

  it('cancels the edit without calling alterTopicConfig', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = (api.alterTopicConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="cfg-edit"]').trigger('click')
    await wrapper.findAll('[data-test="cfg-input"]')[1].setValue('604800001')
    await wrapper.find('[data-test="cfg-cancel"]').trigger('click')

    expect(alter).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="cfg-edit"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="cfg-save"]').exists()).toBe(false)
  })
})
