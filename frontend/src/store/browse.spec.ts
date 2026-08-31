import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Message } from '@/api/types'
import { OffsetEarliest, OffsetLatest } from '@/api/types'
import { useBrowseStore } from './browse'

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
    listAudit: vi.fn(async () => []),
    createTopic: vi.fn(async () => {}),
    deleteTopic: vi.fn(async () => {}),
    deleteTopics: vi.fn(async () => []),
    deleteConsumerGroup: vi.fn(async () => {}),
    produceMessage: vi.fn(async () => {}),
    produceMessages: vi.fn(async () => []),
    ...overrides,
  }
}

const msg = (offset: number, partition = 0): Message => ({
  partition, offset, timestamp: 1, key: `k${offset}`, value: `v${offset}`, headers: [],
})

describe('browse store', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
  })

  it('fetches messages and stores them per tab', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(0), msg(1), msg(2)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, limit: 500 })
    const st = store.stateFor('t1')
    expect(st.messages).toHaveLength(3)
    expect(st.lastOffset).toBe(2)
    expect(st.query.partition).toBe(0)
    expect(api.consumeMessages).toHaveBeenCalledWith(
      expect.objectContaining({ connection_id: 'c', topic: 'topic-a', partition: 0, offset: OffsetEarliest, limit: 500 }),
    )
  })

  it('uses timestamp mode when timestampMs is set', async () => {
    ;(api.consumeMessagesByTimestamp as ReturnType<typeof vi.fn>).mockResolvedValue([msg(5)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, timestampMs: 12345, limit: 10 })
    expect(api.consumeMessagesByTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp_ms: 12345, offset: OffsetEarliest }),
    )
    expect(store.stateFor('t1').messages).toHaveLength(1)
  })

  it('queries by time range and keeps messages before the end time', async () => {
    const early = { ...msg(0), timestamp: 1700000000000 }
    const middle = { ...msg(1), timestamp: 1700000005000 }
    const late = { ...msg(2), timestamp: 1700000010000 }
    ;(api.consumeMessagesByTimestamp as ReturnType<typeof vi.fn>).mockResolvedValue([early, middle, late])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: 1700000000000, endTimeMs: 1700000006000, limit: 10 })
    expect(api.consumeMessagesByTimestamp).toHaveBeenCalledWith(
      expect.objectContaining({ timestamp_ms: 1700000000000 }),
    )
    expect(store.stateFor('t1').messages.map((m) => m.offset)).toEqual([0, 1])
  })

  it('includes a message whose timestamp exactly equals the end time', async () => {
    const at = { ...msg(0), timestamp: 1700000006000 }
    ;(api.consumeMessagesByTimestamp as ReturnType<typeof vi.fn>).mockResolvedValue([at])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: 1700000000000, endTimeMs: 1700000006000, limit: 10 })
    expect(store.stateFor('t1').messages).toHaveLength(1)
  })

  it('excludes a message whose timestamp is one millisecond past the end time', async () => {
    const justPast = { ...msg(0), timestamp: 1700000006001 }
    ;(api.consumeMessagesByTimestamp as ReturnType<typeof vi.fn>).mockResolvedValue([justPast])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: 1700000000000, endTimeMs: 1700000006000, limit: 10 })
    expect(store.stateFor('t1').messages).toHaveLength(0)
  })

  it('keeps all messages when the time range has only a start', async () => {
    const early = { ...msg(0), timestamp: 1000 }
    const late = { ...msg(1), timestamp: 9000000000000 }
    ;(api.consumeMessagesByTimestamp as ReturnType<typeof vi.fn>).mockResolvedValue([early, late])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: 500, endTimeMs: null, limit: 10 })
    expect(store.stateFor('t1').messages).toHaveLength(2)
  })

  it('falls back to the offset query when no time range is given', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(0)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: null, endTimeMs: null, limit: 10 })
    expect(api.consumeMessages).toHaveBeenCalled()
    expect(api.consumeMessagesByTimestamp).not.toHaveBeenCalled()
  })

  it('restores the plain offset query and drops the cutoff when the range is cleared', async () => {
    const late = { ...msg(9), timestamp: 9000000000000 }
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([late])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: 1000, endTimeMs: 2000, limit: 10 })
    expect(store.stateFor('t1').messages).toHaveLength(0)

    await store.fetch('t1', 'c', 'topic-a', { timestampMs: null, endTimeMs: null })
    expect(api.consumeMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ connection_id: 'c', topic: 'topic-a', partition: 0 }),
    )
    expect(store.stateFor('t1').messages).toHaveLength(1)
  })

  it('marks hasMore only for single-partition queries that hit the limit', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(0), msg(1), msg(2)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, limit: 3 })
    expect(store.stateFor('t1').hasMore).toBe(true)

    await store.fetch('t2', 'c', 'topic-a', { partition: -1, offset: OffsetEarliest, limit: 3 })
    expect(store.stateFor('t2').hasMore).toBe(false)
  })

  it('fetchMore appends the next page without duplicates', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([msg(0), msg(1)])
      .mockResolvedValueOnce([msg(2), msg(3)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, limit: 2 })
    await store.fetchMore('t1', 'c', 'topic-a')
    expect(store.stateFor('t1').messages.map((m) => m.offset)).toEqual([0, 1, 2, 3])
    expect(api.consumeMessages).toHaveBeenLastCalledWith(expect.objectContaining({ offset: 2 }))
  })

  it('fetchMore is a no-op for all-partition or timestamp queries', async () => {
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: -1, offset: OffsetEarliest, limit: 10 })
    await store.fetchMore('t1', 'c', 'topic-a')
    expect(api.consumeMessages).toHaveBeenCalledTimes(1)
  })

  it('select stores the highlighted message and clear drops state', async () => {
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, limit: 10 })
    store.select('t1', msg(7))
    expect(store.stateFor('t1').selected?.offset).toBe(7)
    store.clear('t1')
    expect(store.stateFor('t1').messages).toHaveLength(0)
  })

  it('records fetch errors', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('no broker'))
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetLatest, limit: 10 })
    expect(store.stateFor('t1').error).toBe('no broker')
  })

  it('has no jump target for a plain offset query', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(0)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, limit: 10 })
    expect(store.stateFor('t1').target).toBeNull()
    expect(store.targetKey('t1')).toBeNull()
  })

  it('jumpToOffset fetches from the entered offset via the offset path and records the target', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(42), msg(43)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: 1000, endTimeMs: 2000, limit: 10 })
    expect(api.consumeMessagesByTimestamp).toHaveBeenCalledTimes(1)
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(api.consumeMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ connection_id: 'c', topic: 'topic-a', partition: 0, offset: 42, limit: 10 }),
    )
    // The jump always reuses the offset query path, dropping the time range.
    expect(api.consumeMessagesByTimestamp).toHaveBeenCalledTimes(1)
    expect(store.stateFor('t1').target).toEqual({ offset: 42 })
  })

  it('jumpToOffset merges the given partition and limit from the filter bar', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(42)])
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42, { partition: 1, limit: 5 })
    expect(api.consumeMessages).toHaveBeenLastCalledWith(
      expect.objectContaining({ partition: 1, offset: 42, limit: 5 }),
    )
  })

  it('positions the target at the record matching the jumped offset', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(40), msg(42), msg(44)])
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.targetKey('t1')).toBe('0:42')
  })

  it('falls back to the first record when the jumped offset has no exact match', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(45), msg(46)])
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.targetKey('t1')).toBe('0:45')
  })

  it('resolves to no row when the jump returns no messages', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.stateFor('t1').target).toEqual({ offset: 42 })
    expect(store.targetKey('t1')).toBeNull()
  })

  it('clears the target when a query not initiated by a jump runs', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(42)])
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.targetKey('t1')).toBe('0:42')
    await store.fetch('t1', 'c', 'topic-a', { offset: OffsetEarliest })
    expect(store.stateFor('t1').target).toBeNull()
    expect(store.targetKey('t1')).toBeNull()
  })

  it('targets the first record of a time-query result', async () => {
    const first = { ...msg(3), timestamp: 1700000000000 }
    const second = { ...msg(8), timestamp: 1700000005000 }
    ;(api.consumeMessagesByTimestamp as ReturnType<typeof vi.fn>).mockResolvedValue([first, second])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, timestampMs: 1700000000000, endTimeMs: null, limit: 10 })
    expect(store.targetKey('t1')).toBe('0:3')
  })

  it('keeps the target across fetchMore appends', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce([msg(0)]) // initial plain fetch
      .mockResolvedValueOnce([msg(42), msg(43)]) // jump fetch
      .mockResolvedValueOnce([msg(44)]) // fetchMore append
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, limit: 2 })
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    await store.fetchMore('t1', 'c', 'topic-a')
    expect(store.stateFor('t1').target).toEqual({ offset: 42 })
    expect(store.stateFor('t1').messages.map((m) => m.offset)).toEqual([42, 43, 44])
    expect(store.targetKey('t1')).toBe('0:42')
  })

  it('bumps the scroll request on every successful jump, even for the same offset', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(42)])
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.stateFor('t1').scrollRequest).toBe(1)
    // Re-jumping the same offset still signals consumers to re-scroll, because
    // the resolved target key is unchanged and would otherwise not retrigger.
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.stateFor('t1').scrollRequest).toBe(2)
  })

  it('does not bump the scroll request for a plain query', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockResolvedValue([msg(0)])
    const store = useBrowseStore()
    await store.fetch('t1', 'c', 'topic-a', { partition: 0, offset: OffsetEarliest, limit: 10 })
    expect(store.stateFor('t1').scrollRequest).toBe(0)
  })

  it('keeps the previous jump target when a later jump fetch fails', async () => {
    const consume = api.consumeMessages as ReturnType<typeof vi.fn>
    consume.mockResolvedValue([msg(42)])
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.stateFor('t1').target).toEqual({ offset: 42 })
    consume.mockRejectedValueOnce(new Error('broker down'))
    await store.jumpToOffset('t1', 'c', 'topic-a', 7)
    // A failed jump must not move or clear the highlight.
    expect(store.stateFor('t1').target).toEqual({ offset: 42 })
    expect(store.stateFor('t1').scrollRequest).toBe(1)
  })

  it('leaves the target null and no scroll signal when the very first jump fails', async () => {
    ;(api.consumeMessages as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('broker down'))
    const store = useBrowseStore()
    await store.jumpToOffset('t1', 'c', 'topic-a', 42)
    expect(store.stateFor('t1').target).toBeNull()
    expect(store.stateFor('t1').scrollRequest).toBe(0)
    expect(store.stateFor('t1').error).toBe('broker down')
  })
})
