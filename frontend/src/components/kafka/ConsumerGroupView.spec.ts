import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { ConsumerGroup, GroupDetail } from '@/api/types'
import ConsumerGroupView from './ConsumerGroupView.vue'

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
        checkUpdate: vi.fn(async () => ({ has_update: false, latest_version: 'v1.0.0' })),
        downloadUpdate: vi.fn(async () => {}),
        applyUpdate: vi.fn(async () => {}),
        updateProgress: vi.fn(async () => ({ phase: 'idle' as const, percent: 0 })),
        openURL: vi.fn(async () => {}),
    listSavedQueries: vi.fn(async () => []),
    saveSavedQuery: vi.fn(async (q: never) => ({}) as never),
    updateSavedQuery: vi.fn(async () => ({}) as never),
    deleteSavedQuery: vi.fn(async () => {}),
        testCHConnection: vi.fn(async () => {}),
        listCHDatabases: vi.fn(async () => []),
        listCHTables: vi.fn(async () => []),
        chPageRows: vi.fn(async () => ({ columns: [], rows: [], engine: '', total_rows: 0 })),
        chTruncateTable: vi.fn(async () => {}),
        chExecute: vi.fn(async () => []),
        listDrivers: vi.fn(async () => []),
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

function grp(): ConsumerGroup {
  return {
    name: 'grp-1',
    state: 'Stable',
    topics: {
      'orders': [
        { partition: 0, current_offset: 10, log_end_offset: 20, lag: 10 },
        { partition: 1, current_offset: 15, log_end_offset: 15, lag: 0 },
      ],
    },
  }
}

function mountView(overrides: Partial<Api> = {}, props: Record<string, unknown> = {}) {
  setActivePinia(createPinia())
  const api = fakeApi(overrides)
  setApi(api)
  const wrapper = mount(ConsumerGroupView, { props: { tabId: 'tab1', connectionId: 'c', ...props } })
  return { wrapper, api }
}

