import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { TopicDetail } from '@/api/types'
import TopicDetailDrawer from './TopicDetailDrawer.vue'

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
    describeTopic: vi.fn(async () => ({ name: '', partitions: [], configs: [] })),
    describeCluster: vi.fn(
      async () => ({ cluster_id: '', controller_id: -1, kafka_version: '', brokers: [], under_replicated_partitions: 0 }) as never,
    ),
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

// The drawer teleports to <body> so a backdrop-filter ancestor cannot confine
// its fixed positioning; assertions and clicks therefore target document.body.
function findEl(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}

function findAllEls(testId: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(`[data-test="${testId}"]`))
}

function clickEl(testId: string): void {
  findEl(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

function setInput(el: HTMLElement, value: string): void {
  ;(el as HTMLInputElement).value = value
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

function textOf(testId: string): string {
  return findEl(testId)?.textContent ?? ''
}

describe('TopicDetailDrawer', () => {
  let api: Api
  beforeEach(() => {
    api = fakeApi()
    setApi(api)
  })

  it('teleports the drawer to body so the sidebar cannot confine its fixed positioning', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    const el = await vi.waitFor(() => {
      const el = document.body.querySelector(':scope > [data-test="topic-detail-drawer"]')
      expect(el).not.toBeNull()
      return el as Element
    })
    // Direct child of <body>: the sidebar's backdrop-filter would otherwise
    // become the containing block for position:fixed and pin the drawer to the
    // sidebar's right edge (left side of the window).
    expect(el.parentElement).toBe(document.body)
  })

  it('shows the retained/total message stats bar for its topic', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    ;(api.getTopicMessageCounts as ReturnType<typeof vi.fn>).mockResolvedValue({
      'user-log': { retained: 1200000, total: 4500000 },
    })
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      const stats = document.body.querySelector('[data-test="drawer-stats"]')
      expect(stats).not.toBeNull()
      expect(stats?.textContent).toContain('1.2M')
      expect(stats?.textContent).toContain('4.5M')
    })
    expect(api.getTopicMessageCounts).toHaveBeenCalledWith('a', ['user-log'])
  })

  it('fetches the topic detail when shown', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('topo-row')).not.toBeNull()
    })
    expect(api.describeTopic).toHaveBeenCalledWith('a', 'user-log')
  })

  it('renders one leader/replica/isr row per partition', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findAllEls('topo-row')).toHaveLength(2)
    })
    expect(
      findAllEls('topo-row').map((r) => [
        r.querySelector('[data-test="row-partition"]')?.textContent,
        r.querySelector('[data-test="row-leader"]')?.textContent,
        r.querySelector('[data-test="row-replicas"]')?.textContent,
        r.querySelector('[data-test="row-isr"]')?.textContent,
      ]),
    ).toEqual([
      ['0', '1', '1, 2', '1, 2'],
      ['1', '2', '2, 3', '2'],
    ])
  })

  it('renders the whitelisted config entries', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findAllEls('cfg-row')).toHaveLength(2)
    })
    expect(
      findAllEls('cfg-row').map((r) => [
        r.querySelector('[data-test="cfg-key"]')?.textContent,
        r.querySelector('[data-test="cfg-value"]')?.textContent,
      ]),
    ).toEqual([
      ['cleanup.policy', 'delete'],
      ['retention.ms', '604800000'],
    ])
  })

  it('shows a loading state before the fetch settles', () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockReturnValue(new Promise(() => {}))
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    expect(findEl('detail-loading')).not.toBeNull()
  })

  it('surfaces api errors instead of failing silently', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(textOf('detail-error')).toContain('boom')
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
      expect(findAllEls('topo-row')).toHaveLength(2)
    })
    await wrapper.setProps({ connectionId: 'a', topic: 'two' })
    await vi.waitFor(() => {
      expect(api.describeTopic).toHaveBeenCalledWith('a', 'two')
    })
    await vi.waitFor(() => {
      expect(findAllEls('topo-row')).toHaveLength(0)
    })
  })

  it('emits close from the close button without collapsing its own state', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('topo-row')).not.toBeNull()
    })
    clickEl('drawer-close')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('enters edit mode directly when the edit prop is set', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true, edit: true },
    })
    // The 编辑配置 context-menu entry opens the drawer straight into editing:
    // inputs pre-filled with the broker values, no manual 编辑 click needed.
    await vi.waitFor(() => {
      expect(findAllEls('cfg-input')).toHaveLength(2)
    })
    expect((findAllEls('cfg-input')[0] as HTMLInputElement).value).toBe('delete')
    expect(findEl('cfg-save')).not.toBeNull()
  })

  it('does not re-enter edit mode after a successful save even with the edit prop set', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = (api.alterTopicConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true, edit: true },
    })
    await vi.waitFor(() => {
      expect(findAllEls('cfg-input')).toHaveLength(2)
    })
    clickEl('cfg-save')
    await vi.waitFor(() => {
      expect(alter).toHaveBeenCalled()
    })
    await vi.waitFor(() => {
      expect(api.describeTopic).toHaveBeenCalledTimes(2)
    })
    // Back to read-only view after saving.
    await vi.waitFor(() => {
      expect(findEl('cfg-input')).toBeNull()
      expect(findEl('cfg-edit')).not.toBeNull()
    })
  })

  it('enters edit mode via cfg-edit turning rows into editable inputs', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('cfg-edit')).not.toBeNull()
    })
    clickEl('cfg-edit')
    await flushPromises()

    const inputs = findAllEls('cfg-input')
    expect(inputs).toHaveLength(2)
    expect((inputs[0] as HTMLInputElement).value).toBe('delete')
    expect((inputs[1] as HTMLInputElement).value).toBe('604800000')
    // In edit mode the edit button is hidden; only save/cancel are visible.
    expect(findEl('cfg-edit')).toBeNull()
    expect(findEl('cfg-save')).not.toBeNull()
    expect(findEl('cfg-cancel')).not.toBeNull()
  })

  it('saves edited configs via alterTopicConfig then reloads', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = (api.alterTopicConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('cfg-edit')).not.toBeNull()
    })
    clickEl('cfg-edit')
    await flushPromises()
    setInput(findAllEls('cfg-input')[1], '604800001')
    clickEl('cfg-save')

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
      expect(findEl('cfg-edit')).not.toBeNull()
    })
  })

  it('keeps the edit input and shows an error banner on save failure', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = (api.alterTopicConfig as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))

    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('cfg-edit')).not.toBeNull()
    })
    clickEl('cfg-edit')
    await flushPromises()
    setInput(findAllEls('cfg-input')[1], '604800001')
    clickEl('cfg-save')

    await vi.waitFor(() => {
      expect(textOf('cfg-error')).toContain('boom')
    })
    // The drawer must not reload on failure and the input keeps its value.
    expect(api.describeTopic).toHaveBeenCalledTimes(1)
    expect((findAllEls('cfg-input')[1] as HTMLInputElement).value).toBe('604800001')
    expect(findEl('cfg-save')).not.toBeNull()
  })

  it('disables save and cancel while the save is in flight', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = vi.fn((): Promise<void> => new Promise(() => {}))
    setApi({ ...fakeApi({ alterTopicConfig: alter, describeTopic: (api.describeTopic as ReturnType<typeof vi.fn>) }) })

    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('cfg-edit')).not.toBeNull()
    })
    clickEl('cfg-edit')
    await flushPromises()
    clickEl('cfg-save')

    await vi.waitFor(() => {
      expect((findEl('cfg-save') as HTMLButtonElement).disabled).toBe(true)
    })
    expect((findEl('cfg-cancel') as HTMLButtonElement).disabled).toBe(true)
  })

  it('cancels the edit without calling alterTopicConfig', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const alter = (api.alterTopicConfig as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)

    mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('cfg-edit')).not.toBeNull()
    })
    clickEl('cfg-edit')
    await flushPromises()
    setInput(findAllEls('cfg-input')[1], '604800001')
    clickEl('cfg-cancel')
    await flushPromises()

    expect(alter).not.toHaveBeenCalled()
    expect(findEl('cfg-edit')).not.toBeNull()
    expect(findEl('cfg-save')).toBeNull()
  })

  it('discards a stale describeTopic that lands after a topic switch', async () => {
    const dA = deferred<TopicDetail>()
    const dB = deferred<TopicDetail>()
    ;(api.describeTopic as ReturnType<typeof vi.fn>)
      .mockReturnValueOnce(dA.promise)
      .mockReturnValueOnce(dB.promise)
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'one', show: true },
    })
    expect(api.describeTopic).toHaveBeenCalledWith('a', 'one')
    // Switch the selected topic before the first fetch settles.
    await wrapper.setProps({ connectionId: 'a', topic: 'two' })
    expect(api.describeTopic).toHaveBeenCalledWith('a', 'two')
    // The old topic's response resolves last: it must not overwrite the drawer.
    dA.resolve({ ...detail(), name: 'one' })
    await flushPromises()
    expect(findEl('topo-row')).toBeNull()
    // The current topic's response lands and renders.
    dB.resolve({ ...detail(), name: 'two' })
    await flushPromises()
    expect(findAllEls('topo-row')).toHaveLength(2)
  })

  it('does not re-describe the topic when the drawer closes mid-save', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>).mockResolvedValue(detail())
    const dAlter = deferred<void>()
    ;(api.alterTopicConfig as ReturnType<typeof vi.fn>).mockReturnValue(dAlter.promise)
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('cfg-edit')).not.toBeNull()
    })
    clickEl('cfg-edit')
    await flushPromises()
    clickEl('cfg-save')
    await vi.waitFor(() => {
      expect(api.alterTopicConfig).toHaveBeenCalled()
    })
    // Close the drawer while the save is still in flight.
    await wrapper.setProps({ show: false })
    const callsBefore = (api.describeTopic as ReturnType<typeof vi.fn>).mock.calls.length
    dAlter.resolve()
    await flushPromises()
    // The trailing load() of the hidden drawer must be discarded: no extra
    // describeTopic fires for the old topic.
    expect((api.describeTopic as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore)
  })

  it('does not re-describe the old topic when the topic switches mid-save', async () => {
    ;(api.describeTopic as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(detail())
      .mockResolvedValueOnce(detail())
    const dAlter = deferred<void>()
    ;(api.alterTopicConfig as ReturnType<typeof vi.fn>).mockReturnValue(dAlter.promise)
    const wrapper = mount(TopicDetailDrawer, {
      props: { connectionId: 'a', topic: 'user-log', show: true },
    })
    await vi.waitFor(() => {
      expect(findEl('cfg-edit')).not.toBeNull()
    })
    clickEl('cfg-edit')
    await flushPromises()
    clickEl('cfg-save')
    await vi.waitFor(() => {
      expect(api.alterTopicConfig).toHaveBeenCalled()
    })
    // Switch the topic while the save is still in flight.
    await wrapper.setProps({ topic: 'other' })
    await vi.waitFor(() => {
      expect(api.describeTopic).toHaveBeenCalledWith('a', 'other')
    })
    const callsBefore = (api.describeTopic as ReturnType<typeof vi.fn>).mock.calls.length
    dAlter.resolve()
    await flushPromises()
    // The save's trailing load() is discarded: only the switch's own describe
    // (for the new topic) is allowed.
    expect((api.describeTopic as ReturnType<typeof vi.fn>).mock.calls.length).toBe(callsBefore)
  })
})
