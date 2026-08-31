import { beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { ConsumerGroup } from '@/api/types'
import ResetOffsetDialog from './ResetOffsetDialog.vue'

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
    alterTopicConfig: vi.fn(async () => {}),
    alterTopicPartitions: vi.fn(async () => {}),
    getTopicMessageCounts: vi.fn(async () => ({})),
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
    previewResetOffset: vi.fn(async () => ({})),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    listAudit: vi.fn(async () => []),
    saveTextFile: vi.fn(async () => ''),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    ...overrides,
  }
}

const groups = (): ConsumerGroup[] => [
  {
    name: 'grp-1',
    state: 'Empty',
    topics: {
      'user-log': [
        { partition: 0, current_offset: 100500, log_end_offset: 101000, lag: 500 },
        { partition: 1, current_offset: 98211, log_end_offset: 98211, lag: 0 },
      ],
    },
  },
  { name: 'grp-idle', state: 'Stable', topics: {} },
]

// Teleported to <body> like every modal in this app.
function el(testId: string): HTMLElement | null {
  return document.body.querySelector(`[data-test="${testId}"]`)
}
function els(testId: string): HTMLElement[] {
  return Array.from(document.body.querySelectorAll(`[data-test="${testId}"]`))
}
function click(testId: string): void {
  el(testId)?.dispatchEvent(new MouseEvent('click', { bubbles: true }))
}

describe('ResetOffsetDialog', () => {
  let api: Api
  beforeEach(() => {
    api = fakeApi()
    setApi(api)
  })

  it('loads the connection groups on open and shows their state', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue(groups())
    const wrapper = mount(ResetOffsetDialog, {
      props: { show: true, connectionId: 'a', topic: 'user-log' },
    })
    await flushPromises()
    expect(api.listConsumerGroups).toHaveBeenCalledWith('a')
    // Options list both groups with their states.
    const options = els('reset-group-option').map((o) => o.textContent)
    expect(options.some((t) => t?.includes('grp-1'))).toBe(true)
    expect(options.some((t) => t?.includes('Empty'))).toBe(true)
    void wrapper
  })

  it('warns when the selected group is Stable', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([
      { name: 'grp-live', state: 'Stable', topics: { 'user-log': [] } },
    ])
    mount(ResetOffsetDialog, {
      props: { show: true, connectionId: 'a', topic: 'user-log', group: 'grp-live' },
    })
    await flushPromises()
    expect(el('reset-stable-warning')?.textContent).toContain('停止消费者')
  })

  it('previews a latest reset with log-end targets from the lag data', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue(groups())
    mount(ResetOffsetDialog, {
      props: { show: true, connectionId: 'a', topic: 'user-log', group: 'grp-1' },
    })
    await flushPromises()
    click('btn-reset-dry-run')
    await flushPromises()
    const targets = els('reset-row-target').map((c) => c.textContent)
    expect(targets).toEqual(['101000', '98211'])
  })

  it('commits an explicit offset reset with the edited per-partition targets', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue(groups())
    const reset = (api.resetConsumerGroupOffset as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    const wrapper = mount(ResetOffsetDialog, {
      props: { show: true, connectionId: 'a', topic: 'user-log', group: 'grp-1' },
    })
    await flushPromises()
    // Choose the 指定 Offset mode.
    const modeSelect = el('select-reset-mode') as HTMLSelectElement
    modeSelect.value = 'offset'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    click('btn-reset-dry-run')
    await flushPromises()
    // Targets are prefilled with the current offsets and are editable.
    const input = el('reset-row-input-0') as HTMLInputElement
    expect(input.value).toBe('100500')
    input.value = '0'
    input.dispatchEvent(new Event('input', { bubbles: true }))
    click('btn-reset-confirm')
    await flushPromises()
    expect(reset).toHaveBeenCalledWith({
      connection_id: 'a',
      group: 'grp-1',
      topic: 'user-log',
      mode: 'offset',
      per_partition_offsets: { 0: 0, 1: 98211 },
    })
    expect(wrapper.emitted('close')).toHaveLength(1)
  })

  it('rewind mode computes per-partition targets of current - N clamped to the start offset', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue(groups())
    // Start offsets come from the earliest preview.
    ;(api.previewResetOffset as ReturnType<typeof vi.fn>).mockResolvedValue({ 0: 100000, 1: 0 })
    mount(ResetOffsetDialog, {
      props: { show: true, connectionId: 'a', topic: 'user-log', group: 'grp-1' },
    })
    await flushPromises()
    const modeSelect = el('select-reset-mode') as HTMLSelectElement
    modeSelect.value = 'rewind'
    modeSelect.dispatchEvent(new Event('change', { bubbles: true }))
    await flushPromises()
    const nInput = el('input-rewind-n') as HTMLInputElement
    nInput.value = '1000'
    nInput.dispatchEvent(new Event('input', { bubbles: true }))
    click('btn-reset-dry-run')
    await flushPromises()
    // Partition 0: 100500-1000=99500 (>= start 100000 -> clamped 100000).
    // Partition 1: 98211-1000=97211.
    const targets = els('reset-row-target').map((c) => c.textContent)
    expect(targets).toEqual(['100000', '97211'])
  })

  it('emits close without calling the api when cancelled', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue(groups())
    const wrapper = mount(ResetOffsetDialog, {
      props: { show: true, connectionId: 'a', topic: 'user-log', group: 'grp-1' },
    })
    await flushPromises()
    click('btn-reset-cancel')
    await flushPromises()
    expect(wrapper.emitted('close')).toHaveLength(1)
    expect(api.resetConsumerGroupOffset).not.toHaveBeenCalled()
  })
})