describe('ConsumerGroupView', () => {
  it('shows the group opened from the sidebar and its consumed topics', async () => {
    const gA: ConsumerGroup = { name: 'aaa', state: 'Stable', topics: { 'topicA': [] } }
    const gB: ConsumerGroup = {
      name: 'group_t_ds_cu_audit_log',
      state: 'Stable',
      topics: { 'audit-topic': [], 'sec-topic': [] },
    }
    const { wrapper } = mountView(
      { listConsumerGroups: vi.fn(async () => [gA, gB]) },
      { group: 'group_t_ds_cu_audit_log' },
    )
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="field-group"] [data-test="search-select-value"]').text()).toBe(
        'group_t_ds_cu_audit_log (Stable)',
      )
    })
    expect(wrapper.find('[data-test="field-topic"] [data-test="search-select-value"]').text()).toBe('audit-topic')
  })

  it('filters the consumer group dropdown by fuzzy search', async () => {
    const groups: ConsumerGroup[] = [
      { name: 'grp-1', state: 'Stable', topics: { 'orders': [] } },
      { name: 'group_forensics_document_wait', state: 'Empty', topics: {} },
      { name: 'console-consumer-123', state: 'Empty', topics: {} },
    ]
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => groups) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]').length).toBeGreaterThanOrEqual(0)
    })
    await wrapper.find('[data-test="field-group"] [data-test="search-select-trigger"]').trigger('click')
    await wrapper.find('[data-test="field-group"] [data-test="search-select-input"]').setValue('grp')
    const labels = wrapper.findAll('[data-test="field-group"] [data-test="search-select-option"]').map((n) => n.text())
    expect(labels).toEqual(['grp-1 (Stable)', 'group_forensics_document_wait (Empty)'])
  })

  it('filters the topic dropdown by fuzzy search', async () => {
    const g: ConsumerGroup = {
      name: 'grp-1',
      state: 'Stable',
      topics: { 'orders': [], 'order-events': [], 'users': [] },
    }
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [g]) })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="field-topic"] [data-test="search-select-value"]').text()).toBe('orders')
    })
    await wrapper.find('[data-test="field-topic"] [data-test="search-select-trigger"]').trigger('click')
    await wrapper.find('[data-test="field-topic"] [data-test="search-select-input"]').setValue('ord')
    const labels = wrapper.findAll('[data-test="field-topic"] [data-test="search-select-option"]').map((n) => n.text())
    expect(labels).toEqual(['orders', 'order-events'])
  })

  it('loads groups and renders the lag table for the first topic', async () => {
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    const lags = wrapper.findAll('[data-test="lag-value"]').map((n) => n.text())
    expect(lags).toEqual(['10', '0'])
    expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(false)
  })

  it('preselects the topic carried in from the Lag overview', async () => {
    // Lag 总览行点击跳转:Topic 作为初始选中项带入(组内第一个 topic 不再
    // 是默认)。events 是组内第二个 topic,传入后必须选中它。
    const g: ConsumerGroup = {
      name: 'grp-1',
      state: 'Stable',
      topics: {
        'orders': [{ partition: 0, current_offset: 10, log_end_offset: 20, lag: 10 }],
        'events': [{ partition: 1, current_offset: 15, log_end_offset: 18, lag: 3 }],
      },
    }
    const { wrapper } = mountView(
      { listConsumerGroups: vi.fn(async () => [g]) },
      { topic: 'events' },
    )
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(1)
    })
    expect(wrapper.find('[data-test="field-topic"]').text()).toContain('events')
  })

  it('explains empty member columns when the group is not Stable', async () => {
    // Empty/Dead 组:位移仍在但无活跃成员,Host/Consumer ID/Client ID 为空
    // 是 broker 的正常行为——页面必须说明这一点,否则用户会当成 bug。
    const g: ConsumerGroup = {
      name: 'grp-1',
      state: 'Empty',
      topics: { 'orders': [{ partition: 0, current_offset: 10, log_end_offset: 20, lag: 10 }] },
    }
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [g]) })
    await vi.waitFor(() => {
      const note = wrapper.find('[data-test="lag-member-note"]')
      expect(note.exists()).toBe(true)
      expect(note.text()).toContain('Empty')
      expect(note.text()).toContain('无活跃成员')
    })
  })

  it('hides the member note while the group is Stable', async () => {
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    expect(wrapper.find('[data-test="lag-member-note"]').exists()).toBe(false)
  })

  it('shows an empty state when there is no lag', async () => {
    const g: ConsumerGroup = { name: 'grp-1', state: 'Empty', topics: {} }
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [g]) })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="lag-empty"]').exists()).toBe(true)
    })
  })

  it('surfaces load errors', async () => {
    const { wrapper } = mountView({
      listConsumerGroups: vi.fn(async () => {
        throw new Error('cluster unavailable')
      }),
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="group-error"]').text()).toBe('cluster unavailable')
    })
  })

  it('previews then confirms an offset reset through the dry-run flow', async () => {
    const reset = vi.fn(async () => {})
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), resetConsumerGroupOffset: reset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="select-reset-mode"]').setValue('earliest')
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="btn-confirm-reset"]').trigger('click')
    await vi.waitFor(() => {
      expect(reset).toHaveBeenCalledWith({
        connection_id: 'c',
        group: 'grp-1',
        topic: 'orders',
        mode: 'earliest',
        timestamp_ms: undefined,
      })
    })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(false)
    })
  })

  it('previews the affected partitions with current and new offsets before resetting', async () => {
    const reset = vi.fn(async () => {})
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), resetConsumerGroupOffset: reset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="dry-run-row"]')).toHaveLength(2)
    })
    const rows = wrapper.findAll('[data-test="dry-run-row"]')
    expect(rows[0].text()).toContain('0')
    expect(rows[0].text()).toContain('10')
    expect(rows[0].find('[data-test="dry-run-new-offset"]').text()).toBe('20')
    expect(rows[1].find('[data-test="dry-run-new-offset"]').text()).toBe('15')
    expect(reset).not.toHaveBeenCalled()
  })

  it('refreshes lag data when building the dry-run preview', async () => {
    const groups = [grp()]
    const listGroups = vi.fn(async () => groups)
    const { wrapper } = mountView({ listConsumerGroups: listGroups })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    groups[0] = {
      name: 'grp-1',
      state: 'Stable',
      topics: {
        orders: [
          { partition: 0, current_offset: 50, log_end_offset: 90, lag: 40 },
          { partition: 1, current_offset: 15, log_end_offset: 15, lag: 0 },
        ],
      },
    }
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="dry-run-row"]')).toHaveLength(2)
    })
    const rows = wrapper.findAll('[data-test="dry-run-row"]')
    expect(rows[0].text()).toContain('50')
    expect(rows[0].find('[data-test="dry-run-new-offset"]').text()).toBe('90')
  })

  it('cancelling the dry-run preview clears it without resetting', async () => {
    const reset = vi.fn(async () => {})
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), resetConsumerGroupOffset: reset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="btn-cancel-preview"]').trigger('click')
    expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(false)
    expect(reset).not.toHaveBeenCalled()
  })

  it('backfills dry-run new offsets from the preview API in earliest mode', async () => {
    const previewResetOffset = vi.fn(async () => ({ 0: 0, 1: 15 }))
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), previewResetOffset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="select-reset-mode"]').setValue('earliest')
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(previewResetOffset).toHaveBeenCalled()
    })
    expect(previewResetOffset).toHaveBeenCalledWith({
      connection_id: 'c',
      group: 'grp-1',
      topic: 'orders',
      mode: 'earliest',
      timestamp_ms: undefined,
    })
    await vi.waitFor(() => {
      const rows = wrapper.findAll('[data-test="dry-run-row"]')
      expect(rows[0].find('[data-test="dry-run-new-offset"]').text()).toBe('0')
      expect(rows[1].find('[data-test="dry-run-new-offset"]').text()).toBe('15')
    })
  })

  it('backfills new offsets from the preview API in timestamp mode', async () => {
    const previewResetOffset = vi.fn(async () => ({ 0: 3 }))
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), previewResetOffset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="select-reset-mode"]').setValue('timestamp')
    await wrapper.find('[data-test="input-reset-timestamp"]').setValue('1700000000000')
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(previewResetOffset).toHaveBeenCalled()
    })
    expect(previewResetOffset).toHaveBeenCalledWith({
      connection_id: 'c',
      group: 'grp-1',
      topic: 'orders',
      mode: 'timestamp',
      timestamp_ms: 1700000000000,
    })
    const rows = wrapper.findAll('[data-test="dry-run-row"]')
    // Partition 0 was previewed; partition 1 has no entry -> stays null -> '—'.
    expect(rows[0].find('[data-test="dry-run-new-offset"]').text()).toBe('3')
    expect(rows[1].find('[data-test="dry-run-new-offset"]').text()).toBe('—')
  })

  it('does not call the preview API in latest mode', async () => {
    const previewResetOffset = vi.fn(async () => ({ 0: 99 }))
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), previewResetOffset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    // Latest is the default mode: log end offsets preview verbatim, no API call.
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(true)
    })
    expect(previewResetOffset).not.toHaveBeenCalled()
    const rows = wrapper.findAll('[data-test="dry-run-row"]')
    expect(rows[0].find('[data-test="dry-run-new-offset"]').text()).toBe('20')
    expect(rows[1].find('[data-test="dry-run-new-offset"]').text()).toBe('15')
  })

  it('degrades to null offsets when the preview API fails', async () => {
    const previewResetOffset = vi.fn(async () => {
      throw new Error('list offsets failed')
    })
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), previewResetOffset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="select-reset-mode"]').setValue('earliest')
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(previewResetOffset).toHaveBeenCalled()
    })
    // The preview still renders; a failed fetch leaves new_offset null -> '—'.
    const rows = wrapper.findAll('[data-test="dry-run-row"]')
    expect(rows[0].find('[data-test="dry-run-new-offset"]').text()).toBe('—')
    expect(rows[1].find('[data-test="dry-run-new-offset"]').text()).toBe('—')
  })

  it('clears a stale preview when the reset mode changes', async () => {
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]) })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(true)
    })
    await wrapper.find('[data-test="select-reset-mode"]').setValue('earliest')
    expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(false)
  })

  it('renders the member topology with per-topic partition assignments', async () => {
    const detail: GroupDetail = {
      group: 'grp-1',
      state: 'Stable',
      protocol_type: 'consumer',
      members: [
        { member_id: 'm-1', client_id: 'c-1', host: '/10.0.0.1', assignment: { orders: [1, 0] } },
        { member_id: 'm-2', client_id: 'c-2', host: '/10.0.0.2', assignment: { payments: [2] } },
      ],
    }
    const describeGroup = vi.fn(async () => detail)
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), describeGroup })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="member-row"]')).toHaveLength(2)
    })
    expect(describeGroup).toHaveBeenCalledWith('c', 'grp-1')
    const rows = wrapper.findAll('[data-test="member-row"]')
    expect(rows[0].find('[data-test="member-id"]').text()).toBe('m-1')
    expect(rows[0].find('[data-test="member-client-id"]').text()).toBe('c-1')
    expect(rows[0].find('[data-test="member-host"]').text()).toBe('/10.0.0.1')
    expect(rows[0].find('[data-test="member-assignment"]').text()).toBe('orders:0,1')
    expect(rows[1].find('[data-test="member-assignment"]').text()).toBe('payments:2')
    expect(wrapper.find('[data-test="members-state"]').text()).toBe('Stable')
  })

  it('shows an empty members note when the group has no members', async () => {
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]) })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="members-empty"]').exists()).toBe(true)
    })
  })

  it('does not render the members-state badge when the group has no members', async () => {
    const describeGroup = vi.fn(async () => ({
      group: 'grp-1', state: 'Stable', protocol_type: 'consumer', members: [],
    }))
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), describeGroup })
    // 等待 describeGroup 真正解析（members-empty 在加载前也会显示，不能作为就绪信号）。
    await vi.waitFor(() => {
      expect(describeGroup).toHaveBeenCalledWith('c', 'grp-1')
    })
    expect(wrapper.find('[data-test="members-empty"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="members-state"]').exists()).toBe(false)
  })

  it('renders the members-state badge when the group has active members', async () => {
    const describeGroup = vi.fn(async () => ({
      group: 'grp-1', state: 'Stable', protocol_type: 'consumer',
      members: [{ member_id: 'm-1', client_id: 'c-1', host: '/h', assignment: { orders: [0] } }],
    }))
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), describeGroup })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="members-state"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="members-state"]').text()).toBe('Stable')
  })

  it('guards against double-confirming a reset while one is in flight', async () => {
    let resolveReset!: (v: void) => void
    const reset = vi.fn(
      () =>
        new Promise<void>((res) => {
          resolveReset = res
        }),
    )
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), resetConsumerGroupOffset: reset })
    await vi.waitFor(() => {
      expect(wrapper.findAll('[data-test="lag-row"]')).toHaveLength(2)
    })
    await wrapper.find('[data-test="btn-dry-run"]').trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="dry-run-table"]').exists()).toBe(true)
    })
    // 首次确认在途时双击：第二次应被 resetting 守卫拦截，只调一次 api。
    await wrapper.find('[data-test="btn-confirm-reset"]').trigger('click')
    await wrapper.find('[data-test="btn-confirm-reset"]').trigger('click')
    resolveReset(undefined)
    await flushPromises()
    expect(reset).toHaveBeenCalledTimes(1)
  })

  it('renders the lag trend fed by the summed partition lag', async () => {
    const getPartitionLag = vi.fn(async () => ({ 0: 5, 1: 3 }))
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), getPartitionLag })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="trend-latest"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="trend-latest"]').text()).toBe('8')
    expect(getPartitionLag).toHaveBeenCalledWith('c', 'orders', 'grp-1')
  })

  it('re-fetches group data when the unified refresh request increments', async () => {
    const describe = vi.fn(async () => ({
      group: 'grp-1',
      state: 'Stable',
      protocol_type: 'consumer',
      members: [],
    }))
    const { wrapper } = mountView(
      { listConsumerGroups: vi.fn(async () => [grp()]), describeGroup: describe },
      { group: 'grp-1' },
    )
    await vi.waitFor(() => {
      expect(describe).toHaveBeenCalledTimes(1)
    })
    await wrapper.setProps({ refreshRequest: 1 })
    await vi.waitFor(() => {
      expect(describe).toHaveBeenCalledTimes(2)
    })
  })

  it('re-fetches group data when the group prop changes while mounted', async () => {
    const gA: ConsumerGroup = { name: 'grp-1', state: 'Stable', topics: { 'orders': [] } }
    const gB: ConsumerGroup = { name: 'grp-2', state: 'Stable', topics: { 'users': [] } }
    const listGroups = vi.fn(async () => [gA, gB])
    const describe = vi.fn(async () => ({ group: 'grp-1', state: 'Stable', protocol_type: 'consumer', members: [] }))
    const { wrapper } = mountView({ listConsumerGroups: listGroups, describeGroup: describe }, { group: 'grp-1' })
    await vi.waitFor(() => {
      expect(describe).toHaveBeenCalledTimes(1)
    })
    expect(listGroups).toHaveBeenCalledTimes(1)
    // Switching to another group tab patches the props in place (Layout does
    // not key its workspace), so the panel must refetch for the new group.
    await wrapper.setProps({ group: 'grp-2' })
    await vi.waitFor(() => {
      expect(listGroups).toHaveBeenCalledTimes(2)
    })
    expect(describe.mock.calls.length).toBeGreaterThan(1)
    expect(describe.mock.calls.at(-1)).toEqual(['c', 'grp-2'])
  })

  it('resets the selected group when the group prop changes after the user picked one', async () => {
    const groups: ConsumerGroup[] = [
      { name: 'grp-1', state: 'Stable', topics: { 'orders': [] } },
      { name: 'grp-2', state: 'Stable', topics: { 'users': [] } },
      { name: 'grp-3', state: 'Stable', topics: { 'payments': [] } },
    ]
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => groups) }, { group: 'grp-1' })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="field-group"] [data-test="search-select-value"]').text()).toBe('grp-1 (Stable)')
    })
    await wrapper.find('[data-test="field-group"] [data-test="search-select-trigger"]').trigger('click')
    const grp2 = wrapper.findAll('[data-test="field-group"] [data-test="search-select-option"]').find((n) => n.text().includes('grp-2'))
    expect(grp2).toBeDefined()
    await grp2!.trigger('click')
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="field-group"] [data-test="search-select-value"]').text()).toBe('grp-2 (Stable)')
    })
    // Switching to another group tab must reset the manual selection to the
    // incoming group instead of keeping the previously picked one.
    await wrapper.setProps({ group: 'grp-3' })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="field-group"] [data-test="search-select-value"]').text()).toBe('grp-3 (Stable)')
    })
  })
})

  it('renders active producers and merges consumers into the lag table', async () => {
    const listActiveProducers = vi.fn(async () => [
      { topic: 'orders', partition: 0, producer_id: 101, producer_epoch: 2, last_sequence: 9, last_timestamp: 1700000000000, leader: 1 },
    ])
    const g: ConsumerGroup = {
      name: 'grp-1',
      state: 'Stable',
      topics: {
        'orders': [
          { partition: 0, current_offset: 10, log_end_offset: 20, lag: 10, member_id: 'm-1', client_id: 'c-1', client_host: '10.0.0.1' },
        ],
      },
    }
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [g]), listActiveProducers })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="producer-row"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="producer-row"]').text()).toContain('101')
    expect(wrapper.find('[data-test="lag-member-id"]').text()).toBe('m-1')
    expect(wrapper.find('[data-test="lag-client-id"]').text()).toBe('c-1')
    expect(wrapper.find('[data-test="lag-client-host"]').text()).toBe('10.0.0.1')
    expect(listActiveProducers).toHaveBeenCalledWith({ connection_id: 'c', group: 'grp-1', topic: 'orders' })
  })

  it('shows an unsupported note in the producers panel instead of a global error', async () => {
    const listActiveProducers = vi.fn(async () => {
      throw new Error('request DescribeProducers has 3 separate shard errors, first: broker is too old')
    })
    const { wrapper } = mountView({ listConsumerGroups: vi.fn(async () => [grp()]), listActiveProducers })
    await vi.waitFor(() => {
      expect(wrapper.find('[data-test="producers-note"]').exists()).toBe(true)
    })
    expect(wrapper.find('[data-test="producers-note"]').text()).toContain('不支持')
    expect(wrapper.find('[data-test="group-error"]').exists()).toBe(false)
  })
