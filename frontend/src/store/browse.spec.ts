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
})
