import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { setApi } from '@/api/client'
import type { Api } from '@/api/client'
import type { Connection } from '@/api/types'
import { useConnectionsStore } from './connections'

function fakeApi(overrides: Partial<Api> = {}): Api {
  return {
    listConnections: vi.fn(async () => []),
    createConnection: vi.fn(async (c: Connection) => c),
    deleteConnection: vi.fn(async () => {}),
    testConnection: vi.fn(async () => {}),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(async () => {}),
    getConnection: vi.fn(async () => ({}) as Connection),
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

const conn = (id: string, name = 'local'): Connection => ({
  id, name, type: 'kafka',
  config: { bootstrap_servers: ['localhost:9092'] },
  created_at: 1, updated_at: 1,
})

describe('connections store', () => {
  let api: Api
  beforeEach(() => {
    setActivePinia(createPinia())
    api = fakeApi()
    setApi(api)
  })

  it('loads connections from the api', async () => {
    ;(api.listConnections as ReturnType<typeof vi.fn>).mockResolvedValue([conn('a'), conn('b')])
    const store = useConnectionsStore()
    await store.load()
    expect(store.connections).toHaveLength(2)
    expect(store.loading).toBe(false)
  })

  it('exposes errors from load', async () => {
    ;(api.listConnections as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('boom'))
    const store = useConnectionsStore()
    await store.load()
    expect(store.error).toBe('boom')
    expect(store.connections).toHaveLength(0)
  })

  it('create appends the created connection', async () => {
    const store = useConnectionsStore()
    const created = await store.create({ name: 'new', type: 'kafka', config: { bootstrap_servers: ['h:1'] } })
    expect(created.id).toBe('')
    expect(store.connections).toHaveLength(1)
    expect(api.createConnection).toHaveBeenCalled()
  })

  it('remove filters the list and calls the api', async () => {
    ;(api.listConnections as ReturnType<typeof vi.fn>).mockResolvedValue([conn('a'), conn('b')])
    const store = useConnectionsStore()
    await store.load()
    store.setStatus('a', 'connected')
    await store.remove('a')
    expect(api.deleteConnection).toHaveBeenCalledWith('a')
    expect(store.connections.map((c) => c.id)).toEqual(['b'])
    expect(store.statusById['a']).toBeUndefined()
  })

  it('connect and disconnect delegate to the api', async () => {
    const store = useConnectionsStore()
    await store.connect('a')
    await store.disconnect('a')
    expect(api.connect).toHaveBeenCalledWith('a')
    expect(api.disconnect).toHaveBeenCalledWith('a')
  })

  it('marks a connection connecting then connected after a successful connect', async () => {
    const store = useConnectionsStore()
    const pending = store.connect('a')
    expect(store.statusById['a']).toBe('connecting')
    await pending
    expect(store.statusById['a']).toBe('connected')
  })

  it('marks a connection as error when connect fails', async () => {
    ;(api.connect as ReturnType<typeof vi.fn>).mockRejectedValue(new Error('nope'))
    const store = useConnectionsStore()
    await store.connect('a')
    expect(store.statusById['a']).toBe('error')
    expect(store.error).toBe('nope')
  })

  it('marks a connection disconnected after disconnect', async () => {
    const store = useConnectionsStore()
    await store.connect('a')
    await store.disconnect('a')
    expect(store.statusById['a']).toBe('disconnected')
  })

  it('seeds unknown statuses when connections are loaded', async () => {
    ;(api.listConnections as ReturnType<typeof vi.fn>).mockResolvedValue([conn('a'), conn('b')])
    const store = useConnectionsStore()
    await store.load()
    expect(store.statusById['a']).toBe('unknown')
    expect(store.statusById['b']).toBe('unknown')
  })

  it('testConnection delegates with the config', async () => {
    const store = useConnectionsStore()
    const cfg = { bootstrap_servers: ['localhost:9092'] }
    await store.testConnection(cfg)
    expect(api.testConnection).toHaveBeenCalledWith(cfg)
  })
})
