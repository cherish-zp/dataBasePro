import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { ConsumerGroup } from '@/api/types'
import { useGroupsStore } from './groups'

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

const grp = (name: string): ConsumerGroup => ({ name, state: 'Stable', topics: {} })

describe('groups store', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
  })

  it('loads consumer groups and picks the first', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([grp('g1'), grp('g2')])
    const store = useGroupsStore()
    await store.load('tab1', 'conn-1')
    expect(api.listConsumerGroups).toHaveBeenCalledWith('conn-1')
    expect(store.stateFor('tab1').groups).toHaveLength(2)
    expect(store.stateFor('tab1').selectedGroup).toBe('g1')
  })

  it('loadLag stores per-partition lag', async () => {
    ;(api.getPartitionLag as ReturnType<typeof vi.fn>).mockResolvedValue({ 0: 3, 1: 5 })
    const store = useGroupsStore()
    await store.loadLag('tab1', 'conn-1', 'topic-a', 'g1')
    expect(store.stateFor('tab1').lag).toEqual({ 0: 3, 1: 5 })
    expect(api.getPartitionLag).toHaveBeenCalledWith('conn-1', 'topic-a', 'g1')
  })

  it('resetOffset calls the api with mode and reloads the groups', async () => {
    ;(api.resetConsumerGroupOffset as ReturnType<typeof vi.fn>).mockResolvedValue(undefined)
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([grp('g1')])
    const store = useGroupsStore()
    await store.resetOffset('tab1', 'conn-1', 'g1', 'topic-a', 'latest')
    expect(api.resetConsumerGroupOffset).toHaveBeenCalledWith({
      connection_id: 'conn-1', group: 'g1', topic: 'topic-a', mode: 'latest', timestamp_ms: undefined,
    })
    expect(api.listConsumerGroups).toHaveBeenCalledTimes(1)
    expect(store.stateFor('tab1').groups).toHaveLength(1)
  })

  it('resetOffset with timestamp mode passes the timestamp', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockResolvedValue([])
    const store = useGroupsStore()
    await store.resetOffset('tab1', 'conn-1', 'g1', 'topic-a', 'timestamp', 123456)
    expect(api.resetConsumerGroupOffset).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'timestamp', timestamp_ms: 123456 }),
    )
  })

  it('records errors and clears state', async () => {
    ;(api.listConsumerGroups as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('denied'))
    const store = useGroupsStore()
    await store.load('tab1', 'conn-1')
    expect(store.stateFor('tab1').error).toBe('denied')
    store.clear('tab1')
    expect(store.stateFor('tab1').groups).toHaveLength(0)
  })

  it('loadActiveProducers fetches producers for the topic', async () => {
    const listActiveProducers = vi.fn(async () => [
      { topic: 't1', partition: 0, producer_id: 101, producer_epoch: 2, last_sequence: 9, last_timestamp: 1700000000000, leader: 1 },
    ])
    setApi(fakeApi({ listActiveProducers }))
    const store = useGroupsStore()
    await store.loadActiveProducers('tab1', 'conn-1', 'g1', 't1')
    expect(listActiveProducers).toHaveBeenCalledWith({ connection_id: 'conn-1', group: 'g1', topic: 't1' })
    expect(store.stateFor('tab1').producers).toHaveLength(1)
  })

  it('loadActiveProducers clears the list when group or topic is missing', async () => {
    const store = useGroupsStore()
    store.stateFor('tab1').producers = [{ topic: 't1', partition: 0, producer_id: 1, producer_epoch: 0, last_sequence: 0, last_timestamp: 0, leader: 0 }]
    await store.loadActiveProducers('tab1', 'conn-1', '', '')
    expect(store.stateFor('tab1').producers).toHaveLength(0)
  })

  it('loadActiveProducers degrades gracefully when the broker does not support the query', async () => {
    const listActiveProducers = vi.fn(async () => {
      throw new Error('describe producers for topic "t1": request DescribeProducers has 3 separate shard errors, first: broker is too old; the broker has already indicated it will not know how to handle the request')
    })
    setApi(fakeApi({ listActiveProducers }))
    const store = useGroupsStore()
    await store.loadActiveProducers('tab1', 'conn-1', 'g1', 't1')
    expect(store.stateFor('tab1').producers).toHaveLength(0)
    expect(store.stateFor('tab1').producersNote).toContain('不支持')
    expect(store.stateFor('tab1').error).toBeNull()
  })
})
